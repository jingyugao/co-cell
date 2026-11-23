import { posix } from 'node:path';
import { workspaceContentType, workspacePreviewKind } from '../../util/workspace-file-formats.js';

/** Serve untrusted workspace bytes without permitting active same-origin content. */
export function workspaceFileResponse(upstream: Response, path: string, download = false): Response {
  const headers = new Headers();
  for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified', 'x-cocell-file-source', 'x-cocell-backup-created-at']) {
    const value = upstream.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  headers.set('Cache-Control', 'private, no-cache');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Content-Security-Policy', "default-src 'none'; sandbox");
  // A 304 has no representation body; keep the cached MIME/disposition intact.
  if (upstream.status === 304) return new Response(null, { status: 304, headers });
  const upstreamType = headers.get('content-type');
  const mime = workspaceContentType(path, upstreamType);
  const kind = workspacePreviewKind(mime);
  const nativeViewer = mime === 'application/pdf' || kind === 'audio' || kind === 'video';
  if (nativeViewer) {
    // Native PDF viewers cannot run in a sandboxed document; media documents
    // need permission to fetch their own URL (including subsequent ranges).
    headers.set('Content-Security-Policy', "default-src 'none'; object-src 'self'; media-src 'self' blob:; style-src 'unsafe-inline'; frame-ancestors 'none'");
  }
  if (mime === 'image/svg+xml') {
    headers.set('Content-Security-Policy', "default-src 'none'; sandbox; style-src 'unsafe-inline'; img-src data:");
  }
  if (kind === 'text') headers.set('Content-Type', mime + '; charset=utf-8');
  else if (mime !== upstreamType?.split(';')[0].trim().toLowerCase()) headers.set('Content-Type', mime);
  const name = encodeURIComponent(posix.basename(path)).replace(/['()*]/g, value => `%${value.charCodeAt(0).toString(16).toUpperCase()}`);
  headers.set('Content-Disposition', `${!download && (kind === 'text' || kind === 'image' || nativeViewer) ? 'inline' : 'attachment'}; filename="download"; filename*=UTF-8''${name}`);
  return new Response(upstream.body, { status: upstream.status, headers });
}
