import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, readFile, realpath, rm, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { RESTIC_LOCK_WAIT, type ResticArchives } from './restic.js';
import type { ArchiveContentContract, ArchiveFileContent, ArchiveFileEntry, ArchiveFileInfo, ArchiveListing, ArchiveRestoreTarget, ArchiveVersionDetails } from './contract.js';
import type { ArchiveArtifact, ArchiveSource, ArchiveVersion } from './types.js';
import { ARCHIVE_FORMAT } from './formats.js';
import type { ArchiveCommand, ArchiveCommandInput, ArchiveDriver, ArchiveReference } from './driver.js';

const MAX_FILE_BYTES = 512 * 1024;
function validateBackupIgnore(ignore: string): string {
  if (!/^(workspace|codex)\/[\w.\/-]+\/?$/.test(ignore)
    || ignore.split('/').some(part => part === '.' || part === '..') || ignore.includes('//')) {
    throw new Error('Invalid backup ignore pattern');
  }
  return ignore.replace(/\/$/, '');
}
const commandEnvironment = () => {
  const environment = { ...process.env };
  delete environment.RESTIC_PASSWORD;
  delete environment.RESTIC_PASSWORD_COMMAND;
  return environment;
};

/** Accept only normalized archive-relative paths. */
export function validateArchivePath(path: string): string | null {
  if (!path) return '';
  if (path.includes('\\') || path.includes('\0') || path.startsWith('/')) return null;
  const parts = path.replace(/\/+$/, '').split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) return null;
  return parts.join('/');
}

function spawnText(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], env: commandEnvironment() });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(stdout) : reject(new Error(stderr || `${command} exited ${code}`)));
  });
}

export function spawnCapped(command: string, args: string[], limit: number): Promise<{ content: Buffer; truncated: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], env: commandEnvironment() });
    const chunks: Buffer[] = [];
    let size = 0, stderr = '', truncated = false;
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.stdout.on('data', (d: Buffer) => {
      if (truncated) return;
      const remaining = limit + 1 - size;
      const chunk = d.length > remaining ? d.subarray(0, remaining) : d;
      chunks.push(chunk);
      size += chunk.length;
      if (size > limit) {
        truncated = true;
        child.kill('SIGTERM');
      }
    });
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0 && !truncated) return reject(new Error(stderr || `${command} exited ${code}`));
      const content = Buffer.concat(chunks).subarray(0, limit);
      resolve({ content, truncated: truncated || size > limit });
    });
  });
}

function resticArgs(restic: ResticArchives, repositoryId: string, commandArgs: string[]): string[] {
  if (!/^[a-f0-9-]{36}$/i.test(repositoryId)) throw new Error('Invalid Restic repository ID');
  return [restic.binary, '-r', restic.repository(repositoryId), '--password-file', restic.passwordFile, ...commandArgs];
}

export async function listResticFiles(restic: ResticArchives, snapshotId: string, repositoryId: string, path: string): Promise<ArchiveFileEntry[]> {
  const validated = validateArchivePath(path);
  if (validated === null) throw new Error('无效的文件路径');
  if (!/^[a-f0-9]{64}$/i.test(snapshotId)) throw new Error('Invalid Restic snapshot ID');
  const args = resticArgs(restic, repositoryId, ['ls', '--json', snapshotId, ...(validated ? [`/${validated}`] : [])]);
  const output = await spawnText(args[0], args.slice(1));
  const entries: ArchiveFileEntry[] = [];
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const item = JSON.parse(line) as { name?: string; path?: string; type?: string; size?: number; mtime?: string; struct_type?: string };
    if (item.struct_type && item.struct_type !== 'node') continue;
    const rawName = item.path ?? item.name;
    if (!rawName) continue;
    const name = rawName.replace(/^\//, '').replace(/\/$/, '');
    if (!name || validateArchivePath(name) === null) continue;
    const type = item.type === 'dir' || item.type === 'directory' ? 'directory' : 'file';
    entries.push({ name, type, size: type === 'directory' ? 0 : Number(item.size ?? 0), ...(item.mtime ? { mtime: item.mtime } : {}) });
  }
  return entries;
}

export async function readResticFile(restic: ResticArchives, snapshotId: string, repositoryId: string, filePath: string): Promise<ArchiveFileContent> {
  const validated = validateArchivePath(filePath);
  if (!validated) throw new Error('无效的文件路径');
  if (!/^[a-f0-9]{64}$/i.test(snapshotId)) throw new Error('Invalid Restic snapshot ID');
  const args = resticArgs(restic, repositoryId, ['dump', snapshotId, `/${validated}`]);
  const { content, truncated } = await spawnCapped(args[0], args.slice(1), MAX_FILE_BYTES);
  return { content: content.toString('utf8'), truncated, ...(truncated ? {} : { totalSize: content.length }) };
}

/**
 * 解析 tar -tvzf 输出的行格式：
 * -rw-r--r-- 1000/1000      128 2026-09-14 11:25 home/user/workspace/.gitignore
 * drwxr-xr-x 0/0               0 2026-09-14 11:26 home/user/workspace/
 */
function parseTarLine(line: string): { name: string; type: 'file' | 'directory'; size: number; mtime?: string } | null {
  // tar verbose output: permission owner/group size date time name
  const re = /^(\S+)\s+\S+\s+(\d+)\s+(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})\s+(.+)$/;
  const m = line.match(re);
  if (!m) return null;
  const isDir = m[1].startsWith('d');
  const size = Number(m[2]);
  const mtime = `${m[3]}T${m[4]}:00`;
  let name = m[5].replace(/\/$/, '');
  return { name, type: isDir ? 'directory' : 'file', size: isDir ? 0 : size, mtime };
}

export function listTarFiles(archivePath: string): Promise<ArchiveListing> {
  return new Promise((resolve, reject) => {
    const child = spawn('tar', ['-tvzf', archivePath], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('close', code => {
      if (code !== 0) return reject(new Error(stderr || `tar exited ${code}`));
      const entries: ArchiveFileEntry[] = [];
      const dirs = new Set<string>();
      for (const line of stdout.trim().split('\n')) {
        if (!line) continue;
        const parsed = parseTarLine(line);
        if (!parsed) continue;
        const { name, type, size, mtime } = parsed;
        if (type === 'directory') { dirs.add(name); entries.push({ name, type: 'directory', size: 0, mtime }); }
        else {
          const parts = name.split('/');
          for (let i = 1; i < parts.length; i++) {
            const parent = parts.slice(0, i).join('/');
            if (!dirs.has(parent)) { dirs.add(parent); entries.push({ name: parent, type: 'directory', size: 0 }); }
          }
          entries.push({ name, type: 'file', size, mtime });
        }
      }
      let rootPrefix = '';
      if (entries.length > 0) {
        for (;;) {
          const root = entries.filter(e => !e.name.includes('/'));
          const dirs = root.filter(e => e.type === 'directory');
          const files = root.filter(e => e.type === 'file');
          if (files.length > 0 || dirs.length !== 1) break;
          const singleton = dirs[0].name + '/';
          rootPrefix += singleton;
          for (const f of entries) {
            if (f.name.startsWith(singleton)) f.name = f.name.slice(singleton.length);
          }
          for (let i = entries.length - 1; i >= 0; i--) {
            if (entries[i].name === '' || entries[i].name === dirs[0].name) entries.splice(i, 1);
          }
        }
      }
      resolve({ entries, rootPrefix });
    });
  });
}

function fileOf<T extends { format: string }>(value: T): Extract<T, { format: typeof ARCHIVE_FORMAT.file }> {
  if (value.format !== ARCHIVE_FORMAT.file) throw new Error('Archive driver mismatch');
  return value as Extract<T, { format: typeof ARCHIVE_FORMAT.file }>;
}

function revisionOf<T extends { format: string }>(value: T): Extract<T, { format: typeof ARCHIVE_FORMAT.snapshot }> {
  if (value.format !== ARCHIVE_FORMAT.snapshot) throw new Error('Archive driver mismatch');
  return value as Extract<T, { format: typeof ARCHIVE_FORMAT.snapshot }>;
}

export class FileDriver implements ArchiveDriver {
  readonly format = ARCHIVE_FORMAT.file;
  constructor(private readonly directory?: string) {}

  relativePath({ storeId, revisionId }: ArchiveReference): string {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(revisionId)) {
      throw new Error('Invalid file archive version ID');
    }
    return join(createHash('sha256').update(storeId).digest('hex'), `${revisionId}.tar.gz`);
  }

  storagePath(reference: ArchiveReference): string {
    if (!this.directory) throw new Error('File archive directory is not configured');
    return join(this.directory, this.relativePath(reference));
  }

  async getCmd(input: ArchiveCommandInput): Promise<ArchiveCommand> {
    if (!isAbsolute(input.sourceRoot) || !isAbsolute(input.storagePath)) throw new Error('Archive command paths must be absolute');
    return { executable: 'sh', cwd: input.sourceRoot,
      args: ['-eu', '-c',
        'destination=$1; shift; mkdir -p -- "$(dirname -- "$destination")"; trap \'rm -f "$destination.partial"\' EXIT; tar -czf "$destination.partial" --transform="s|^workspace|home/user/workspace|;s|^codex|home/user/.codex|" "$@" workspace codex; mv "$destination.partial" "$destination"',
        'archive', input.storagePath, ...input.ignores.map(ignore => `--exclude=${validateBackupIgnore(ignore)}`)] };
  }

  async initialize(): Promise<void> {}

  async prepare(_storeId: string, _sourceRoot: string): Promise<void> {}

  /** Compatibility path for callers that still provide their own file writer. */
  async create(input: ArchiveReference & { write: (path: string) => Promise<ArchiveFileInfo> }):
    Promise<ArchiveFileInfo & { storagePath: string }> {
    const storagePath = this.storagePath(input);
    await mkdir(dirname(storagePath), { recursive: true, mode: 0o700 });
    const file = await input.write(storagePath);
    return { storagePath, ...file };
  }

  async remove(items: readonly ArchiveReference[]): Promise<void> {
    for (const item of items) await rm(this.storagePath(item), { force: true });
  }

  /** Retired legacy versions may have a stored path outside the current naming scheme. */
  async removeStored(storagePath: string): Promise<void> {
    if (!this.directory || !isAbsolute(storagePath) || !storagePath.endsWith('.tar.gz')) {
      throw new Error('Invalid stored file archive path');
    }
    let file;
    try { file = await lstat(storagePath); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    if (!file.isFile() || file.isSymbolicLink()) throw new Error('Stored file archive is not a regular file');
    const root = await realpath(this.directory);
    const parent = await realpath(dirname(storagePath));
    const child = relative(root, parent);
    if (child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) {
      throw new Error('Stored file archive is outside the archive directory');
    }
    await rm(storagePath);
  }

  async unrecordedVersions(_referenced: Set<string>): Promise<ArchiveReference[]> { return []; }

  async inspect(storagePath: string): Promise<ArchiveFileInfo> {
    const file = await stat(storagePath);
    if (!file.isFile() || !file.size) throw new Error('File archive is empty or missing');
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(storagePath)) hash.update(chunk);
    return { sizeBytes: file.size, sha256: hash.digest('hex') };
  }

  async validate(archive: ArchiveArtifact): Promise<void> {
    const value = fileOf(archive);
    const file = await stat(value.storagePath);
    if (!file.isFile() || !file.size || file.size !== value.sizeBytes) throw new Error('Tar archive size does not match');
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(value.storagePath)) hash.update(chunk);
    if (hash.digest('hex') !== value.sha256) throw new Error('Tar archive checksum does not match');
  }

  listFiles(source: ArchiveSource): Promise<ArchiveListing> { return listTarFiles(fileOf(source).storagePath); }

  async readFile(source: ArchiveSource, path: string): Promise<ArchiveFileContent> {
    const { storagePath } = fileOf(source);
    const normalized = validateArchivePath(path);
    if (!normalized) throw new Error('无效的文件路径');
    const { rootPrefix } = await listTarFiles(storagePath);
    const { content, truncated } = await spawnCapped('tar', ['-xzf', storagePath, '-O', '--', rootPrefix + normalized], MAX_FILE_BYTES);
    return { content: content.toString('utf8'), truncated, ...(truncated ? {} : { totalSize: content.length }) };
  }

  async restore(archive: ArchiveArtifact, target: ArchiveRestoreTarget): Promise<void> {
    const value = fileOf(archive);
    await this.validate(value);
    await target.restoreFromFile(value.storagePath);
  }

  describe(version: ArchiveVersion): ArchiveVersionDetails {
    const value = fileOf(version);
    return { id: value.id, version: value.version, createdAt: value.createdAt,
      sizeBytes: value.sizeBytes, checksum: value.sha256, label: value.sha256.slice(0, 8),
      isLatest: value.isLatest, metadata: value.metadata };
  }
}

export class RevisionDriver implements ArchiveDriver {
  readonly format = ARCHIVE_FORMAT.snapshot;
  constructor(private readonly storage: ResticArchives) {}

  async getCmd(input: ArchiveCommandInput): Promise<ArchiveCommand> {
    if (!isAbsolute(input.sourceRoot) || !isAbsolute(input.storagePath)) throw new Error('Archive command paths must be absolute');
    await this.storage.ready();
    await this.storage.ensureRepository(input.storeId);
    const password = (await readFile(this.storage.passwordFile, 'utf8')).trim();
    const args = ['backup', '--retry-lock', RESTIC_LOCK_WAIT, '--json', '--group-by', 'host', '--tag', `project:${input.storeId}`,
      '--tag', `sandbox:${input.sandboxId}`];
    for (const ignore of input.ignores) args.push(`--exclude=${join(input.sourceRoot, validateBackupIgnore(ignore))}`);
    args.push('workspace', 'codex');
    return { executable: 'restic', args, cwd: input.sourceRoot,
      env: { RESTIC_REPOSITORY: input.storagePath, RESTIC_PASSWORD: password } };
  }

  parseCommandResult(stdout: string): { snapshotId: string; logicalSizeBytes: number; bytesAdded: number } {
    const summary = stdout.split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>)
      .filter(line => line.message_type === 'summary').at(-1);
    const snapshotId = summary?.snapshot_id;
    const logicalSizeBytes = Number(summary?.total_bytes_processed ?? 0);
    const bytesAdded = Number(summary?.data_added ?? 0);
    if (typeof snapshotId !== 'string' || !/^[a-f0-9]{64}$/i.test(snapshotId)
      || !Number.isSafeInteger(logicalSizeBytes) || logicalSizeBytes < 0
      || !Number.isSafeInteger(bytesAdded) || bytesAdded < 0) {
      throw new Error('Revision backup did not return a valid summary');
    }
    return { snapshotId, logicalSizeBytes, bytesAdded };
  }

  async initialize(): Promise<void> { await this.storage.ready(); }

  async prepare(storeId: string, sourceRoot: string): Promise<void> {
    await this.storage.ready();
    await this.storage.assertSpace(storeId, sourceRoot);
  }

  /** Compatibility path for callers that still request a host-side snapshot. */
  async create(input: { storeId: string; sandboxId: string; sourceRoot: string; ignores: string[] }) {
    const result = await this.storage.snapshot(input.storeId, input.sandboxId, input.sourceRoot, input.ignores);
    return { location: { storeId: result.repositoryId, revisionId: result.snapshotId },
      logicalSizeBytes: result.logicalSizeBytes, bytesAdded: result.addedBytes,
      storageSizeBytes: result.repositorySizeBytes, durationMs: result.durationMs, engineVersion: result.version };
  }

  async remove(items: readonly { storeId: string; revisionId: string }[]): Promise<void> {
    const repositories = new Map<string, string[]>();
    for (const item of items) {
      const revisions = repositories.get(item.storeId) ?? [];
      revisions.push(item.revisionId);
      repositories.set(item.storeId, revisions);
    }
    for (const [storeId, items] of repositories) {
      await this.storage.withRepositoryLock(storeId, async () => {
        for (const revisionId of items) await this.storage.forget(storeId, revisionId);
        await this.storage.prune(storeId);
      });
    }
  }

  async unrecordedVersions(referenced: Set<string>): Promise<Array<{ storeId: string; revisionId: string }>> {
    const orphans: Array<{ storeId: string; revisionId: string }> = [];
    for (const storeId of await this.storage.listRepositories()) {
      for (const revisionId of await this.storage.listSnapshots(storeId)) {
        if (!referenced.has(`${storeId}/${revisionId}`)) orphans.push({ storeId, revisionId });
      }
    }
    return orphans;
  }

  async validate(archive: ArchiveArtifact): Promise<void> {
    const value = revisionOf(archive);
    await this.storage.verify(value.repositoryId, value.snapshotId);
  }

  async listFiles(source: ArchiveSource, path: string): Promise<ArchiveListing> {
    const value = revisionOf(source);
    return { entries: await listResticFiles(this.storage, value.snapshotId, value.repositoryId, path), rootPrefix: '' };
  }

  readFile(source: ArchiveSource, path: string): Promise<ArchiveFileContent> {
    const value = revisionOf(source);
    return readResticFile(this.storage, value.snapshotId, value.repositoryId, path);
  }

  async restore(archive: ArchiveArtifact, target: ArchiveRestoreTarget): Promise<void> {
    const value = revisionOf(archive);
    await this.validate(value);
    await target.restoreIntoDirectory(directory => this.storage.restore(value.repositoryId, value.snapshotId, directory));
  }

  describe(version: ArchiveVersion): ArchiveVersionDetails {
    const value = revisionOf(version);
    return { id: value.id, version: value.version, createdAt: value.createdAt,
      sizeBytes: value.logicalSizeBytes, bytesAdded: value.bytesAdded, revisionId: value.snapshotId,
      label: value.snapshotId.slice(0, 8),
      isLatest: value.isLatest, metadata: value.metadata };
  }
}

/** The package facade selects a driver; callers never branch on stored formats. */
export class ArchiveContentService implements ArchiveContentContract {
  protected readonly file: FileDriver;
  private readonly drivers = new Map<ArchiveArtifact['format'], ArchiveDriver>();
  constructor(protected readonly revision?: RevisionDriver, directory?: string) {
    this.file = new FileDriver(directory);
    this.drivers.set(this.file.format, this.file);
    if (revision) this.drivers.set(revision.format, revision);
  }

  private driver(format: ArchiveArtifact['format']): ArchiveDriver {
    const driver = this.drivers.get(format);
    if (!driver) throw new Error(`Archive format ${format} is unavailable`);
    return driver;
  }

  normalizePath(path: string): string | null { return validateArchivePath(path); }

  sourceFromFile(storagePath: string): ArchiveSource { return { format: ARCHIVE_FORMAT.file, storagePath }; }

  artifactFromFile(input: { storagePath: string; sizeBytes: number; sha256: string; createdAt: string;
    metadata?: Record<string, unknown> }): Extract<ArchiveArtifact, { storagePath: string }> {
    return { ...input, format: ARCHIVE_FORMAT.file };
  }

  artifactFromRevision(input: { location: { storeId: string; revisionId: string }; logicalSizeBytes: number;
    bytesAdded: number; createdAt: string; metadata?: Record<string, unknown> }): Extract<ArchiveArtifact, { repositoryId: string }> {
    return { format: ARCHIVE_FORMAT.snapshot, repositoryId: input.location.storeId,
      snapshotId: input.location.revisionId, logicalSizeBytes: input.logicalSizeBytes,
      bytesAdded: input.bytesAdded, createdAt: input.createdAt, metadata: input.metadata };
  }

  async validate(archive: ArchiveArtifact): Promise<void> {
    await this.driver(archive.format).validate(archive);
  }

  async listFiles(archive: ArchiveSource, path: string): Promise<ArchiveListing> {
    const normalized = validateArchivePath(path);
    if (normalized === null) throw new Error('无效的文件路径');
    const listing = await this.driver(archive.format).listFiles(archive, normalized);
    const prefix = normalized ? `${normalized}/` : '';
    return { rootPrefix: listing.rootPrefix, entries: listing.entries.filter(entry => {
      if (!entry.name.startsWith(prefix) || entry.name === normalized) return false;
      return !entry.name.slice(prefix.length).includes('/');
    }).sort((a, b) => a.type !== b.type ? (a.type === 'directory' ? -1 : 1) : a.name.localeCompare(b.name)) };
  }

  async readFile(archive: ArchiveSource, path: string): Promise<ArchiveFileContent> {
    const normalized = validateArchivePath(path);
    if (!normalized) throw new Error('无效的文件路径');
    return this.driver(archive.format).readFile(archive, normalized);
  }

  async restore(archive: ArchiveArtifact, target: ArchiveRestoreTarget): Promise<void> {
    await this.driver(archive.format).restore(archive, target);
  }

  describe(version: ArchiveVersion): ArchiveVersionDetails { return this.driver(version.format).describe(version); }
}
