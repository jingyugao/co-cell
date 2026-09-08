import { posix } from 'node:path';
import type { WorkspaceFile } from '../../shared/workspace-types.js';
import { HttpError } from '../core/errors.js';

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_TEXT_BYTES = 1024 * 1024;
export const SANDBOX_DOCS_DIRECTORY = '/home/user/.codex/docs';
export interface WorkspaceFileResult { file: WorkspaceFile; data: Buffer }

const inside = (path: string, root: string) => path === root || path.startsWith(`${root}/`);
export function workspaceFileRequest(workingDirectory: string, path: string) {
  if (!path || path.length > 4096 || !posix.isAbsolute(path) || /[\x00-\x1f\x7f]/.test(path)) {
    throw new HttpError(400, '文件地址必须是沙箱内的绝对路径');
  }
  const roots = [posix.normalize(workingDirectory).replace(/\/$/, ''), SANDBOX_DOCS_DIRECTORY];
  const normalized = posix.normalize(path);
  if (!roots.some(root => root && inside(normalized, root))) throw new HttpError(403, '只能访问项目工作区和共享文档中的文件');
  return { path: normalized, roots, maxBytes: MAX_FILE_BYTES };
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
    if (stat.size > request.maxBytes) fail(413, '文件超过 10 MiB，暂不支持预览或下载');
    const data = Buffer.alloc(request.maxBytes + 1);
    let size = 0;
    while (size < data.length) {
      const { bytesRead } = await handle.read(data, size, data.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > request.maxBytes) fail(413, '文件超过 10 MiB，暂不支持预览或下载');
    process.stdout.write(JSON.stringify({ path: candidate, data: data.subarray(0, size).toString('base64') }));
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
  let result: { path?: string; data?: string; error?: string; status?: number };
  try { result = JSON.parse(stdout); } catch { throw new HttpError(502, '沙箱文件响应不完整，请重试'); }
  if (result.error) throw new HttpError([400, 403, 404, 413].includes(result.status ?? 0) ? result.status! : 502, result.error);
  if (typeof result.path !== 'string' || typeof result.data !== 'string') throw new HttpError(502, '沙箱文件响应无效');
  const data = Buffer.from(result.data, 'base64');
  if (data.length > MAX_FILE_BYTES) throw new HttpError(413, '文件超过 10 MiB，暂不支持预览或下载');
  const file: WorkspaceFile = { path: result.path, name: posix.basename(result.path), size: data.length, kind: 'binary', mimeType: 'application/octet-stream' };
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
  return { file, data };
}
