import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, readdir, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpError } from '../../util/errors.js';

const LIMIT = 1024 * 1024;
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
const version = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function decode(bytes: Uint8Array): string | undefined {
  if (bytes.length > LIMIT || bytes.includes(0)) return;
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { return; }
}
export class SharedFiles {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private root = fileURLToPath(new URL('../../data/', import.meta.url))) {}
  private serial<T>(action: () => Promise<T>): Promise<T> {
    const next = this.tail.then(action);
    this.tail = next.catch(() => {});
    return next;
  }
  private validate(path: string) {
    if (path.length > 2048 || /[\\\x00-\x1f\x7f]/.test(path) ||
      (path !== 'AGENTS.md' && !path.startsWith('docs/')) ||
      path.split('/').some(part => !part || part === '.' || part === '..' || part.startsWith('.shared-write-'))) {
      throw new HttpError(400, '路径须为 AGENTS.md 或 docs/ 下的文件，不能包含路径跳转');
    }
  }
  private async resolve(path: string, createParents = false) {
    this.validate(path);
    if (createParents) await mkdir(this.root, { recursive: true });
    let current = this.root;
    const parts = path.split('/');
    for (let i = 0; i < parts.length; i++) {
      current = join(current, parts[i]);
      if (i < parts.length - 1 && createParents) await mkdir(current).catch(error => {
        if (error.code !== 'EEXIST') throw error;
      });
      const info = await lstat(current).catch(error => { if (!missing(error)) throw error; return null; });
      if (info?.isSymbolicLink()) throw new HttpError(400, '不能访问符号链接');
      if (info && (i < parts.length - 1 ? !info.isDirectory() : !info.isFile())) throw new HttpError(400, '路径不是普通文件');
    }
    return current;
  }
  private async snapshot(path: string) {
    const location = await this.resolve(path);
    const handle = await open(location, constants.O_RDONLY | constants.O_NOFOLLOW).catch(error => {
      if (missing(error)) throw new HttpError(404, '文件不存在');
      throw error;
    });
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new HttpError(400, '路径不是普通文件');
      // Hash by streaming to avoid loading large existing binary documents into memory.
      const hash = createHash('sha256');
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of handle.createReadStream({ autoClose: false })) {
        const bytes = Buffer.from(chunk); hash.update(bytes); size += bytes.length;
        if (size <= LIMIT) chunks.push(bytes);
      }
      const content = size <= LIMIT ? decode(Buffer.concat(chunks)) : undefined;
      return { path, size, updatedAt: info.mtime.toISOString(), version: hash.digest('hex'), editable: content !== undefined, content };
    } finally { await handle.close(); }
  }
  list() {
    return this.serial(async () => {
      const paths: string[] = [];
      const agents = await lstat(join(this.root, 'AGENTS.md')).catch(error => { if (!missing(error)) throw error; return null; });
      if (agents?.isFile()) paths.push('AGENTS.md');
      const walk = async (path: string) => {
        const info = await lstat(join(this.root, path)).catch(error => { if (!missing(error)) throw error; return null; });
        if (!info?.isDirectory() || info.isSymbolicLink()) return;
        for (const entry of await readdir(join(this.root, path), { withFileTypes: true })) {
          if (entry.name.startsWith('.shared-write-')) continue;
          const child = `${path}/${entry.name}`;
          if (entry.isDirectory()) await walk(child);
          else if (entry.isFile()) paths.push(child);
        }
      };
      await walk('docs');
      const files = [];
      for (const path of paths.sort()) {
        try {
          const { content: _content, ...metadata } = await this.snapshot(path);
          files.push(metadata);
        } catch (error) { if (!(error instanceof HttpError && error.status === 404)) throw error; }
      }
      return { files };
    });
  }
  read(path: string) {
    return this.serial(async () => {
      const file = await this.snapshot(path);
      if (!file.editable) throw new HttpError(415, '仅支持编辑 1 MB 以内的 UTF-8 文本文件');
      return { path, content: file.content!, version: file.version };
    });
  }
  write(path: string, content: string, expectedVersion?: string) {
    return this.serial(async () => {
      this.validate(path);
      const bytes = Buffer.from(content);
      if (decode(bytes) === undefined) throw new HttpError(400, '文件须为 1 MB 以内、不含空字符的 UTF-8 文本');
      if (expectedVersion !== undefined) {
        const previous = await this.snapshot(path);
        if (previous.version !== expectedVersion) throw new HttpError(409, '文件已被修改，请重新加载后再保存');
      }
      const location = await this.resolve(path, true);
      const temp = join(dirname(location), `.shared-write-${randomUUID()}`);
      try {
        const handle = await open(temp, 'wx', 0o600);
        try { await handle.writeFile(bytes); } finally { await handle.close(); }
        if (expectedVersion === undefined) {
          await link(temp, location).catch(error => {
            if (error.code === 'EEXIST') throw new HttpError(409, '同名文件已存在，请选择其他路径或打开该文件');
            throw error;
          });
        } else await rename(temp, location);
      } finally { await unlink(temp).catch(error => { if (!missing(error)) throw error; }); }
      return { path, content, version: version(bytes) };
    });
  }
  delete(path: string, expectedVersion: string) {
    return this.serial(async () => {
      const previous = await this.snapshot(path);
      if (previous.version !== expectedVersion) throw new HttpError(409, '文件已被修改，请重新加载后再删除');
      await unlink(await this.resolve(path));
      return { ok: true };
    });
  }
}
