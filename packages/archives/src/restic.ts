import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { access, chmod, lstat, mkdir, readFile, readdir, stat, statfs, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const identifier = /^[a-f0-9-]{36}$/i;
const snapshotIdentifier = /^[a-f0-9]{64}$/i;

export interface ResticSnapshot {
  repositoryId: string;
  snapshotId: string;
  logicalSizeBytes: number;
  addedBytes: number;
  repositorySizeBytes: number;
  durationMs: number;
  version: string;
}

/** Service-managed repositories. A project's repository may be mounted in its Sandbox; the password stays service-only. */
export class ResticArchives {
  readonly repositoryRoot: string;
  readonly passwordFile: string;
  readonly binary: string;
  private readonly repositoryLocks = new Map<string, Promise<void>>();

  constructor(options: { repositoryRoot?: string; passwordFile?: string; binary?: string; uid?: number; gid?: number } = {}) {
    this.repositoryRoot = resolve(options.repositoryRoot ?? 'data/sandbox-restic');
    this.passwordFile = resolve(options.passwordFile ?? 'data/credentials/sandbox-restic-password');
    this.binary = options.binary ?? process.env.RESTIC_BINARY ?? 'restic';
    this.uid = options.uid;
    this.gid = options.gid;
  }

  readonly uid?: number;
  readonly gid?: number;

  async ready() {
    await mkdir(this.repositoryRoot, { recursive: true, mode: 0o700 });
    await mkdir(resolve(this.passwordFile, '..'), { recursive: true, mode: 0o700 });
    if ((await lstat(this.repositoryRoot)).isSymbolicLink()) throw new Error('Restic repository root must not be a symlink');
    if ((await lstat(resolve(this.passwordFile, '..'))).isSymbolicLink()) throw new Error('Restic credential directory must not be a symlink');
    await chmod(this.repositoryRoot, 0o700);
    await chmod(resolve(this.passwordFile, '..'), 0o700);
    try { await access(this.passwordFile); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if ((await readdir(this.repositoryRoot)).length) throw new Error('Restic password is missing for existing repositories');
      try { await writeFile(this.passwordFile, randomBytes(48).toString('base64url'), { flag: 'wx', mode: 0o600 }); }
      catch (writeError) { if ((writeError as NodeJS.ErrnoException).code !== 'EEXIST') throw writeError; }
    }
    const credential = await lstat(this.passwordFile);
    if (!credential.isFile() || credential.isSymbolicLink()) throw new Error('Restic password path is not a regular file');
    await chmod(this.passwordFile, 0o600);
    if (!(await readFile(this.passwordFile, 'utf8')).trim()) throw new Error('Restic password file is empty');
    await this.run(undefined, ['version']);
  }

  repository(id: string) {
    if (!identifier.test(id)) throw new Error('Invalid Restic repository ID');
    return join(this.repositoryRoot, id);
  }

  /** Serialize service operations that change the same repository. */
  async withRepositoryLock<T>(repositoryId: string, work: () => Promise<T>): Promise<T> {
    this.repository(repositoryId);
    const previous = this.repositoryLocks.get(repositoryId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>(resolve => { release = resolve; });
    const tail = previous.then(() => current);
    this.repositoryLocks.set(repositoryId, tail);
    await previous;
    try { return await work(); }
    finally {
      release();
      if (this.repositoryLocks.get(repositoryId) === tail) this.repositoryLocks.delete(repositoryId);
    }
  }

  private async run(repositoryId: string | undefined, args: string[], cwd?: string): Promise<string> {
    if (repositoryId) {
      const repository = await lstat(this.repository(repositoryId));
      if (!repository.isDirectory() || repository.isSymbolicLink()) throw new Error('Restic repository path is not a real directory');
    }
    const environment: NodeJS.ProcessEnv = { ...process.env, RESTIC_PASSWORD_FILE: this.passwordFile,
      ...(repositoryId ? { RESTIC_REPOSITORY: this.repository(repositoryId) } : {}) };
    delete environment.RESTIC_PASSWORD;
    delete environment.RESTIC_PASSWORD_COMMAND;
    try {
      const { stdout } = await exec(this.binary, args, { cwd, env: environment, timeout: 3 * 60 * 60 * 1000, maxBuffer: 64 * 1024 * 1024 });
      return stdout;
    } catch (error) {
      const failure = error as Error & { stderr?: string };
      throw new Error(`Restic ${args[0]} failed: ${failure.stderr?.trim() || failure.message}`);
    }
  }

  async ensureRepository(repositoryId: string) {
    const path = this.repository(repositoryId);
    await mkdir(path, { recursive: true, mode: 0o700 });
    if ((await lstat(path)).isSymbolicLink()) throw new Error('Restic repository must not be a symlink');
    await chmod(path, 0o700);
    try { await access(join(path, 'config')); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await this.run(repositoryId, ['init']);
      // The service initializes the repository as root, while the Sandbox
      // command writes subsequent snapshots as the configured Sandbox user.
      if (this.uid !== undefined && this.gid !== undefined) {
        await exec('chown', ['-R', `${this.uid}:${this.gid}`, path]);
      }
    }
  }

  async assertSpace(repositoryId?: string, sourceRoot?: string) {
    const minimum = Number(process.env.SANDBOX_RESTIC_MIN_FREE_BYTES ?? 512 * 1024 * 1024);
    if (!Number.isSafeInteger(minimum) || minimum < 0) throw new Error('SANDBOX_RESTIC_MIN_FREE_BYTES must be a non-negative integer');
    const volume = await statfs(this.repositoryRoot);
    let firstSnapshotBytes = 0;
    if (repositoryId && sourceRoot) {
      try { await access(join(this.repository(repositoryId), 'config')); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        firstSnapshotBytes = await this.treeSize([join(sourceRoot, 'workspace'), join(sourceRoot, 'codex')]);
      }
    }
    if (volume.bavail * volume.bsize < minimum + firstSnapshotBytes) throw new Error('Insufficient free space for a Restic backup');
  }

  private async treeSize(roots: string[]): Promise<number> {
    let total = 0;
    const pending = [...roots];
    while (pending.length) {
      const directory = pending.pop()!;
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) pending.push(path);
        else if (entry.isFile()) {
          try { total += (await stat(path)).size; }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        }
      }
    }
    return total;
  }

  async repositorySize(repositoryId: string): Promise<number> { return this.treeSize([this.repository(repositoryId)]); }

  async snapshot(repositoryId: string, sandboxId: string, source: string, ignores: string[]): Promise<ResticSnapshot> {
    return this.withRepositoryLock(repositoryId, () => this.snapshotUnlocked(repositoryId, sandboxId, source, ignores));
  }

  private async snapshotUnlocked(repositoryId: string, sandboxId: string, source: string, ignores: string[]): Promise<ResticSnapshot> {
    if (!identifier.test(repositoryId) || !/^[a-f0-9]{12,64}$/i.test(sandboxId)) throw new Error('Invalid Restic source identity');
    const base = resolve(source);
    for (const name of ['workspace', 'codex']) {
      if (!(await stat(join(base, name))).isDirectory()) throw new Error(`Restic source is missing ${name}`);
    }
    await this.ensureRepository(repositoryId);
    const started = Date.now();
    const version = (await this.run(undefined, ['version'])).trim();
    // A replacement uses a different host generation path. The repository is
    // project-scoped, so group by host instead of the changing absolute paths.
    const args = ['backup', '--json', '--group-by', 'host', '--tag', `project:${repositoryId}`, '--tag', `sandbox:${sandboxId}`];
    for (const ignore of ignores) {
      if (!/^(workspace|codex)\/[\w.\/-]+\/?$/.test(ignore)
        || ignore.split('/').some(part => part === '.' || part === '..') || ignore.includes('//')) throw new Error('Invalid backup ignore pattern');
      args.push('--exclude', join(base, ignore.replace(/\/$/, '')));
    }
    args.push('workspace', 'codex');
    const output = await this.run(repositoryId, args, base);
    const summary = output.split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>)
      .filter(line => line.message_type === 'summary').at(-1);
    const snapshotId = summary?.snapshot_id;
    if (!summary || typeof snapshotId !== 'string' || !snapshotIdentifier.test(snapshotId)) throw new Error('Restic did not return a snapshot ID');
    await this.verify(repositoryId, snapshotId);
    return { repositoryId, snapshotId,
      logicalSizeBytes: Number(summary.total_bytes_processed ?? 0), addedBytes: Number(summary.data_added ?? 0),
      repositorySizeBytes: await this.repositorySize(repositoryId), durationMs: Date.now() - started, version };
  }

  async verify(repositoryId: string, snapshotId: string) {
    if (!snapshotIdentifier.test(snapshotId)) throw new Error('Invalid Restic snapshot ID');
    const snapshots = JSON.parse(await this.run(repositoryId, ['snapshots', '--json', snapshotId])) as Array<{ id: string }>;
    if (!snapshots.some(item => item.id === snapshotId)) throw new Error('Restic snapshot does not exist');
    await this.run(repositoryId, ['check']);
  }

  async restore(repositoryId: string, snapshotId: string, destination: string) {
    await this.verify(repositoryId, snapshotId);
    const target = resolve(destination);
    await mkdir(target, { recursive: true, mode: 0o700 });
    await this.run(repositoryId, ['restore', snapshotId, '--target', target]);
    for (const name of ['workspace', 'codex']) {
      const info = await stat(join(target, name));
      if (!info.isDirectory()) throw new Error(`Restic restore is missing ${name}`);
      if ((this.uid !== undefined && info.uid !== this.uid) || (this.gid !== undefined && info.gid !== this.gid)) {
        throw new Error(`Restic restore has incorrect ${name} ownership`);
      }
    }
    for (const name of await readdir(join(target, 'codex'))) {
      if (!name.endsWith('.sqlite')) continue;
      const database = join(target, 'codex', name);
      if (!(await stat(database)).isFile()) continue;
      const { stdout } = await exec('sqlite3', [database, 'PRAGMA integrity_check;'], { timeout: 60_000, maxBuffer: 1024 * 1024 });
      if (stdout.trim() !== 'ok') throw new Error(`Restored Codex SQLite database failed integrity check: ${name}`);
    }
  }

  async forget(repositoryId: string, snapshotId: string) {
    if (!snapshotIdentifier.test(snapshotId)) throw new Error('Invalid Restic snapshot ID');
    const snapshots = JSON.parse(await this.run(repositoryId, ['snapshots', '--json'])) as Array<{ id: string }>;
    if (snapshots.some(item => item.id === snapshotId)) await this.run(repositoryId, ['forget', snapshotId]);
  }

  async listSnapshots(repositoryId: string): Promise<string[]> {
    const snapshots = JSON.parse(await this.run(repositoryId, ['snapshots', '--json'])) as Array<{ id: string }>;
    return snapshots.map(item => item.id).filter(id => snapshotIdentifier.test(id));
  }

  async listRepositories(): Promise<string[]> {
    const entries = await readdir(this.repositoryRoot, { withFileTypes: true });
    return entries.filter(entry => entry.isDirectory() && identifier.test(entry.name)).map(entry => entry.name);
  }

  async prune(repositoryId: string) { await this.run(repositoryId, ['prune']); }

  async checkDataSubset(repositoryId: string, percentage = 10) {
    if (!Number.isInteger(percentage) || percentage < 1 || percentage > 100) throw new Error('Restic check percentage must be 1 to 100');
    await this.run(repositoryId, ['check', `--read-data-subset=${percentage}%`]);
  }
}
