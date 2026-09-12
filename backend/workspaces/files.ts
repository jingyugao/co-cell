import { posix } from 'node:path';
import type { WorkspaceFile } from '../../protocol/workspace-types.js';
import { HttpError } from '../../util/errors.js';

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_TEXT_BYTES = 1024 * 1024;
export const SANDBOX_DOCS_DIRECTORY = '/home/user/.codex/docs';
export interface WorkspaceFileResult { file: WorkspaceFile; data: Buffer; version?: string }
export interface WorkspaceFileReadOptions {
  metadataOnly?: boolean;
  offset?: number;
  length?: number;
  version?: string;
}

const inside = (path: string, root: string) => path === root || path.startsWith(`${root}/`);
export function workspaceFileRequest(workingDirectory: string, path: string, options: WorkspaceFileReadOptions = {}) {
  if (!path || path.length > 4096 || !posix.isAbsolute(path) || /[\x00-\x1f\x7f]/.test(path)) {
    throw new HttpError(400, '文件地址必须是沙箱内的绝对路径');
  }
  const roots = [posix.normalize(workingDirectory).replace(/\/$/, ''), SANDBOX_DOCS_DIRECTORY];
  const normalized = posix.normalize(path);
  if (!roots.some(root => root && inside(normalized, root))) throw new HttpError(403, '只能访问项目工作区和共享文档中的文件');
  if ((options.offset !== undefined || options.length !== undefined) &&
      (!Number.isSafeInteger(options.offset) || options.offset! < 0 || !Number.isSafeInteger(options.length) || options.length! < 0 || options.length! > MAX_FILE_BYTES)) {
    throw new HttpError(400, '文件读取范围无效');
  }
  return { ...options, path: normalized, roots, maxBytes: MAX_FILE_BYTES };
}

// Self-contained: existing sandboxes can read files without deploying a new worker.
// Check the opened descriptor too, so replacing a parent symlink between realpath
// and open cannot turn a workspace path into a read outside the permitted roots.
export const READ_SANDBOX_FILE_SCRIPT = String.raw`
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path').posix;
const request = JSON.parse(Buffer.from(process.argv[1], 'base64').toString('utf8'));
const inside = (value, root) => value === root || value.startsWith(root + '/');
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
(async () => {
  let handle;
  try {
    const candidate = path.normalize(request.path);
    const root = request.roots.find(root => inside(candidate, root));
    if (!root) fail(403, '文件不在允许访问的目录中');
    const realRoot = await fs.realpath(root);
    if (realRoot !== root) fail(403, '工作区根目录不能通过符号链接指向其他位置');
    const target = await fs.realpath(candidate);
    if (!inside(target, realRoot)) fail(403, '文件符号链接指向允许范围之外');
    handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = await fs.realpath('/proc/self/fd/' + handle.fd);
    if (!inside(opened, realRoot)) fail(403, '文件位置已改变，无法安全读取');
    const stat = await handle.stat();
    if (!stat.isFile()) fail(400, '此地址不是普通文件');
    const versionOf = s => [s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs].join('-');
    const version = versionOf(stat);
    if (request.version && request.version !== version) fail(409, '文件已变更，请重新下载');
    const metadata = { path: candidate, size: stat.size, version };
    if (request.metadataOnly || (request.offset === undefined && stat.size > request.maxBytes)) {
      process.stdout.write(JSON.stringify(metadata));
      return;
    }
    const offset = request.offset ?? 0;
    const length = request.length ?? stat.size;
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0 || length > request.maxBytes) fail(400, '文件读取范围无效');
    const data = Buffer.alloc(Math.min(length, Math.max(0, stat.size - offset)));
    let size = 0;
    while (size < data.length) {
      const { bytesRead } = await handle.read(data, size, data.length - size, offset + size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (versionOf(await handle.stat()) !== version) fail(409, '文件已变更，请重新下载');
    process.stdout.write(JSON.stringify({ ...metadata, data: data.subarray(0, size).toString('base64') }));
  } catch (error) {
    const status = error.status || (['ENOENT', 'ENOTDIR'].includes(error.code) ? 404 : ['EACCES', 'EPERM', 'ELOOP'].includes(error.code) ? 403 : 500);
    const message = error.status ? error.message : status === 404 ? '文件不存在或已移动' : status === 403 ? '没有权限读取此文件' : '无法读取沙箱文件';
    process.stdout.write(JSON.stringify({ error: message, status }));
  } finally { await handle?.close(); }
})();
`;

function rasterMime(data: Buffer): string | undefined {
  if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (data.length >= 3 && data[0] === 255 && data[1] === 216 && data[2] === 255) return 'image/jpeg';
  if (['GIF87a', 'GIF89a'].includes(data.toString('ascii', 0, 6))) return 'image/gif';
  if (data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
}

export function parseWorkspaceFile(stdout: string): WorkspaceFileResult {
  let result: { path?: string; data?: string; size?: number; version?: string; error?: string; status?: number };
  try { result = JSON.parse(stdout); } catch { throw new HttpError(502, '沙箱文件响应不完整，请重试'); }
  if (result.error) throw new HttpError([400, 403, 404, 409, 413].includes(result.status ?? 0) ? result.status! : 502, result.error);
  if (typeof result.path !== 'string' || (result.data !== undefined && typeof result.data !== 'string') ||
      (result.size !== undefined && (!Number.isSafeInteger(result.size) || result.size < 0)) ||
      (result.data === undefined && result.size === undefined)) throw new HttpError(502, '沙箱文件响应无效');
  const data = Buffer.from(result.data ?? '', 'base64');
  if (data.length > MAX_FILE_BYTES) throw new HttpError(413, '文件读取块超过 10 MiB');
  const file: WorkspaceFile = { path: result.path, name: posix.basename(result.path), size: result.size ?? data.length, kind: 'binary', mimeType: 'application/octet-stream' };
  if (result.data === undefined) return { file, data, version: result.version };
  const imageMime = rasterMime(data);
  if (imageMime) { file.kind = 'image'; file.mimeType = imageMime; }
  else if (data.length <= MAX_TEXT_BYTES) {
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(data);
      if (!/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)) {
        file.kind = 'text'; file.text = text; file.mimeType = 'text/plain; charset=utf-8';
      }
    } catch { /* Binary content is available as an attachment only. */ }
  }
  return { file, data, version: result.version };
}
