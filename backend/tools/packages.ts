import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, parse, resolve } from 'node:path';
import type { ToolPackage, ToolPackageInput } from '../../protocol/tool-types.js';
import { HttpError } from '../../util/errors.js';

export const MAX_TOOL_PACKAGE_BYTES = 32 * 1024 * 1024;
const metadataFile = '.cocell-package.json';
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
export const packageVersionPattern = /^[a-f0-9]{64}$/;
const packageDigest = (files: ToolPackage['files']) => createHash('sha256').update(JSON.stringify(files)).digest('hex');
export function toolPackagePath(path: string) {
  if (path.length > 512 || path === metadataFile ||
      !/^(?:[A-Za-z0-9_+.-]+\/)*[A-Za-z0-9_+.-]+$/.test(path) || path.split('/').some(part => part === '.' || part === '..'))
    throw new HttpError(400, '工具包路径只能包含字母、数字、点、下划线、加号或连字符，且不能跳转目录');
  return path;
}
/** Refuse symlinks in both newly created and already published paths. */
export async function toolDirectory(path: string) {
  const absolute = resolve(path);
  let current = parse(absolute).root;
  for (const part of absolute.slice(current.length).split('/')) {
    current = join(current, part);
    let created = false;
    try { await mkdir(current, { mode: 0o755 }); created = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new HttpError(400, '工具目录不安全');
    if (created || current === absolute) await chmod(current, 0o755);
  }
}

export class ToolPackages {
  readonly root: string;
  constructor(sharedRoot: string) { this.root = join(sharedRoot, 'tools', 'packages'); }
  async init() { await toolDirectory(dirname(this.root)); await toolDirectory(this.root); }
  private versionPath(version: string) {
    if (!packageVersionPattern.test(version)) throw new HttpError(400, '工具包版本无效');
    return join(this.root, version);
  }
  async get(version: string): Promise<ToolPackage> {
    const root = this.versionPath(version);
    try {
      const info = await lstat(root);
      const metadata = await lstat(join(root, metadataFile));
      if (!info.isDirectory() || info.isSymbolicLink() || !metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 128 * 1024)
        throw new HttpError(400, '工具包元数据不安全');
      const value: ToolPackage = JSON.parse(await readFile(join(root, metadataFile), 'utf8'));
      if (value.version !== version || !Array.isArray(value.files) || !value.files.length || value.files.length > 128)
        throw new HttpError(400, '工具包元数据无效');
      let size = 0;
      const files = value.files.map(file => {
        if (typeof file.path !== 'string' || !Number.isSafeInteger(file.size) || file.size < 0 ||
            typeof file.executable !== 'boolean' || !packageVersionPattern.test(file.sha256)) throw new HttpError(400, '工具包元数据无效');
        toolPackagePath(file.path);
        size += file.size;
        return { path: file.path, size: file.size, executable: file.executable, sha256: file.sha256 };
      });
      if (size > MAX_TOOL_PACKAGE_BYTES || packageDigest(files) !== version) throw new HttpError(409, '工具包元数据与版本摘要不一致');
      return { version, files };
    } catch (error) { if (missing(error)) throw new HttpError(404, '工具包不存在，请先上传'); throw error; }
  }
  async list() {
    await this.init();
    const entries = await readdir(this.root, { withFileTypes: true });
    const result: ToolPackage[] = [];
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (packageVersionPattern.test(entry.name)) result.push(await this.get(entry.name));
    }
    return result;
  }
  private async filePath(version: string, path: string) {
    let location = this.versionPath(version);
    for (const part of path.split('/')) {
      location = join(location, part);
      const info = await lstat(location);
      if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) throw new HttpError(400, '工具包路径不安全');
    }
    return location;
  }
  private async verify(pkg: ToolPackage) {
    // Verify every companion as well as the entrypoint; stream to bound heap use.
    for (const file of pkg.files) {
      const handle = await open(await this.filePath(pkg.version, file.path), constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.size !== file.size || Boolean(info.mode & 0o111) !== file.executable)
          throw new HttpError(409, '已发布的工具包被修改');
        const digest = createHash('sha256');
        let read = 0;
        for await (const chunk of handle.createReadStream({ autoClose: false })) {
          read += chunk.length;
          if (read > file.size) throw new HttpError(409, '已发布的工具包被修改');
          digest.update(chunk);
        }
        if (read !== file.size || digest.digest('hex') !== file.sha256) throw new HttpError(409, '已发布的工具包被修改');
      } finally { await handle.close(); }
    }
  }
  async executable(version: string, path: string) {
    toolPackagePath(path);
    const pkg = await this.get(version);
    const file = pkg.files.find(file => file.path === path);
    if (!file?.executable || !file.size) throw new HttpError(400, '请选择工具包中标记为可执行的非空入口文件');
    await this.verify(pkg);
    return `/var/lib/cellbox/shared/tools/packages/${version}/${path}`;
  }
  async upload(input: ToolPackageInput): Promise<ToolPackage> {
    if (!Array.isArray(input.files) || !input.files.length || input.files.length > 128) throw new HttpError(400, '每个工具包需要 1–128 个文件');
    let size = 0;
    const files = input.files.map(file => {
      toolPackagePath(file.path);
      const bytes = Buffer.from(file.content, file.encoding === 'base64' ? 'base64' : 'utf8');
      if (file.encoding === 'base64' && bytes.toString('base64') !== file.content ||
          file.encoding === 'utf8' && bytes.toString('utf8') !== file.content) throw new HttpError(400, '工具包文件编码无效');
      size += bytes.length;
      if (size > MAX_TOOL_PACKAGE_BYTES) throw new HttpError(413, '工具包最多 32 MiB');
      return { path: file.path, content: bytes.toString('base64'), executable: file.executable };
    }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    const paths = new Set<string>();
    for (const file of files) {
      if (paths.has(file.path)) throw new HttpError(400, '工具包文件路径重复或冲突');
      paths.add(file.path);
    }
    for (const path of paths) {
      const parts = path.split('/');
      while (parts.length > 1) { parts.pop(); if (paths.has(parts.join('/'))) throw new HttpError(400, '工具包文件路径重复或冲突'); }
    }
    // A directory cannot hide metadata or collide with a reserved filename.
    if (files.some(file => file.path.startsWith(metadataFile + '/'))) throw new HttpError(400, '工具包路径已保留');
    const metadata = files.map(file => {
      const bytes = Buffer.from(file.content, 'base64');
      return { path: file.path, size: bytes.length, executable: file.executable, sha256: createHash('sha256').update(bytes).digest('hex') };
    });
    const version = packageDigest(metadata);
    const pkg: ToolPackage = { version, files: metadata };
    await this.init();
    const staging = await mkdtemp(join(this.root, '.upload-'));
    try {
      await chmod(staging, 0o755);
      for (const file of files) {
        const path = join(staging, file.path);
        await toolDirectory(dirname(path));
        await writeFile(path, Buffer.from(file.content, 'base64'), { flag: 'wx', mode: file.executable ? 0o755 : 0o644 });
        await chmod(path, file.executable ? 0o755 : 0o644);
      }
      await writeFile(join(staging, metadataFile), JSON.stringify(pkg), { flag: 'wx', mode: 0o644 });
      await chmod(join(staging, metadataFile), 0o644);
      try { await rename(staging, this.versionPath(version)); }
      catch (error) {
        if (!['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
        // Existing digest directories are immutable; never repair them in place.
        const existing = await this.get(version);
        if (JSON.stringify(existing) !== JSON.stringify(pkg)) throw new HttpError(409, '已发布的工具包被修改');
        await this.verify(existing);
      }
      return pkg;
    } finally { await rm(staging, { recursive: true, force: true }); }
  }
}
