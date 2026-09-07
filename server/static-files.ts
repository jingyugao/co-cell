import { readFile } from 'node:fs/promises';
import { basename, extname, resolve } from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import type { Hono } from 'hono';

export function installProductionStatic(app: Hono, directory = resolve('dist')) {
  const root = resolve(directory);
  const staticFiles = serveStatic({ root });
  app.use('*', async (c, next) => {
    if (c.req.path === '/api' || c.req.path.startsWith('/api/') || !['GET', 'HEAD'].includes(c.req.method)) return next();
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Cache-Control', 'no-store');
    const response = await staticFiles(c, next);
    const hashedAsset = c.req.path.startsWith('/assets/')
      && /-[A-Za-z0-9_-]{8,}\.[a-z0-9]+(?:\.map)?$/i.test(basename(c.req.path));
    if (response instanceof Response && response.status < 400 && hashedAsset
      && !response.headers.get('Content-Type')?.includes('text/html')) {
      response.headers.set('Cache-Control', 'public, max-age=31536000, immutable');
    }
    return response;
  });
  app.get('*', async c => {
    let path: string;
    try { path = decodeURIComponent(c.req.path); } catch { return c.notFound(); }
    const destination = c.req.header('Sec-Fetch-Dest');
    const acceptsHtml = (c.req.header('Accept') ?? '').split(',').some(value => {
      const [mime, ...parameters] = value.trim().toLowerCase().split(';');
      return mime === 'text/html' && !parameters.some(parameter => /^\s*q\s*=\s*0(?:\.0*)?\s*$/.test(parameter));
    });
    // Only browser document navigation gets the SPA shell. Missing bundles,
    // styles, images and API endpoints must retain an actual 404 response.
    if (path === '/api' || path.startsWith('/api/') || path === '/assets' || path.startsWith('/assets/')
      || extname(path) || !acceptsHtml || (destination && !['document', 'iframe'].includes(destination))) return c.notFound();
    c.header('Cache-Control', 'no-store');
    c.header('X-Content-Type-Options', 'nosniff');
    return c.html(await readFile(resolve(root, 'index.html'), 'utf8'));
  });
}
