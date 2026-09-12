import { HttpError } from '../core/errors.js';
import type { WorkspaceFileReadOptions, WorkspaceFileResult } from './files.js';

const CHUNK_BYTES = 1024 * 1024;

// Ignore unsupported/malformed ranges; valid ranges outside the file get 416.
function byteRange(value: string, size: number): { start: number; end: number } | 'unsatisfiable' | undefined {
  const match = /^bytes=(\d*)-(\d*)$/i.exec(value.trim());
  if (!match || (!match[1] && !match[2])) return;
  const first = match[1] ? Number(match[1]) : undefined;
  const last = match[2] ? Number(match[2]) : undefined;
  if ((first !== undefined && !Number.isSafeInteger(first)) || (last !== undefined && !Number.isSafeInteger(last))) return;
  if (first !== undefined && last !== undefined && last < first) return;
  if (!size || (first !== undefined && first >= size) || (first === undefined && last === 0)) return 'unsatisfiable';
  return first === undefined
    ? { start: Math.max(0, size - last!), end: size - 1 }
    : { start: first, end: Math.min(last ?? size - 1, size - 1) };
}

export async function workspaceDownload(
  read: (options: WorkspaceFileReadOptions) => Promise<WorkspaceFileResult>,
  range?: string,
  ifRange?: string,
  head = false,
): Promise<Response> {
  const { file, version } = await read({ metadataOnly: true });
  if (!version || !/^[\w.-]+$/.test(version)) throw new HttpError(502, '沙箱文件版本无效');
  const etag = `"${version}"`;
  const headers = new Headers({
    'Accept-Ranges': 'bytes',
    'ETag': etag,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(file.name).replace(/['()*]/g, value => `%${value.charCodeAt(0).toString(16).toUpperCase()}`)}`,
    'Content-Security-Policy': "default-src 'none'; sandbox",
  });
  const selected = !head && range && (!ifRange || ifRange === etag) ? byteRange(range, file.size) : undefined;
  if (selected === 'unsatisfiable') {
    headers.set('Content-Range', `bytes */${file.size}`);
    headers.set('Content-Length', '0');
    return new Response(null, { status: 416, headers });
  }
  const start = selected ? selected.start : 0;
  const end = selected ? selected.end : file.size - 1;
  const length = Math.max(0, end - start + 1);
  headers.set('Content-Length', String(length));
  if (selected) headers.set('Content-Range', `bytes ${start}-${end}/${file.size}`);
  const status = selected ? 206 : 200;
  if (head || !length) return new Response(null, { status, headers });

  let offset = start;
  let cancelled = false;
  const next = async () => {
    const length = Math.min(CHUNK_BYTES, end - offset + 1);
    const result = await read({ offset, length, version });
    if (result.version !== version || result.file.size !== file.size || result.data.length !== length) {
      throw new HttpError(409, '文件已变更或读取不完整，请重新下载');
    }
    offset += length;
    return new Uint8Array(result.data);
  };
  // Validate the first chunk before sending headers; later failures abort the
  // response so clients never mistake a truncated or changed file for success.
  const first = await next();
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(first); if (offset > end) controller.close(); },
    async pull(controller) {
      try {
        const chunk = await next();
        if (cancelled) return;
        controller.enqueue(chunk);
        if (offset > end) controller.close();
      } catch (error) { if (!cancelled) controller.error(error); }
    },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  return new Response(body, { status, headers });
}
