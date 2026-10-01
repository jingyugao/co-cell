import type { WorkspaceFilePreview } from '../../protocol/workspace-types';
import { fileContentUrl } from './resource-links';

const MAX_PREVIEW_BYTES = 1024 * 1024;

async function check(response: Response) {
  if (response.ok) return;
  const body = await response.json().catch(() => ({}));
  throw new Error(body.error || `读取文件失败 (${response.status})`);
}

/** Headers classify the file; text previews use a bounded byte range. */
export async function loadWorkspaceFile(projectId: string, path: string, signal: AbortSignal): Promise<WorkspaceFilePreview> {
  const url = fileContentUrl(projectId, path);
  const head = await fetch(url, { method: 'HEAD', signal, cache: 'no-cache' });
  await check(head);
  const mimeType = head.headers.get('content-type') ?? 'application/octet-stream';
  const file: WorkspaceFilePreview = { path, name: path.split('/').pop() || 'download',
    size: Number(head.headers.get('content-length') ?? 0), mimeType, kind: 'binary' };
  if (/^image\/(?:png|jpeg|gif|webp)(?:;|$)/i.test(mimeType)) { file.kind = 'image'; return file; }
  if (!mimeType.startsWith('text/')) return file;
  // Empty files have no satisfiable byte range.
  const response = await fetch(url, { signal, cache: 'no-cache',
    headers: file.size === 0 ? {} : { Range: `bytes=0-${MAX_PREVIEW_BYTES - 1}` } });
  await check(response);
  const total = response.headers.get('content-range')?.match(/\/(\d+)$/)?.[1];
  if (total) file.size = Number(total);
  else if (response.headers.has('content-length')) file.size = Number(response.headers.get('content-length'));
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  if (reader) {
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        const chunk = next.value.subarray(0, MAX_PREVIEW_BYTES - length);
        chunks.push(chunk); length += chunk.length;
        if (length === MAX_PREVIEW_BYTES) { await reader.cancel(); break; }
      }
    } finally { reader.releaseLock(); }
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  file.truncated = file.size > length;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: file.truncated });
    if (!/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)) { file.kind = 'text'; file.text = text; }
  } catch { /* Non-UTF-8 content remains available for download. */ }
  return file;
}
