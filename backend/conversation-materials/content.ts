import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { HttpError } from '../../util/errors.js';

/** A bounded UTF-8 page, shared by material and report source viewers. */
export async function readMaterialContent(directory: string, path: string, offset: number, expectedSize?: number) {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new HttpError(400, '文件读取位置无效');
  const resolve = async (path: string) => realpath(path).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new HttpError(404, '材料文件不存在');
    throw error;
  });
  const root = await resolve(directory);
  const filename = await resolve(join(root, path));
  if (!filename.startsWith(root + sep)) throw new HttpError(404, '材料文件不存在');
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || expectedSize !== undefined && info.size !== expectedSize) throw new HttpError(409, '材料文件已变化');
    if (offset > info.size) throw new HttpError(400, '文件读取位置超出范围');
    const limit = 256 * 1024;
    const bytes = Buffer.alloc(Math.min(limit + 3, info.size - offset));
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, offset);
    if (bytesRead && (bytes[0] & 0xc0) === 0x80) throw new HttpError(400, '文件读取位置不在字符边界');
    let end = Math.min(limit, bytesRead);
    while (end < bytesRead && (bytes[end] & 0xc0) === 0x80) end++;
    return { content: new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, end)),
      nextOffset: offset + end < info.size ? offset + end : null, totalBytes: info.size };
  } finally { await handle.close(); }
}
