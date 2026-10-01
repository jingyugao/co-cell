import type { WorkspaceFileResult } from './files.js';

function attachmentName(name: string) {
  const encoded = encodeURIComponent(name).replace(/['()*]/g, value => `%${value.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="download"; filename*=UTF-8''${encoded}`;
}

/** Return an already-read bounded workspace file as a safe attachment. */
export function workspaceDownload(result: WorkspaceFileResult, head = false): Response {
  const { file, data } = result;
  const headers = new Headers({
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': attachmentName(file.name),
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'Content-Length': String(data.byteLength),
  });
  return new Response(head ? null : new Uint8Array(data), { status: 200, headers });
}
