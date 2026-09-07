import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, type TestContext } from 'node:test';
import type { Thread, ThreadEvent } from '@openai/codex-sdk';
import { createApp } from '../server/app.js';
import { SessionManager, type CodexClient } from '../server/manager.js';
import type { E2BRuntime } from '../server/e2b.js';
import type { AppConfig, Session, Settings } from '../shared/types.js';

const completed: ThreadEvent = { type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, cache_write_input_tokens: 0, reasoning_output_tokens: 0 } };
async function fixture(t: TestContext, mode: Settings['executionMode'] = 'e2b', enabled = true) {
  const parent = fileURLToPath(new URL('../data/.tests/', import.meta.url)); await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, 'e2b-execution-policy-'));
  const defaults: Settings = { ...(mode ? { executionMode: mode } : {}), workingDirectory: mode === 'e2b' ? '/home/user/workspace' : directory, model: '', modelReasoningEffort: 'medium', sandboxMode: 'read-only', webSearchMode: 'disabled', networkAccessEnabled: false };
  const calls = { local: 0, remote: 0 };
  const thread = { runStreamed: async () => ({ events: (async function* () { yield completed; })() }) } as unknown as Thread;
  const client: CodexClient = { startThread: () => { calls.local++; return thread; }, resumeThread: () => { calls.local++; return thread; } };
  const runtime: E2BRuntime = {
    run: async function* () { calls.remote++; yield completed; }, close: async () => {}, delete: async () => {},
    changes: async () => ({ branch: 'main', files: [], diff: '' }),
    rawTools: async session => ({ source: 'codex-rollout', location: 'e2b', threadId: session.threadId, availability: 'pending', messages: [], nextCursor: 0, hasMore: false, skippedLines: 0 }),
  };
  const manager = new SessionManager(client, join(directory, 'sessions'), defaults, runtime);
  await manager.init();
  const config: AppConfig = { defaults, sdkVersion: 'test', auth: 'api-key', approvalPolicy: 'never', capabilities: { interactiveApprovals: false, tokenDeltas: false }, e2b: { enabled, template: 'test', workingDirectory: '/home/user/workspace' } };
  const app = createApp(manager, config, ['localhost:3001']);
  const request = (path: string, method = 'GET', body?: unknown) => app.request(`http://localhost:3001${path}`, { method, headers: { host: 'localhost:3001', ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  t.after(async () => { await manager.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, manager, config, calls, request, defaults };
}

test('E2B deployments reject explicit local creation while omitted settings inherit remote defaults', async t => {
  const { manager, request, calls } = await fixture(t);
  for (const input of [{}, { settings: {} }, { settings: { model: 'example' } }]) {
    const response = await request('/api/sessions', 'POST', input); assert.equal(response.status, 201);
    assert.equal((await response.json()).settings.executionMode, 'e2b');
  }
  for (const input of [{ settings: { executionMode: 'local' } }, { threadId: '00000000-0000-4000-8000-000000000001', settings: { executionMode: 'local' } }]) {
    const response = await request('/api/sessions', 'POST', input); assert.equal(response.status, 403);
    assert.match((await response.json()).error, /E2B.*本机会话仅供查看历史/);
  }
  assert.equal(manager.list().length, 3); assert.equal(calls.local, 0);
});

test('omitting executionMode cannot bypass E2B isolation through legacy defaults or a local project', async t => {
  for (const mode of ['local', undefined] as const) {
    const { manager, request, defaults, directory } = await fixture(t, mode);
    // Explicitly clear the optional field for a pre-executionMode legacy default.
    if (mode === undefined) delete defaults.executionMode;
    for (const input of [{}, { settings: {} }, { settings: { model: 'example' } }]) assert.equal((await request('/api/sessions', 'POST', input)).status, 403);
    const legacyProject = await manager.createProject({ name: 'Existing local project' }, { ...defaults, executionMode: 'local', workingDirectory: directory });
    assert.equal((await request('/api/sessions', 'POST', { projectId: legacyProject.id })).status, 403);
    assert.equal((await request('/api/sessions', 'POST', { projectId: legacyProject.id, settings: { executionMode: 'e2b' } })).status, 403);
    assert.equal(manager.list().length, 0);
  }
});

test('historical local sessions remain readable but cannot be updated, imported into a turn or executed', async t => {
  const { manager, request, directory, calls } = await fixture(t, 'local');
  const local = await manager.create({ title: 'Historical local task' });
  const stored = join(manager.dataDirectory, `${local.id}.json`); const before = await readFile(stored);
  assert.equal((await request(`/api/sessions/${local.id}`)).status, 200);
  assert.equal((await request('/api/sessions')).status, 200);
  for (const input of [{}, { title: 'Changed' }, { settings: {} }, { settings: { model: 'other' } }, { settings: { executionMode: 'e2b', workingDirectory: '/home/user/workspace' } }]) {
    assert.equal((await request(`/api/sessions/${local.id}`, 'PATCH', input)).status, 403);
  }
  assert.equal((await request(`/api/sessions/${local.id}/turns`, 'POST', { prompt: 'Read the host kubeconfig' })).status, 403);
  assert.equal((await request(`/api/sessions/${local.id}/images`, 'POST', {})).status, 403);
  assert.deepEqual(await readFile(stored), before);
  assert.equal(manager.get(local.id).turns.length, 0); assert.equal(calls.local, 0);
  assert.equal(manager.get(local.id).settings.workingDirectory, directory);
});

test('E2B sessions still update and execute remotely, but cannot switch to local via PATCH', async t => {
  const { request, manager, calls } = await fixture(t);
  const remote = await (await request('/api/sessions', 'POST', {})).json() as Session;
  assert.equal((await request(`/api/sessions/${remote.id}`, 'PATCH', { title: 'Remote renamed' })).status, 200);
  assert.equal((await request(`/api/sessions/${remote.id}`, 'PATCH', { settings: { executionMode: 'local' } })).status, 403);
  assert.equal((await request(`/api/sessions/${remote.id}/turns`, 'POST', { prompt: 'Remote work' })).status, 202);
  for (let attempt = 0; attempt < 50 && manager.get(remote.id).status === 'running'; attempt++) await new Promise(resolve => setTimeout(resolve, 2));
  await manager.stop(remote.id);
  assert.equal(calls.local, 0); assert.equal(calls.remote, 1);
  assert.equal(manager.get(remote.id).settings.executionMode, 'e2b');
});

test('local-only deployments preserve local creation, updates and execution', async t => {
  const { request, manager, calls } = await fixture(t, 'local', false);
  const response = await request('/api/sessions', 'POST', {}); assert.equal(response.status, 201);
  const session = await response.json() as Session;
  assert.equal((await request(`/api/sessions/${session.id}`, 'PATCH', { title: 'Local allowed' })).status, 200);
  assert.equal((await request(`/api/sessions/${session.id}/turns`, 'POST', { prompt: 'Local task' })).status, 202);
  for (let attempt = 0; attempt < 50 && manager.get(session.id).status === 'running'; attempt++) await new Promise(resolve => setTimeout(resolve, 2));
  assert.equal(calls.local, 1); assert.equal(calls.remote, 0);
});
