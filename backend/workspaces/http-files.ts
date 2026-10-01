import { posix } from 'node:path';

/** Serve untrusted workspace bytes without permitting active same-origin content. */
export function workspaceFileResponse(upstream: Response, path: string, download = false): Response {
  const headers = new Headers();
  for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
    const value = upstream.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  headers.set('Cache-Control', 'private, no-cache');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Content-Security-Policy', "default-src 'none'; sandbox");
  // A 304 has no representation body; keep the cached MIME/disposition intact.
  if (upstream.status === 304) return new Response(null, { status: 304, headers });
  const mime = (headers.get('content-type') ?? 'application/octet-stream').split(';')[0].trim().toLowerCase();
  const text = !mime.startsWith('multipart/') && (mime.startsWith('text/') || ['application/json', 'application/javascript', 'application/xml', 'image/svg+xml'].includes(mime)
    || /\.(?:md|markdown|txt|log|csv|tsv|json|jsonl|yaml|yml|toml|ini|cfg|conf|sql|go|rs|py|js|jsx|ts|tsx|mjs|cjs|css|html|xml|svg|sh|bash|c|h|cpp|hpp|java|rb|php)$/i.test(path));
  const image = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(mime);
  const nativeViewer = !text && (mime === 'application/pdf' || mime.startsWith('audio/') || mime.startsWith('video/'));
  if (nativeViewer) {
    // Native PDF viewers cannot run in a sandboxed document; media documents
    // need permission to fetch their own URL (including subsequent ranges).
    headers.set('Content-Security-Policy', "default-src 'none'; object-src 'self'; media-src 'self' blob:; style-src 'unsafe-inline'; frame-ancestors 'none'");
  }
  if (text) headers.set('Content-Type', 'text/plain; charset=utf-8');
  const name = encodeURIComponent(posix.basename(path)).replace(/['()*]/g, value => `%${value.charCodeAt(0).toString(16).toUpperCase()}`);
  headers.set('Content-Disposition', `${!download && (text || image || nativeViewer) ? 'inline' : 'attachment'}; filename="download"; filename*=UTF-8''${name}`);
  return new Response(upstream.body, { status: upstream.status, headers });
}
