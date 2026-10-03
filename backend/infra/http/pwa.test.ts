import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import { Hono } from 'hono';
import { PUBLIC_PWA_ASSETS } from '../../../util/pwa-assets.js';
import { installOperatorAccess } from '../../access/operator.js';
import { installPwaAssets } from './pwa.js';

const origin = 'https://cocell.example.test';

function setup() {
  const app = new Hono();
  installOperatorAccess(app, {
    publicUrl: origin, token: 'pwa-test-token-with-at-least-32-characters', projects: () => [],

  });
  installPwaAssets(app, resolve('public'));
  app.get('/', c => c.text('private workspace'));
  app.get('/api/config', c => c.json({ private: true }));
  return app;
}

test('installation resources are public only for same-host reads; workspace and API stay authenticated', async () => {
  const app = setup();
  for (const [path, { contentType }] of Object.entries(PUBLIC_PWA_ASSETS)) {
    const response = await app.request(`${origin}${path}`);
    assert.equal(response.status, 200, path);
    assert.equal(response.headers.get('content-type'), contentType, path);
    assert.equal(response.headers.get('cache-control'), 'no-cache');
    assert.equal(response.headers.get('set-cookie'), null);
    assert.equal((await app.request(`${origin}${path}`, { method: 'HEAD' })).status, 200);
    assert.equal((await app.request(`${origin}${path}`, { method: 'POST' })).status, 303);
    assert.equal((await app.request(`${origin}${path}`, { headers: { host: 'foreign.example.test' } })).status, 403);
  }
  assert.equal((await app.request(`${origin}/`)).status, 303);
  assert.equal((await app.request(`${origin}/api/config`)).status, 401);
  assert.equal((await app.request(`${origin}/assets/private.js`)).status, 303);
  assert.equal((await app.request(`${origin}/icons/private.png`)).status, 303);
  const worker = await app.request(`${origin}/sw.js`);
  assert.equal(worker.headers.get('service-worker-allowed'), '/');
});

test('manifest icons have their declared PNG dimensions and login exposes the same manifest', async () => {
  const app = setup();
  const manifest = await (await app.request(`${origin}/manifest.webmanifest`)).json();
  assert.equal(manifest.name, 'CoCell');
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.start_url, '/');
  for (const icon of [...manifest.icons, { src: '/icons/apple-touch-icon.png', sizes: '180x180' }]) {
    const response = await app.request(`${origin}${icon.src}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.equal(`${bytes.readUInt32BE(16)}x${bytes.readUInt32BE(20)}`, icon.sizes);
  }
  const login = await app.request(`${origin}/auth/login`);
  assert.match(await login.text(), /rel="manifest" href="\/manifest.webmanifest"/);
});
