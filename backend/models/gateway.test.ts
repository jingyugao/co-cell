import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { Hono } from 'hono';
import { ModelGateway, installModelGateway } from './gateway.js';
import { SecretCrypto } from '../secrets/crypto.js';
import type { ModelService, ModelSelection } from './service.js';
import type { ModelRuntimeRepository } from './runtime-repository.js';
import type { Session } from '../../protocol/types.js';

const crypto = new SecretCrypto(Buffer.alloc(32, 17).toString('base64'));
const session = (id: string) => ({ id, settings: { model: 'same-model' } }) as Session;
function memory() {
  const values = new Map<string, string>();
  const repository: ModelRuntimeRepository = { init: async () => {}, save: async (id, value) => { values.set(id, value); },
    load: async id => values.get(id), delete: async id => { values.delete(id); } };
  return { repository, values };
}
function credentials(options: Awaited<ReturnType<ModelGateway['threadOptions']>>) {
  const config = Object.values(options.providerConfig!)[0] as { base_url: string; experimental_bearer_token: string };
  return { url: `${config.base_url}/responses`, headers: { authorization: `Bearer ${config.experimental_bearer_token}`, 'content-type': 'application/json' } };
}

test('session gateway snapshots isolate channels and refresh routes without changing loaded thread credentials', async t => {
  const requests: Array<{ path: string; authorization?: string; body: string }> = [];
  const upstream = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    requests.push({ path: req.url!, authorization: req.headers.authorization, body: Buffer.concat(chunks).toString() });
    res.setHeader('Content-Type', 'text/event-stream'); res.end('data: {"type":"response.completed"}\n\n');
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => { upstream.closeAllConnections(); upstream.close(() => resolve()); }));
  const root = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
  let current: ModelSelection = { model: 'same-model', modelEntryId: 'a-model', channelId: 'a', endpoint: `${root}/a`, apiKey: 'key-a' };
  const service = { selection: async () => ({ ...current }) } as unknown as ModelService;
  const { repository, values } = memory();
  const first = new ModelGateway(service, crypto, 'http://web', repository);
  const otherInstance = new ModelGateway(service, crypto, 'http://web', repository);
  const app = new Hono(); installModelGateway(app, otherInstance);
  app.all('*', c => c.json({ error: 'operator authentication required' }, 403));
  const a = credentials(await first.threadOptions(session('session-a')));
  current = { ...current, endpoint: `${root}/b`, apiKey: 'key-b', channelId: 'b' };
  const b = credentials(await first.threadOptions(session('session-b')));
  const send = (config: typeof a) => app.request(config.url, { method: 'POST', headers: config.headers, body: '{"model":"same-model","stream":true}' });
  const responses = await Promise.all([send(a), send(b)]);
  assert.deepEqual(responses.map(response => response.status), [200, 200]);
  for (const response of responses) assert.match(await response.text(), /response.completed/);
  assert.deepEqual(requests.map(request => [request.path, request.authorization]), [['/a/responses', 'Bearer key-a'], ['/b/responses', 'Bearer key-b']]);
  assert.equal([...values.values()].some(value => value.includes('key-a') || value.includes('key-b')), false);
  // A catalog change alone must not affect an already running session.
  current = { ...current, endpoint: `${root}/c`, apiKey: 'key-c' };
  await (await send(a)).text();
  assert.equal(requests.at(-1)?.path, '/a/responses');
  const next = credentials(await first.threadOptions(session('session-a')));
  assert.equal(next.url, a.url);
  // App Server retains the first token across resumes; it must see the new route.
  await (await send(a)).text();
  assert.equal(requests.at(-1)?.path, '/c/responses');
  assert.equal(requests.at(-1)?.authorization, 'Bearer key-c');
  assert.equal((await app.request(b.url, { method: 'POST', headers: a.headers, body: '{}' })).status, 401);
  assert.equal((await app.request(a.url, { method: 'POST', headers: { ...a.headers, origin: 'https://evil.test' }, body: '{}' })).status, 403);
  assert.equal((await app.request(a.url.replace('/responses', '/files'), { headers: a.headers })).status, 404);
  await repository.delete('session-a');
  assert.equal((await send(a)).status, 401);
});

test('gateway rejects expired grants and sanitizes upstream errors and redirects', async t => {
  const upstream = createServer((req, res) => {
    res.statusCode = req.url?.startsWith('/redirect') ? 302 : 401;
    res.setHeader('Location', 'http://elsewhere.invalid');
    res.end('upstream-secret-key and private diagnostic text');
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => { upstream.closeAllConnections(); upstream.close(() => resolve()); }));
  const root = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
  let endpoint = root;
  const service = { selection: async () => ({ model: 'm', channelId: 'a', endpoint, apiKey: 'upstream-secret-key' }) } as unknown as ModelService;
  const { repository } = memory();
  const gateway = new ModelGateway(service, crypto, 'http://web', repository);
  const config = credentials(await gateway.threadOptions(session('s')));
  const request = () => new Request(config.url, { method: 'POST', headers: config.headers, body: '{}' });
  const failed = await gateway.forward(request(), 's', 'responses');
  assert.equal(failed.status, 401);
  assert.doesNotMatch(await failed.text(), /upstream-secret-key|private diagnostic/);
  endpoint = `${root}/redirect`;
  await gateway.threadOptions(session('s'));
  assert.equal((await gateway.forward(request(), 's', 'responses')).status, 502);
  await repository.save('s', crypto.seal('s', 'model-runtime-snapshot-v1', Buffer.from(JSON.stringify({ endpoint, apiKey: 'x', expiresAt: 1 }))));
  assert.equal((await gateway.forward(request(), 's', 'responses')).status, 401);
});
