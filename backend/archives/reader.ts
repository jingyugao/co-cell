import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';

const MAX_FILE_BYTES = 512 * 1024;
export interface ArchiveFileEntry { name: string; type: 'file' | 'directory'; size: number; mtime?: string }
export interface ArchiveListing { entries: ArchiveFileEntry[]; rootPrefix: string }
export interface ArchiveFileContent { content: string; truncated: boolean; totalSize?: number }
export interface ArchiveFile { storagePath: string; sizeBytes: number; sha256: string; createdAt: string }

export function validateArchivePath(path: string): string | null {
  if (!path) return '';
  if (path.includes('\\') || path.includes('\0') || path.startsWith('/')) return null;
  const parts = path.replace(/\/+$/, '').split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) return null;
  return parts.join('/');
}

export function spawnCapped(command: string, args: string[], limit: number): Promise<{ content: Buffer; truncated: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
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

export function createArchiveReader() {
  return {
    normalizePath: validateArchivePath,
    artifactFromFile: (input: ArchiveFile): ArchiveFile => input,
    async validate(archive: ArchiveFile): Promise<void> {
      const file = await stat(archive.storagePath);
      if (!file.isFile() || !file.size || file.size !== archive.sizeBytes) throw new Error('Tar archive size does not match');
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(archive.storagePath)) hash.update(chunk);
      if (hash.digest('hex') !== archive.sha256) throw new Error('Tar archive checksum does not match');
    },
    async listFiles(archive: ArchiveFile, path: string): Promise<ArchiveListing> {
      const normalized = validateArchivePath(path);
      if (normalized === null) throw new Error('无效的文件路径');
      const listing = await listTarFiles(archive.storagePath);
      const prefix = normalized ? `${normalized}/` : '';
      return { rootPrefix: listing.rootPrefix, entries: listing.entries.filter(entry => {
        if (!entry.name.startsWith(prefix) || entry.name === normalized) return false;
        return !entry.name.slice(prefix.length).includes('/');
      }).sort((a, b) => a.type !== b.type ? (a.type === 'directory' ? -1 : 1) : a.name.localeCompare(b.name)) };
    },
    async readFile(archive: ArchiveFile, path: string): Promise<ArchiveFileContent> {
      const normalized = validateArchivePath(path);
      if (!normalized) throw new Error('无效的文件路径');
      const { rootPrefix } = await listTarFiles(archive.storagePath);
      const { content, truncated } = await spawnCapped('tar', ['-xzf', archive.storagePath, '-O', '--', rootPrefix + normalized], MAX_FILE_BYTES);
      return { content: content.toString('utf8'), truncated, ...(truncated ? {} : { totalSize: content.length }) };
    },
  };
}
