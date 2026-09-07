import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { Hono } from 'hono';
import { installProductionStatic } from '../server/static-files.js';

const html = '<!doctype html><script type="module" src="/assets/index-Abcd1234.js"></script>';
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'codex-static-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'assets'));
  await writeFile(join(root, 'index.html'), html);
  await writeFile(join(root, 'assets/index-Abcd1234.js'), 'console.log("fixture");');
  await writeFile(join(root, 'assets/index-Abcd1234.css'), 'body { color: red; }');
  await writeFile(join(root, 'assets/unhashed.js'), 'console.log("mutable");');
  const app = new Hono();
  app.get('/api/config', c => { c.header('Cache-Control', 'no-store'); return c.json({ available: true }); });
  app.all('/api/*', c => c.json({ error: 'missing endpoint' }, 404));
  installProductionStatic(app, root);
  return app;
}

test('missing old bundles and other static resources return 404 instead of the SPA HTML', async t => {
  const app = await fixture(t);
  for (const path of ['/assets/index-Oldh4sh9.js', '/assets/missing', '/missing.css', '/favicon.ico', '/missing%2Ejs']) {
    const response = await app.request(path, { headers: { accept: 'text/html' } });
    assert.equal(response.status, 404, path);
    assert.ok(!response.headers.get('content-type')?.includes('text/html'), path);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.notEqual(await response.text(), html);
  }
});

test('HTML is never cached, including index and actual SPA document navigation', async t => {
  const app = await fixture(t);
  for (const path of ['/', '/index.html', '/projects/example']) {
    const response = await app.request(path, { headers: { accept: 'text/html,application/xhtml+xml', 'sec-fetch-dest': 'document' } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.match(response.headers.get('content-type')!, /^text\/html/);
    assert.equal(await response.text(), html);
  }
  const head = await app.request('/index.html', { method: 'HEAD' });
  assert.equal(head.status, 200); assert.equal(head.headers.get('cache-control'), 'no-store'); assert.equal(await head.text(), '');
});

test('existing fingerprinted assets keep their MIME type and immutable caching', async t => {
  const app = await fixture(t);
  for (const [path, type, body] of [
    ['/assets/index-Abcd1234.js', 'text/javascript', 'console.log("fixture");'],
    ['/assets/index-Abcd1234.css', 'text/css', 'body { color: red; }'],
  ]) {
    const response = await app.request(path!);
    assert.equal(response.status, 200);
    assert.ok(response.headers.get('content-type')!.startsWith(type!));
    assert.equal(response.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(await response.text(), body);
  }
  const mutable = await app.request('/assets/unhashed.js');
  assert.equal(mutable.headers.get('cache-control'), 'no-store'); await mutable.text();
});

test('non-navigation requests and API requests do not receive the SPA shell', async t => {
  const app = await fixture(t);
  const nonNavigationHeaders: Record<string, string>[] = [
    { accept: '*/*' }, { accept: 'application/json' }, { accept: 'text/html;q=0' },
    { accept: 'text/html', 'sec-fetch-dest': 'script' },
  ];
  for (const headers of nonNavigationHeaders) assert.equal((await app.request('/missing', { headers })).status, 404);
  assert.equal((await app.request('/missing', { method: 'POST', headers: { accept: 'text/html' } })).status, 404);
  const api = await app.request('/api/config');
  assert.deepEqual(await api.json(), { available: true });
  assert.equal(api.headers.get('cache-control'), 'no-store');
  const missing = await app.request('/api/missing', { headers: { accept: 'text/html' } });
  assert.equal(missing.status, 404); assert.deepEqual(await missing.json(), { error: 'missing endpoint' });
});
