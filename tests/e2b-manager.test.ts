import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import type { ThreadEvent } from '@openai/codex-sdk';
import { createApp } from '../server/app.js';
import { HttpError, SessionManager, type CodexClient } from '../server/manager.js';
import type { E2BRuntime } from '../server/e2b.js';
import type { RawToolReader } from '../server/raw-tools.js';
import type { AgentEvent, AppConfig, Changes, RawToolPage, Session, Settings, StreamMessage, Turn } from '../shared/types.js';

const completed: ThreadEvent = {
  type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, cache_write_input_tokens: 0, reasoning_output_tokens: 0 },
};
const sandbox: NonNullable<Session['sandbox']> = {
  id: 'owned-e2b-sandbox', status: 'ready', template: 'base', workingDirectory: '/home/user/workspace',
};
type Run = (session: Session, turn: Turn, signal: AbortSignal, update: (sandbox: NonNullable<Session['sandbox']>) => Promise<void>) => AsyncGenerator<AgentEvent>;
const unexpectedLocalClient: CodexClient = {
  startThread: () => { throw new Error('E2B task must not start the local Codex'); },
  resumeThread: () => { throw new Error('E2B task must not resume the local Codex'); },
};
function fakeRuntime(run: Run = async function* () { yield completed; }) {
  return {
    run,
    delete: async (_session: Session) => {},
    close: async () => {},
    changes: async (_session: Session): Promise<Changes> => ({ branch: 'remote', files: [], diff: '' }),
    rawTools: async (session: Session, cursor = 0): Promise<RawToolPage> => ({
      source: 'codex-rollout', location: 'e2b', threadId: session.threadId, availability: 'pending',
      messages: [], nextCursor: cursor, hasMore: false, skippedLines: 0,
    }),
  } satisfies E2BRuntime;
}
async function fixture(t: TestContext, runtime = fakeRuntime()) {
  const directory = await mkdtemp(join(tmpdir(), 'codex-e2b-manager-test-'));
  const defaults: Settings = {
    executionMode: 'e2b', workingDirectory: '/home/user/workspace', model: '', modelReasoningEffort: 'medium',
    sandboxMode: 'workspace-write', webSearchMode: 'disabled', networkAccessEnabled: false,
  };
  const manager = new SessionManager(unexpectedLocalClient, join(directory, 'sessions'), defaults, runtime);
  await manager.init();
  t.after(async () => { await manager.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, defaults, manager, runtime };
}
const status = (expected: number) => (error: unknown) => error instanceof HttpError && error.status === expected;
const stored = (manager: SessionManager, id: string): Promise<Session> => readFile(join(manager.dataDirectory, `${id}.json`), 'utf8').then(JSON.parse);

test('E2B creates, settings updates and turns always use full access with network enabled', async t => {
  const received: Settings[] = [];
  const { manager } = await fixture(t, fakeRuntime(async function* (session) {
    received.push(structuredClone(session.settings)); yield completed;
  }));
  const session = await manager.create({ settings: { sandboxMode: 'workspace-write', networkAccessEnabled: false } });
  assert.equal(session.settings.sandboxMode, 'danger-full-access');
  assert.equal(session.settings.networkAccessEnabled, true);
  const updated = await manager.update(session.id, { settings: { sandboxMode: 'read-only', networkAccessEnabled: false } });
  assert.equal(updated.settings.sandboxMode, 'danger-full-access');
  assert.equal(updated.settings.networkAccessEnabled, true);
  await manager.startTurn(session.id, 'Use default toolchain cache'); await manager.waitForIdle(session.id);
  assert.equal(received[0].sandboxMode, 'danger-full-access');
  assert.equal(received[0].networkAccessEnabled, true);
  assert.equal((await stored(manager, session.id)).settings.sandboxMode, 'danger-full-access');
});

test('restart migrates persisted E2B restrictions without changing local settings or thread history', async t => {
  const { manager, defaults, directory } = await fixture(t);
  const remote = await manager.create();
  const local = await manager.create({ settings: { executionMode: 'local', workingDirectory: directory, sandboxMode: 'read-only', networkAccessEnabled: false } });
  await manager.startTurn(remote.id, 'Existing completed turn'); await manager.waitForIdle(remote.id);
  await manager.close();
  const legacy = await stored(manager, remote.id);
  legacy.settings.sandboxMode = 'workspace-write'; legacy.settings.networkAccessEnabled = false;
  legacy.threadId = 'existing-remote-thread';
  await writeFile(join(manager.dataDirectory, `${remote.id}.json`), JSON.stringify(legacy));
  const resumed: string[] = [];
  const restored = new SessionManager(unexpectedLocalClient, manager.dataDirectory, defaults, fakeRuntime(async function* (session) {
    resumed.push(session.threadId!);
    assert.equal(session.settings.sandboxMode, 'danger-full-access'); assert.equal(session.settings.networkAccessEnabled, true);
    yield completed;
  }));
  await restored.init(); t.after(() => restored.close());
  const migrated = await stored(restored, remote.id);
  assert.equal(migrated.settings.sandboxMode, 'danger-full-access'); assert.equal(migrated.settings.networkAccessEnabled, true);
  assert.equal(migrated.threadId, legacy.threadId); assert.deepEqual(migrated.turns, legacy.turns);
  assert.deepEqual((await stored(restored, local.id)).settings, local.settings);
  await restored.startTurn(remote.id, 'Continue original thread'); await restored.waitForIdle(remote.id);
  assert.deepEqual(resumed, ['existing-remote-thread']);
});

// These paths intentionally do not exist on the host: creation must validate
// remote path syntax without resolving or creating the corresponding host path.
test('E2B settings validate remote paths and keep the execution environment immutable', async t => {
  const { manager, directory, defaults } = await fixture(t);
  const remotePath = `/home/user/nonexistent-${directory.split('/').at(-1)}/a/../workspace`;
  const session = await manager.create({ settings: { workingDirectory: remotePath } });
  assert.equal(session.settings.workingDirectory, remotePath.replace('/a/..', ''));
  await assert.rejects(stat(session.settings.workingDirectory), (error: NodeJS.ErrnoException) => error.code === 'ENOENT');
  for (const path of ['relative', '/tmp/workspace', '/home/user', '/home/user/../../tmp/work', '/home/user/.codex', '/home/user/.codex-web/runtime', '/home/user/work\0space']) {
    await assert.rejects(manager.create({ settings: { workingDirectory: path } }), status(400));
  }
  await assert.rejects(manager.update(session.id, { settings: { executionMode: 'local', workingDirectory: directory } }), status(400));
  await assert.rejects(manager.create({ threadId: 'local-thread-id' }), status(400));
  const local = await manager.create({ settings: { executionMode: 'local', workingDirectory: directory } });
  await assert.rejects(manager.update(local.id, { settings: { executionMode: 'e2b', workingDirectory: '/home/user/workspace' } }), status(400));
  const unconfigured = new SessionManager(unexpectedLocalClient, join(directory, 'unconfigured'), defaults);
  await unconfigured.init();
  t.after(() => unconfigured.close());
  await assert.rejects(unconfigured.create(), status(400));
});

test('E2B execution persists sandbox callbacks and SDK thread IDs for a reconstructed manager', async t => {
  let manager!: SessionManager;
  let callbackPersisted = false;
  const runtime = fakeRuntime(async function* (session, _turn, _signal, update) {
    assert.equal(session.threadId, null);
    await update(sandbox);
    assert.deepEqual((await stored(manager, session.id)).sandbox, sandbox);
    callbackPersisted = true;
    yield { type: 'thread.started', thread_id: 'remote-sdk-thread' };
    yield { type: 'item.completed', item: { type: 'agent_message', id: 'remote-answer', text: 'remote result' } };
    yield completed;
    await update({ ...sandbox, status: 'paused' });
  });
  const f = await fixture(t, runtime);
  manager = f.manager;
  const session = await manager.create();
  await manager.startTurn(session.id, 'Remote first turn');
  await manager.waitForIdle(session.id);
  assert.equal(callbackPersisted, true);
  assert.equal(manager.get(session.id).status, 'completed');
  await manager.close();
  let resumed: Session | undefined;
  const secondRuntime = fakeRuntime(async function* (session) { resumed = structuredClone(session); yield completed; });
  const restarted = new SessionManager(unexpectedLocalClient, manager.dataDirectory, f.defaults, secondRuntime);
  t.after(() => restarted.close());
  await restarted.init();
  await restarted.startTurn(session.id, 'Remote continuation');
  await restarted.waitForIdle(session.id);
  assert.equal(resumed?.threadId, 'remote-sdk-thread');
  assert.deepEqual(resumed?.sandbox, { ...sandbox, status: 'paused' });
  const history = await stored(restarted, session.id);
  assert.equal(history.turns.length, 2);
  assert.equal(history.threadId, 'remote-sdk-thread');
  assert.equal(history.turns[1].status, 'completed');
});

test('stopping an E2B turn aborts the runtime signal and waits for remote cleanup', async t => {
  let observed: AbortSignal | undefined;
  let cleaned = false;
  const runtime = fakeRuntime(async function* (_session, _turn, signal) {
    observed = signal;
    if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
    await new Promise<void>(resolve => setImmediate(resolve));
    cleaned = true;
    throw new Error('Remote process cancelled');
  });
  const { manager } = await fixture(t, runtime);
  const session = await manager.create();
  await manager.startTurn(session.id, 'Long remote command');
  await manager.stop(session.id);
  assert.equal(observed?.aborted, true);
  assert.equal(cleaned, true);
  assert.equal(manager.get(session.id).status, 'cancelled');
  assert.equal(manager.get(session.id).turns[0].error, undefined);
});

test('E2B project deletion removes only its sandbox before history and preserves history if deletion fails', async t => {
  const runtime = fakeRuntime(async function* (_session, _turn, _signal, update) { await update(sandbox); yield completed; });
  const { manager } = await fixture(t, runtime);
  const session = await manager.create();
  const other = await manager.create();
  await manager.startTurn(session.id, 'Create remote sandbox');
  await manager.waitForIdle(session.id);
  let deletionAttempts = 0;
  runtime.delete = async candidate => {
    deletionAttempts++;
    assert.equal(candidate.id, session.id);
    assert.equal(candidate.sandbox?.id, sandbox.id);
    assert.equal((await stored(manager, session.id)).id, session.id, 'local history must still exist while deleting sandbox');
    if (deletionAttempts === 1) throw new Error('E2B endpoint unavailable');
  };
  await assert.rejects(manager.deleteProject(session.projectId!), /E2B endpoint unavailable/);
  assert.equal(manager.get(session.id).id, session.id);
  assert.equal((await stored(manager, session.id)).sandbox?.id, sandbox.id);
  await manager.deleteProject(session.projectId!);
  assert.equal(deletionAttempts, 2);
  assert.throws(() => manager.get(session.id), status(404));
  await assert.rejects(stored(manager, session.id), (error: NodeJS.ErrnoException) => error.code === 'ENOENT');
  assert.equal(manager.get(other.id).id, other.id);
  await manager.delete(other.id);
  assert.equal(deletionAttempts, 2, 'never delete a sandbox for a session that has not created one');
});

test('E2B attachments are checked against host ownership before being handed to the runtime', async t => {
  const received: string[][] = [];
  const runtime = fakeRuntime(async function* (_session, turn) { received.push([...turn.images]); yield completed; });
  const { manager, directory } = await fixture(t, runtime);
  const session = await manager.create();
  const other = await manager.create();
  const own = await manager.uploadImage(session.id, new Uint8Array([1]), 'png');
  const foreign = await manager.uploadImage(other.id, new Uint8Array([2]), 'png');
  const outside = join(directory, 'outside.png');
  await writeFile(outside, 'outside');
  const link = join(manager.dataDirectory, 'images', session.id, 'link.png');
  await symlink(outside, link);
  for (const image of [foreign, outside, link, '/home/user/workspace/unuploaded.png']) {
    await assert.rejects(manager.startTurn(session.id, 'Read image', [image]), status(400));
  }
  assert.equal(received.length, 0);
  assert.equal(manager.get(session.id).turns.length, 0);
  await manager.startTurn(session.id, 'Read own image', [own]);
  await manager.waitForIdle(session.id);
  assert.deepEqual(received, [[own]]);
});

test('E2B API accepts executionMode and routes changes and raw tools to the owning remote runtime', async t => {
  const { manager, defaults, runtime } = await fixture(t);
  const config: AppConfig = {
    defaults, sdkVersion: 'test', auth: 'api-key', approvalPolicy: 'never',
    capabilities: { interactiveApprovals: false, tokenDeltas: false },
    e2b: { enabled: true, template: 'base', workingDirectory: '/home/user/workspace' },
  };
  const calls: unknown[] = [];
  runtime.changes = async session => { calls.push(['changes', session.id]); return { branch: 'remote-main', files: [{ path: 'remote.ts', status: 'M' }], diff: 'remote diff' }; };
  runtime.rawTools = async (session, cursor = 0) => {
    calls.push(['raw', session.id, cursor]);
    return { source: 'codex-rollout', location: 'e2b', sandboxId: 'remote-box', threadId: session.threadId,
      availability: 'available', messages: [{ id: String(cursor), payload: { type: 'custom_tool_call', name: 'exec', input: 'remote input' } }],
      nextCursor: cursor + 100, hasMore: false, skippedLines: 0 };
  };
  const localReader = { read: async () => { throw new Error('must not read host rollout for E2B session'); } } as unknown as RawToolReader;
  const app = createApp(manager, config, ['localhost:3001'], localReader);
  const request = (path: string, init: RequestInit = {}) => app.request(`http://localhost:3001${path}`, { ...init, headers: { host: 'localhost:3001', ...init.headers } });
  const created = await request('/api/sessions', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ settings: { executionMode: 'e2b', workingDirectory: '/home/user/api-workspace' } }) });
  assert.equal(created.status, 201);
  const session = await created.json() as Session;
  assert.equal(session.settings.executionMode, 'e2b');
  const changes = await request(`/api/sessions/${session.id}/changes`);
  assert.equal(changes.status, 200);
  assert.equal((await changes.json()).diff, 'remote diff');
  const raw = await request(`/api/sessions/${session.id}/raw-tools?cursor=250`);
  assert.equal(raw.status, 200);
  const page = await raw.json();
  assert.equal(page.location, 'e2b');
  assert.equal(page.nextCursor, 350);
  assert.equal(page.messages[0].payload.input, 'remote input');
  assert.deepEqual(calls, [['changes', session.id], ['raw', session.id, 250]]);
  assert.equal((await request('/api/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ settings: { executionMode: 'unknown' } }) })).status, 400);
});


test('retry waits stay running, publish progress, and cancellation clears persisted progress without another turn', async t => {
  const retry = { attempt: 1, maxRetries: 4, delayMs: 10000, nextRetryAt: new Date(Date.now() + 10000).toISOString(), status: 'waiting' as const };
  let runs = 0;
  const runtime = fakeRuntime(async function* (_session, _turn, signal) {
    runs++;
    yield { type: 'runtime.retry', retry };
    if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
    throw new Error('Retry cancelled');
  });
  const { manager } = await fixture(t, runtime);
  const session = await manager.create();
  const events: StreamMessage[] = [];
  let visible!: () => void;
  const pending = new Promise<void>(resolve => { visible = resolve; });
  const unsubscribe = manager.subscribe(session.id, event => {
    events.push(event);
    if (event.type === 'sdk' && event.event.type === 'runtime.retry') visible();
  });
  t.after(unsubscribe);
  await manager.startTurn(session.id, 'Keep the current model request');
  await pending;
  assert.equal(manager.get(session.id).status, 'running');
  assert.deepEqual((await stored(manager, session.id)).turns[0].retry, retry);
  assert.ok(events.some(event => event.type === 'sdk' && event.event.type === 'runtime.retry'));
  await manager.stop(session.id);
  const ended = await stored(manager, session.id);
  assert.equal(runs, 1);
  assert.equal(ended.turns.length, 1);
  assert.equal(ended.status, 'cancelled');
  assert.equal(ended.turns[0].retry, undefined);
  assert.equal(ended.turns[0].error, undefined);
});
