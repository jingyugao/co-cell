import { readFile } from 'node:fs/promises';
import { basename, extname, resolve } from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import type { Hono } from 'hono';

export function installProductionStatic(app: Hono, directory = resolve('dist')) {
  const root = resolve(directory);
  const staticFiles = serveStatic({ root, precompressed: true });
  app.use('*', async (c, next) => {
    if (c.req.path === '/api' || c.req.path.startsWith('/api/') || !['GET', 'HEAD'].includes(c.req.method)) return next();
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Cache-Control', 'no-store');
    const hashedAsset = c.req.path.startsWith('/assets/')
      && /-[A-Za-z0-9_-]{8,}\.[a-z0-9]+(?:\.map)?$/i.test(basename(c.req.path));
    const scriptOrStylesheet = /\.(?:js|css)$/i.test(basename(c.req.path));
    const requestHeaders = c.req.raw.headers;
    const originalAcceptEncoding = requestHeaders.get('Accept-Encoding');
    if (scriptOrStylesheet) {
      const accepted = preferredStaticEncoding(originalAcceptEncoding);
      if (accepted) requestHeaders.set('Accept-Encoding', accepted);
      else requestHeaders.delete('Accept-Encoding');
    }
    let response: Response | void;
    try { response = await staticFiles(c, next); }
    finally {
      if (scriptOrStylesheet) {
        if (originalAcceptEncoding === null) requestHeaders.delete('Accept-Encoding');
        else requestHeaders.set('Accept-Encoding', originalAcceptEncoding);
      }
    }
    if (response instanceof Response && response.status < 400 && hashedAsset
      && !response.headers.get('Content-Type')?.includes('text/html')) {
      response.headers.set('Cache-Control', 'public, max-age=31536000, immutable');
    }
    if (response instanceof Response && response.status < 400 && scriptOrStylesheet) {
      appendVary(response.headers, 'Accept-Encoding');
    }
    return response;
  });
  app.get('*', async c => {
    let path: string;
    try { path = decodeURIComponent(c.req.path); } catch { return c.notFound(); }
    // API endpoints and paths with a file extension must retain an actual
    // 404 response. Extensionless paths are client-side routes; serve the SPA
    // shell even when a reverse proxy or a direct curl omits browser headers.
    if (path === '/api' || path.startsWith('/api/') || path === '/assets' || path.startsWith('/assets/')
      || extname(path)) return c.notFound();
    c.header('Cache-Control', 'no-store');
    c.header('X-Content-Type-Options', 'nosniff');
    return c.html(await readFile(resolve(root, 'index.html'), 'utf8'));
  });
}

function preferredStaticEncoding(header: string | null): 'br' | 'gzip' | undefined {
  if (!header) return;
  const qualities = new Map<string, number>();
  for (const member of header.split(',')) {
    const [rawToken, ...parameters] = member.trim().split(';');
    const token = rawToken.trim().toLowerCase();
    if (!token) continue;
    let quality = 1;
    for (const parameter of parameters) {
      const match = /^\s*q\s*=\s*(.*?)\s*$/i.exec(parameter);
      if (!match) { quality = 0; break; }
      const rawQuality = match[1];
      if (!/^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(rawQuality)) { quality = 0; break; }
      quality = Number(rawQuality);
    }
    const previous = qualities.get(token);
    qualities.set(token, previous === 0 || quality === 0 ? 0 : Math.max(previous ?? 0, quality));
  }
  const wildcard = qualities.get('*') ?? 0;
  const brotli = qualities.get('br') ?? wildcard;
  const gzip = qualities.get('gzip') ?? wildcard;
  if (brotli <= 0 && gzip <= 0) return;
  return brotli >= gzip ? 'br' : 'gzip';
}

function appendVary(headers: Headers, name: string) {
  const value = headers.get('Vary');
  if (value === '*') return;
  const values = (value ?? '').split(',').map(item => item.trim()).filter(Boolean);
  if (!values.some(item => item.toLowerCase() === name.toLowerCase())) values.push(name);
  headers.set('Vary', values.join(', '));
}
