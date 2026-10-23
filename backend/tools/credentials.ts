import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, link, lstat, mkdir, mkdtemp, open, readdir, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ToolCredentialEntry, ToolCredentialFile, ToolCredentialHookContext, ToolCredentialInitialize, ToolCredentialInitialization, ToolCredentialWrite } from '../../protocol/tool-credential-types.js';
import type { ToolScript } from '../../protocol/tool-script-types.js';
import { HttpError } from '../../util/errors.js';
import { credentialPath } from '../secrets/policy.js';
import { parseToolCredential, saveToolCredential } from './credential-script.js';

const LIMIT = 1024 * 1024;
const hash = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
type Configuration = { roots: string[]; scriptVersion: number; load?: ToolScript; save?: ToolScript;
  excludedPaths?: string[];
  context?: ToolCredentialHookContext;
};
type Snapshot = { entries: ToolCredentialEntry[]; files: Map<string, Buffer>; version: string };

/** Credentials remain native files. Scripts operate on a temporary copy. */
export class ToolCredentialFiles {
  private root: string;
  private npmCache: string;
  constructor(sharedRoot: string, private configuration: (tool: string) => Promise<Configuration>,
    private coordinate: <T>(action: () => Promise<T>) => Promise<T>) {
    this.root = join(sharedRoot, 'runtime/debug-homes');
    this.npmCache = join(sharedRoot, 'tools/npm-cache');
  }
  private allowed(path: string, roots: string[]) {
    credentialPath(path);
    if (!roots.some(root => path === root || path.startsWith(root + '/'))) throw new HttpError(403, '文件不属于此工具的凭据目录');
  }
  private async location(root: string, path: string, create = false) {
    credentialPath(path);
    let current = root;
    const parts = path.split('/');
    for (let index = 0; index < parts.length; index++) {
      const parent = await lstat(current);
      if (!parent.isDirectory() || parent.isSymbolicLink()) throw new HttpError(400, '凭据目录不能包含符号链接');
      current = join(current, parts[index]);
      if (create && index < parts.length - 1) await mkdir(current, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
      const info = await lstat(current).catch(error => { if (!missing(error)) throw error; return null; });
      if (info?.isSymbolicLink()) throw new HttpError(400, '凭据目录不能包含符号链接');
      if (!info && index < parts.length - 1 && !create) throw new HttpError(404, '凭据文件不存在');
    }
    return current;
  }
  private async bytes(root: string, path: string) {
    const location = await this.location(root, path);
    const file = await open(location, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(error => { if (missing(error)) throw new HttpError(404, '凭据文件不存在'); throw error; });
    try {
      const info = await file.stat();
      if (!info.isFile()) throw new HttpError(400, '请选择普通凭据文件');
      if (info.size > LIMIT) throw new HttpError(413, '凭据文件不能超过 1 MiB');
      const bytes = Buffer.alloc(info.size + 1);
      let count = 0;
      while (count < bytes.length) { const result = await file.read(bytes, count, bytes.length - count, count); if (!result.bytesRead) break; count += result.bytesRead; }
      if (count !== info.size) throw new HttpError(409, '凭据文件已改变，请重新打开');
      return bytes.subarray(0, count);
    } finally { await file.close(); }
  }
  private async snapshot(roots: string[], root = this.root, contents = true, excludedPaths: string[] = []): Promise<Snapshot> {
    const entries: ToolCredentialEntry[] = [], files = new Map<string, Buffer>();
    let total = 0;
    const walk = async (path: string, depth = 0) => {
      if (excludedPaths.some(excluded => path === excluded || path.startsWith(excluded + '/'))) return;
      if (depth > 32 || entries.length >= 1024) throw new HttpError(413, '凭据目录包含过多文件');
      let location: string;
      try { location = await this.location(root, path); }
      catch (error) { if (error instanceof HttpError && error.status === 404) return; throw error; }
      const info = await lstat(location).catch(error => { if (!missing(error)) throw error; return null; });
      if (!info) return;
      if (info.isSymbolicLink()) throw new HttpError(400, '凭据目录不能包含符号链接');
      if (info.isDirectory()) {
        entries.push({ path, type: 'directory', updatedAt: info.mtime.toISOString() });
        for (const child of (await readdir(location, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
          if (child.name.startsWith('.cocell-')) continue;
          if (child.isSymbolicLink()) continue;
          await walk(path + '/' + child.name, depth + 1);
        }
      } else if (info.isFile()) {
        entries.push({ path, type: 'file', size: info.size, updatedAt: info.mtime.toISOString() });
        if (contents) {
          if (files.size >= 128 || (total += info.size) > 4 * LIMIT) throw new HttpError(413, '凭据文件总量不能超过 4 MiB 或 128 个文件');
          files.set(path, await this.bytes(root, path));
        }
      }
    };
    for (const path of roots) await walk(path);
    return { entries, files, version: hash(JSON.stringify([...files].map(([path, bytes]) => [path, hash(bytes)]).sort((a, b) => a[0].localeCompare(b[0])))) };
  }
  async tree(tool: string) {
    const config = await this.configuration(tool);
    const snapshot = await this.snapshot(config.roots, this.root, false, config.excludedPaths);
    return { tool, home: '/home/debug', roots: config.roots, entries: snapshot.entries, version: this.inventoryVersion(config, snapshot) };
  }
  private inventoryVersion(config: Configuration, snapshot: Snapshot) {
    return hash(JSON.stringify([config.scriptVersion, config.roots, config.excludedPaths ?? [], snapshot.entries]));
  }
  /** Installation is explicit and create-only; ordinary saves and restarts never run it. */
  async initialize(tool: string, input: ToolCredentialInitialize): Promise<ToolCredentialInitialization> {
    return this.coordinate(async () => {
      const config = await this.configuration(tool);
      const before = await this.snapshot(config.roots, this.root, false, config.excludedPaths);
      if (input.version !== this.inventoryVersion(config, before)) throw new HttpError(409, '凭据目录已更新，请重新安装');
      if (input.directories.length > 32 || input.files.length > 128) throw new HttpError(413, '初始化文件或目录过多');
      const paths = new Set<string>();
      const validate = (path: string, directory = false) => {
        if (directory && config.roots.some(root => root.startsWith(path + '/'))) credentialPath(path);
        else this.allowed(path, config.roots);
        if (config.excludedPaths?.some(excluded => path === excluded || path.startsWith(excluded + '/')))
          throw new HttpError(403, '不能初始化排除的凭据路径');
        if (paths.has(path)) throw new HttpError(400, '初始化路径不能重复');
        paths.add(path);
      };
      for (const path of input.directories) validate(path, true);
      let total = 0;
      const files = input.files.map(file => {
        validate(file.path);
        if (!['utf8', 'base64'].includes(file.encoding)) throw new HttpError(400, '初始化文件编码无效');
        const bytes = Buffer.from(file.content, file.encoding);
        if (file.encoding === 'base64' && bytes.toString('base64') !== file.content) throw new HttpError(400, '初始化文件 Base64 无效');
        if (bytes.length > LIMIT || (total += bytes.length) > 4 * LIMIT) throw new HttpError(413, '初始化文件超过大小限制');
        return { path: file.path, bytes };
      });
      for (const file of files) if ([...paths].some(path => path.startsWith(file.path + '/')))
        throw new HttpError(400, '初始化文件不能同时作为目录');
      const existingFiles = new Set<string>();
      for (const path of paths) {
        let location: string;
        try { location = await this.location(this.root, path); }
        catch (error) { if (error instanceof HttpError && error.status === 404) continue; throw error; }
        const info = await lstat(location).catch(error => { if (!missing(error)) throw error; return null; });
        if (!info) continue;
        const directory = input.directories.includes(path);
        if (directory ? !info.isDirectory() : !info.isFile()) throw new HttpError(400, '初始化路径的文件类型冲突');
        if (!directory) existingFiles.add(path);
      }
      const createdDirectories: string[] = [], createdFiles: Array<{ path: string; bytes: Buffer; dev: number; ino: number }> = [];
      const result: ToolCredentialInitialization = { created: [], skipped: [] };
      // Resolve each component through an open parent: a CLI replacing a path
      // with a symlink must never redirect installation outside the native HOME.
      const directory = async (path: string, create = false) => {
        const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
        let handle = await open(this.root, flags);
        try {
          let relative = '';
          for (const part of path === '.' ? [] : path.split('/')) {
            relative = relative ? relative + '/' + part : part;
            const child = `/proc/self/fd/${handle.fd}/${part}`;
            if (create) {
              try { await mkdir(child, { mode: 0o700 }); createdDirectories.push(relative); }
              catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
            }
            const next = await open(child, flags).catch(error => {
              if (['ELOOP', 'ENOTDIR'].includes(error.code)) throw new HttpError(400, '凭据目录不能包含符号链接或普通文件');
              throw error;
            });
            await handle.close(); handle = next;
          }
          return handle;
        } catch (error) { await handle.close(); throw error; }
      };
      const inspect = async (file: typeof createdFiles[number], remove = false) => {
        const parent = await directory(dirname(file.path)).catch(() => null);
        if (!parent) return false;
        try {
          const target = `/proc/self/fd/${parent.fd}/${file.path.split('/').at(-1)}`;
          const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(() => null);
          if (!handle) return false;
          let unchanged = false;
          try {
            const info = await handle.stat();
            if (info.isFile() && info.dev === file.dev && info.ino === file.ino && info.size === file.bytes.length) {
              const buffer = Buffer.alloc(file.bytes.length + 1);
              const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
              unchanged = bytesRead === file.bytes.length && buffer.subarray(0, bytesRead).equals(file.bytes);
            }
          } finally { await handle.close(); }
          if (unchanged && remove) await rm(target);
          return unchanged;
        } finally { await parent.close(); }
      };
      try {
        for (const path of input.directories) {
          await (await directory(path, true)).close();
          (createdDirectories.includes(path) ? result.created : result.skipped).push(path);
        }
        for (const { path, bytes } of files) {
          if (existingFiles.has(path)) { result.skipped.push(path); continue; }
          const parent = await directory(dirname(path), true);
          const target = `/proc/self/fd/${parent.fd}/${path.split('/').at(-1)}`, temporary = `/proc/self/fd/${parent.fd}/.cocell-${randomUUID()}`;
          try {
            const handle = await open(temporary, 'wx', 0o600);
            try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
            try { await link(temporary, target); }
            catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new HttpError(409, '凭据已被其他操作创建，请重新安装'); throw error; }
            const info = await lstat(temporary);
            createdFiles.push({ path, bytes, dev: info.dev, ino: info.ino });
            await parent.sync();
            result.created.push(path);
          } finally { try { await rm(temporary, { force: true }); } finally { await parent.close(); } }
        }
        for (const file of createdFiles) if (!await inspect(file))
          throw new HttpError(409, '凭据已被其他操作修改，请重新安装');
        return result;
      } catch (error) {
        for (const file of createdFiles.reverse()) await inspect(file, true).catch(() => {});
        for (const path of createdDirectories.reverse()) {
          const parent = await directory(dirname(path)).catch(() => null);
          if (!parent) continue;
          try { await rmdir(`/proc/self/fd/${parent.fd}/${path.split('/').at(-1)}`).catch(() => {}); }
          finally { await parent.close(); }
        }
        throw error;
      }
    });
  }
  private async staged<T>(snapshot: Snapshot, action: (home: string) => Promise<T>) {
    const home = await mkdtemp(join(tmpdir(), 'cocell-credentials-'));
    try {
      await chmod(home, 0o700);
      for (const [path, bytes] of snapshot.files) {
        await mkdir(dirname(join(home, path)), { recursive: true, mode: 0o700 });
        await writeFile(join(home, path), bytes, { mode: 0o600 });
      }
      return await action(home);
    } finally { await rm(home, { recursive: true, force: true }); }
  }
  private async view(path: string, config: Configuration, snapshot: Snapshot): Promise<ToolCredentialFile> {
    const bytes = snapshot.files.get(path);
    if (!bytes) throw new HttpError(404, '凭据文件不存在');
    const parsed = await this.staged(snapshot, home => parseToolCredential(config.load?.source, { path, content: bytes.toString('base64') }, {
      language: config.load?.language, home, npmCache: this.npmCache, context: config.context,
      files: [...snapshot.files].map(([path, bytes]) => ({ path, content: bytes.toString('base64') })),
    }));
    return { path, ...parsed, version: snapshot.version, scriptVersion: config.scriptVersion, size: bytes.length,
      editable: parsed.encoding !== 'parsed' || config.save !== undefined };
  }
  async read(tool: string, path: string) {
    const config = await this.configuration(tool);
    this.allowed(path, config.roots);
    return this.view(path, config, await this.snapshot(config.roots, this.root, true, config.excludedPaths));
  }
  private async atomic(path: string, bytes: Buffer) {
    const target = await this.location(this.root, path, true), temporary = join(dirname(target), '.cocell-' + randomUUID());
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      await rename(temporary, target);
      const directory = await open(dirname(target), 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    } finally { await rm(temporary, { force: true }); }
  }
  async write(tool: string, input: ToolCredentialWrite) {
    const config = await this.configuration(tool);
    this.allowed(input.path, config.roots);
    const before = await this.snapshot(config.roots, this.root, true, config.excludedPaths), original = before.files.get(input.path);
    if (!original) throw new HttpError(404, '凭据文件不存在');
    if (config.scriptVersion !== input.scriptVersion || before.version !== input.version) throw new HttpError(409, '文件或脚本已更新，请重新打开');
    const { encoding } = await this.view(input.path, config, before);
    if (input.encoding !== encoding) throw new HttpError(400, '文件编码与当前 Load hook 不一致，请重新打开');
    const changes = await this.staged(before, async home => {
      const selected = await saveToolCredential(config.save?.source, { ...input, original: original.toString('base64') }, {
        language: config.save?.language, home, npmCache: this.npmCache, context: config.context,
        files: [...before.files].map(([path, bytes]) => ({ path, content: bytes.toString('base64') })),
      });
      await writeFile(await this.location(home, input.path), selected, { mode: 0o600 });
      const result = await this.snapshot(config.roots, home, true, config.excludedPaths);
      if ([...before.files.keys()].some(path => !result.files.has(path))) throw new HttpError(400, 'Save hook 不能删除凭据文件');
      if (config.load) await this.view(input.path, config, result);
      return [...result.files].filter(([path, bytes]) => !before.files.has(path) || !bytes.equals(before.files.get(path)!));
    });
    await this.coordinate(async () => {
      if ((await this.configuration(tool)).scriptVersion !== input.scriptVersion || (await this.snapshot(config.roots, this.root, true, config.excludedPaths)).version !== before.version)
        throw new HttpError(409, '文件或脚本已更新，请重新打开');
      const written: Array<[string, Buffer]> = [];
      try {
        for (const [path, bytes] of changes) {
          const prior = before.files.get(path);
          let current: Buffer | undefined;
          try { current = await this.bytes(this.root, path); } catch (error) { if (!(error instanceof HttpError && error.status === 404)) throw error; }
          if (prior ? !current?.equals(prior) : current !== undefined) throw new HttpError(409, '凭据已被 CLI 更新，请重新打开');
          written.push([path, bytes]); await this.atomic(path, bytes);
        }
        const expected = new Map(before.files);
        for (const [path, bytes] of changes) expected.set(path, bytes);
        const actual = await this.snapshot(config.roots, this.root, true, config.excludedPaths);
        if (actual.files.size !== expected.size || [...expected].some(([path, bytes]) => !actual.files.get(path)?.equals(bytes)))
          throw new HttpError(409, '凭据已被 CLI 更新，请重新打开');
      } catch (error) {
        for (const [path, bytes] of written.reverse()) {
          let current: Buffer;
          try { current = await this.bytes(this.root, path); }
          catch (rollbackError) { if (rollbackError instanceof HttpError && rollbackError.status === 404) continue; throw rollbackError; }
          if (!current.equals(bytes)) continue;
          const prior = before.files.get(path);
          if (prior) await this.atomic(path, prior); else await rm(await this.location(this.root, path));
        }
        throw error;
      }
    });
    return this.read(tool, input.path);
  }
}
