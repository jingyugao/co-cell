import { posix } from 'node:path';
import type { WorkspaceFile } from '../../protocol/workspace-types.js';
import { HttpError } from '../../util/errors.js';

export const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_TEXT_BYTES = 1024 * 1024;
export const SANDBOX_DOCS_DIRECTORY = '/home/agent/workspace/.cocell/codex/docs';
export interface WorkspaceFileResult { file: WorkspaceFile; data: Buffer }

function rasterMime(data: Buffer): string | undefined {
  if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (data.length >= 3 && data[0] === 255 && data[1] === 216 && data[2] === 255) return 'image/jpeg';
  if (['GIF87a', 'GIF89a'].includes(data.toString('ascii', 0, 6))) return 'image/gif';
  if (data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
}

export function workspaceFileResult(path: string, bytes: Uint8Array): WorkspaceFileResult {
  const data = Buffer.from(bytes);
  if (data.length > MAX_FILE_BYTES) throw new HttpError(413, '文件超过 16 MiB，无法读取');
  const file: WorkspaceFile = { path, name: posix.basename(path), size: data.length, kind: 'binary', mimeType: 'application/octet-stream' };
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
