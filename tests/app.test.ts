import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import type { Thread } from '@openai/codex-sdk';
import { createApp } from '../server/app.js';
import { SessionManager, type CodexClient } from '../server/manager.js';
import type { AppConfig, Session } from '../shared/types.js';

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'codex-web-api-test-'));
  const config: AppConfig = {
    defaults: {
      workingDirectory: directory, model: '', modelReasoningEffort: 'high',
      sandboxMode: 'read-only', webSearchMode: 'disabled', networkAccessEnabled: false,
    },
    sdkVersion: 'test', auth: 'local-codex', approvalPolicy: 'never',
    capabilities: { interactiveApprovals: false, tokenDeltas: false },
  };
  const thread = {
    runStreamed: async () => ({ events: (async function* () {
      yield { type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, cache_write_input_tokens: 0, reasoning_output_tokens: 0 } };
    })() }),
  } as unknown as Thread;
  const client: CodexClient = { startThread: () => thread, resumeThread: () => thread };
  const manager = new SessionManager(client, join(directory, 'sessions'), config.defaults);
  await manager.init();
  t.after(async () => { await manager.close(); await rm(directory, { recursive: true, force: true }); });
  const app = createApp(manager, config, ['localhost:3001']);
  const request = (path: string, init: RequestInit = {}) => app.request(`http://localhost:3001${path}`, {
    ...init, headers: { host: 'localhost:3001', ...init.headers },
  });
  const json = (path: string, method: string, body: unknown) => request(path, {
    method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { app, manager, request, json };
}

test('API accepts localhost and rejects foreign hosts or origins before handling requests', async t => {
  const { app, request } = await fixture(t);
  assert.equal((await app.request('http://localhost:3001/api/config')).status, 403);
  assert.equal((await request('/api/config', { headers: { host: 'attacker.example' } })).status, 403);
  assert.equal((await request('/api/config', { headers: { origin: 'https://attacker.example' } })).status, 403);
  assert.equal((await request('/api/config', { headers: { origin: 'http://localhost:3001.attacker.example' } })).status, 403);
  const accepted = await request('/api/config', { headers: { origin: 'http://localhost:3001' } });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.headers.get('cache-control'), 'no-store');
  assert.equal(accepted.headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await accepted.json()).approvalPolicy, 'never');
});

test('invalid JSON and unsupported settings are rejected without creating sessions', async t => {
  const { request, json, manager } = await fixture(t);
  const malformed = await request('/api/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' });
  assert.equal(malformed.status, 400);
  assert.match((await malformed.json()).error, /JSON/);
  for (const input of [
    { settings: { sandboxMode: 'unrestricted' } },
    { settings: { approvalPolicy: 'on-request' } },
    { settings: { networkAccessEnabled: 'true' } },
    { threadId: 'not-a-thread-uuid' },
    { title: '   ' },
  ]) assert.equal((await json('/api/sessions', 'POST', input)).status, 400);
  assert.equal(manager.list().length, 0);
  const session = await manager.create();
  assert.equal((await json(`/api/sessions/${session.id}/turns`, 'POST', { prompt: ' ' })).status, 400);
  assert.equal(manager.get(session.id).turns.length, 0);
});

test('session API creates, fetches, updates and deletes state, with missing resources returning 404', async t => {
  const { request, json } = await fixture(t);
  const created = await json('/api/sessions', 'POST', { title: 'Demo', settings: { model: 'demo-model' } });
  assert.equal(created.status, 201);
  const session = await created.json() as Session;
  assert.equal(session.settings.model, 'demo-model');
  assert.equal(session.status, 'idle');
  assert.equal((await (await request(`/api/sessions/${session.id}`)).json()).id, session.id);
  const updated = await json(`/api/sessions/${session.id}`, 'PATCH', { title: 'Renamed', settings: { webSearchMode: 'cached' } });
  assert.equal(updated.status, 200);
  const value = await updated.json() as Session;
  assert.equal(value.title, 'Renamed');
  assert.equal(value.settings.webSearchMode, 'cached');
  assert.equal(value.settings.model, 'demo-model');
  const list = await (await request('/api/sessions')).json();
  assert.equal(list[0].turnCount, 0);
  assert.equal('turns' in list[0], false);
  assert.equal((await request(`/api/sessions/${session.id}`, { method: 'DELETE' })).status, 200);
  for (const path of [`/api/sessions/${session.id}`, '/api/sessions/missing/events', '/api/missing']) {
    const response = await request(path);
    assert.equal(response.status, 404);
    assert.equal(typeof (await response.json()).error, 'string');
  }
});

test('raw-tool API validates session ownership and byte cursors before reading the native log', async t => {
  const { manager, request } = await fixture(t);
  const session = await manager.create();
  const response = await request(`/api/sessions/${session.id}/raw-tools`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).availability, 'pending');
  assert.equal((await request('/api/sessions/missing/raw-tools')).status, 404);
  for (const cursor of ['-1', '1.5', 'not-a-number', '9007199254740992']) {
    assert.equal((await request(`/api/sessions/${session.id}/raw-tools?cursor=${cursor}`)).status, 400);
  }
});

test('image upload validates bytes and uploaded images remain isolated to their session', async t => {
  const { request, json, manager } = await fixture(t);
  const first = await manager.create();
  const second = await manager.create();
  const upload = (bytes: Uint8Array<ArrayBuffer>, name: string) => {
    const form = new FormData();
    form.set('image', new File([bytes], name, { type: 'image/png' }));
    return request(`/api/sessions/${first.id}/images`, { method: 'POST', body: form });
  };
  assert.equal((await upload(new Uint8Array(), 'empty.png')).status, 400);
  assert.equal((await upload(new TextEncoder().encode('<script>not an image</script>'), 'fake.png')).status, 400);
  const png = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aBzQAAAAASUVORK5CYII=', 'base64'));
  const uploaded = await upload(png, '../../image.png');
  assert.equal(uploaded.status, 201);
  const { path } = await uploaded.json();
  assert.ok(path.startsWith(join(manager.dataDirectory, 'images', first.id)));
  assert.equal((await json(`/api/sessions/${second.id}/turns`, 'POST', { prompt: 'Read', images: [path] })).status, 400);
  assert.equal(manager.get(second.id).turns.length, 0);
  assert.equal((await json(`/api/sessions/${first.id}/turns`, 'POST', { prompt: 'Read', images: [path] })).status, 202);
  await manager.waitForIdle(first.id);
  assert.equal(manager.get(first.id).status, 'completed');
});

test('SSE immediately sends a snapshot and subsequent state updates, and its reader can disconnect', async t => {
  const { request, manager } = await fixture(t);
  const session = await manager.create({ title: 'Initial' });
  const controller = new AbortController();
  const response = await request(`/api/sessions/${session.id}/events`, { signal: controller.signal });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
  const reader = response.body!.getReader();
  const readEvent = async () => {
    const chunk = await reader.read();
    assert.equal(chunk.done, false);
    return JSON.parse(new TextDecoder().decode(chunk.value).trim().replace(/^data: */, ''));
  };
  try {
    const initial = await readEvent();
    assert.equal(initial.type, 'snapshot');
    assert.equal(initial.session.id, session.id);
    await manager.update(session.id, { title: 'Updated' });
    const update = await readEvent();
    assert.equal(update.type, 'state');
    assert.equal(update.session.title, 'Updated');
  } finally {
    controller.abort();
    await reader.cancel();
  }
  await manager.update(session.id, { title: 'After disconnect' });
  assert.equal(manager.get(session.id).title, 'After disconnect');
});
