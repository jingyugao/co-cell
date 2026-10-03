import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Hono } from 'hono';
import { PUBLIC_PWA_ASSETS } from '../../../util/pwa-assets.js';

export function installPwaAssets(app: Hono, directory = resolve(process.env.NODE_ENV === 'production' ? 'dist' : 'public')) {
  for (const [path, asset] of Object.entries(PUBLIC_PWA_ASSETS)) {
    app.on(['GET', 'HEAD'], path, async c => {
      let body: Uint8Array<ArrayBuffer>;
      try { body = new Uint8Array(await readFile(resolve(directory, asset.file))); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return c.notFound();
        throw error;
      }
      c.header('Cache-Control', 'no-cache');
      c.header('X-Content-Type-Options', 'nosniff');
      if (path === '/sw.js') c.header('Service-Worker-Allowed', '/');
      if (path === '/offline.html') c.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
      return c.body(body, 200, { 'Content-Type': asset.contentType });
    });
  }
}
