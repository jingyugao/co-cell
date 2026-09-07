import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import type { Thread, ThreadEvent } from '@openai/codex-sdk';
import { HttpError, SessionManager, type CodexClient } from '../server/manager.js';
import type { Session, Settings, StreamMessage } from '../shared/types.js';
import { applySdkEvent } from '../shared/session-events.js';

const completed: Extract<ThreadEvent, { type: 'turn.completed' }> = {
  type: 'turn.completed', usage: { input_tokens: 12, cached_input_tokens: 3, output_tokens: 7, cache_write_input_tokens: 0, reasoning_output_tokens: 2 },
};
type EventFactory = (signal: AbortSignal) => AsyncGenerator<ThreadEvent>;

function fakeClient(events: EventFactory) {
  const started: unknown[] = [];
  const resumed: string[] = [];
  const thread = {
    runStreamed: async (_input: unknown, options: { signal: AbortSignal }) => ({ events: events(options.signal) }),
  } as unknown as Thread;
  const client: CodexClient = {
    startThread: options => { started.push(options); return thread; },
    resumeThread: id => { resumed.push(id); return thread; },
  };
  return { client, started, resumed };
}

async function fixture(t: TestContext, events: EventFactory) {
  const directory = await mkdtemp(join(tmpdir(), 'codex-web-test-'));
  const defaults: Settings = {
    workingDirectory: directory, model: '', modelReasoningEffort: 'high',
    sandboxMode: 'workspace-write', webSearchMode: 'disabled', networkAccessEnabled: false,
  };
  const fake = fakeClient(events);
  const manager = new SessionManager(fake.client, join(directory, 'sessions'), defaults);
  await manager.init();
  t.after(async () => { await manager.close(); await rm(directory, { recursive: true, force: true }); });
  return { manager, directory, defaults, ...fake };
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
}

test('SDK item updates replace matching IDs and publish real events with final usage', async t => {
  const { manager, started } = await fixture(t, async function* () {
    yield { type: 'thread.started', thread_id: 'real-sdk-thread' };
    yield { type: 'item.started', item: { type: 'command_execution', id: 'cmd', command: 'pwd', aggregated_output: '', status: 'in_progress' } };
    yield { type: 'item.updated', item: { type: 'command_execution', id: 'cmd', command: 'pwd', aggregated_output: '/workspace', status: 'in_progress' } };
    yield { type: 'item.completed', item: { type: 'command_execution', id: 'cmd', command: 'pwd', aggregated_output: '/workspace\n', exit_code: 0, status: 'completed' } };
    yield { type: 'item.completed', item: { type: 'agent_message', id: 'answer', text: 'Done' } };
    yield { type: 'error', message: 'Transient error recovered by SDK' };
    yield completed;
  });
  const session = await manager.create();
  const messages: StreamMessage[] = [];
  const unsubscribe = manager.subscribe(session.id, message => messages.push(message));
  await manager.startTurn(session.id, 'Inspect workspace');
  await manager.waitForIdle(session.id);
  unsubscribe();
  const result = manager.get(session.id);
  assert.equal(result.status, 'completed');
  assert.equal(result.threadId, 'real-sdk-thread');
  assert.equal(result.turns[0].items.length, 2);
  assert.deepEqual(result.turns[0].items[0], {
    type: 'command_execution', id: 'cmd', command: 'pwd', aggregated_output: '/workspace\n', exit_code: 0, status: 'completed',
  });
  assert.deepEqual(result.turns[0].usage, completed.usage);
  assert.equal(result.turns[0].error, undefined);
  assert.equal(messages[0].type, 'snapshot');
  assert.equal(messages.filter(message => message.type === 'sdk').length, 7);
  assert.equal(messages.at(-1)?.type, 'state');
  assert.equal(started.length, 1);
  assert.equal((started[0] as { approvalPolicy: string }).approvalPolicy, 'never');
  assert.equal((started[0] as Settings).sandboxMode, 'workspace-write');
  assert.equal((started[0] as Settings).networkAccessEnabled, false);
});

test('turn events update browser and persisted progress before subprocess cleanup completes', async t => {
  let release!: () => void;
  const cleanup = new Promise<void>(resolve => { release = resolve; });
  let completedEvent!: () => void;
  const receivedCompletion = new Promise<void>(resolve => { completedEvent = resolve; });
  const { manager } = await fixture(t, async function* () {
    yield { type: 'turn.started' };
    yield { type: 'item.completed', item: { type: 'agent_message', id: 'answer', text: 'Full response' } };
    yield completed;
    await cleanup;
  });
  const session = await manager.create();
  let browser = session;
  const phases: (string | undefined)[] = [];
  const unsubscribe = manager.subscribe(session.id, message => {
    browser = message.type === 'sdk' ? applySdkEvent(browser, message.turnId, message.event) : message.session;
    phases.push(browser.turns.at(-1)?.phase);
    if (message.type === 'sdk' && message.event.type === 'turn.started') {
      assert.equal(browser.turns[0].phase, 'running');
      assert.equal(browser.turns[0].items.length, 0);
      assert.equal(manager.get(session.id).turns[0].phase, 'running');
    }
    if (message.type === 'sdk' && message.event.type === 'turn.completed') completedEvent();
  });
  try {
    await manager.startTurn(session.id, 'Respond');
    await receivedCompletion;
    assert.equal(browser.status, 'running'); // Keep the send lock until CLI cleanup.
    assert.equal(browser.turns[0].status, 'completed');
    assert.equal(browser.turns[0].phase, 'finalizing');
    assert.deepEqual(browser.turns[0].items, [{ id: 'answer', type: 'agent_message', text: 'Full response' }]);
    const stored: Session = JSON.parse(await readFile(join(manager.dataDirectory, `${session.id}.json`), 'utf8'));
    assert.equal(stored.turns[0].status, 'completed');
    assert.equal(stored.turns[0].phase, 'finalizing');
    await assert.rejects(manager.startTurn(session.id, 'Too early'), error => error instanceof HttpError && error.status === 409);
    const snapshots: StreamMessage[] = [];
    manager.subscribe(session.id, event => snapshots.push(event))();
    assert.deepEqual(snapshots[0], { type: 'snapshot', session: manager.get(session.id) });
  } finally { release(); }
  await manager.waitForIdle(session.id);
  unsubscribe();
  assert.equal(browser.status, 'completed');
  assert.equal(browser.turns[0].phase, undefined);
  assert.deepEqual(phases, [undefined, 'starting', 'running', 'running', 'finalizing', undefined]);
});

test('stream errors that never recover retain their message as a final failure', async t => {
  const { manager } = await fixture(t, async function* () { yield { type: 'error', message: 'Upstream unavailable' }; });
  const session = await manager.create();
  await manager.startTurn(session.id, 'Respond');
  await manager.waitForIdle(session.id);
  assert.equal(manager.get(session.id).status, 'failed');
  assert.equal(manager.get(session.id).turns[0].error, 'Upstream unavailable');
});

test('terminal SDK failure survives subprocess exit in persisted state and the final browser update', async t => {
  const detail = 'Selected model is at capacity. Please try a different model.';
  const { manager } = await fixture(t, async function* () {
    yield { type: 'turn.started' };
    yield { type: 'turn.failed', error: { message: detail } };
    throw new Error('Codex exec exited with code 1');
  });
  const session = await manager.create();
  const messages: StreamMessage[] = [];
  const unsubscribe = manager.subscribe(session.id, message => messages.push(message));
  await manager.startTurn(session.id, 'Task');
  await manager.waitForIdle(session.id);
  unsubscribe();
  assert.equal(manager.get(session.id).status, 'failed');
  assert.equal(manager.get(session.id).turns[0].error, detail);
  const persisted: Session = JSON.parse(await readFile(join(manager.dataDirectory, `${session.id}.json`), 'utf8'));
  assert.equal(persisted.turns[0].error, detail);
  const last = messages.at(-1);
  assert.equal(last?.type, 'state');
  if (last?.type === 'state') assert.equal(last.session.turns[0].error, detail);
});

test('recovered or empty SDK diagnostics do not hide a later subprocess failure', async t => {
  const cases: { name: string; events: ThreadEvent[] }[] = [
    { name: 'transient transport error followed by completion', events: [{ type: 'error', message: 'Temporary transport error' }, completed] },
    { name: 'failure followed by successful completion', events: [{ type: 'turn.failed', error: { message: 'Earlier failed attempt' } }, completed] },
    { name: 'failure followed by a new attempt', events: [{ type: 'turn.failed', error: { message: 'Earlier failed attempt' } }, { type: 'turn.started' }] },
    { name: 'empty terminal failure', events: [{ type: 'turn.failed', error: { message: '   ' } }] },
  ];
  for (const scenario of cases) await t.test(scenario.name, async t => {
    const cleanupFailure = 'Codex exec exited with code 1';
    const { manager } = await fixture(t, async function* () {
      yield* scenario.events;
      throw new Error(cleanupFailure);
    });
    const session = await manager.create();
    await manager.startTurn(session.id, 'Task');
    await manager.waitForIdle(session.id);
    assert.equal(manager.get(session.id).status, 'failed');
    assert.equal(manager.get(session.id).turns[0].error, cleanupFailure);
  });
});

test('persisted SDK thread ID is resumed after manager restart', async t => {
  const { manager, defaults } = await fixture(t, async function* () {
    yield { type: 'thread.started', thread_id: 'sdk-continuation-id' };
    yield completed;
  });
  const session = await manager.create();
  await manager.startTurn(session.id, 'First turn');
  await manager.waitForIdle(session.id);
  await manager.close();
  const fake = fakeClient(async function* () { yield completed; });
  const restarted = new SessionManager(fake.client, manager.dataDirectory, defaults);
  t.after(() => restarted.close());
  await restarted.init();
  await restarted.startTurn(session.id, 'Continue');
  await restarted.waitForIdle(session.id);
  assert.deepEqual(fake.resumed, ['sdk-continuation-id']);
  assert.equal(fake.started.length, 0);
  assert.equal(restarted.get(session.id).turns.length, 2);
  const persisted: Session = JSON.parse(await readFile(join(manager.dataDirectory, `${session.id}.json`), 'utf8'));
  assert.equal(persisted.threadId, 'sdk-continuation-id');
  assert.equal(persisted.turns[1].status, 'completed');
});

test('concurrent turn submission reserves session before asynchronous persistence', async t => {
  const { manager } = await fixture(t, async function* (signal) {
    await waitForAbort(signal);
    throw new Error('aborted');
  });
  const session = await manager.create();
  const first = manager.startTurn(session.id, 'First');
  await assert.rejects(manager.startTurn(session.id, 'Second'), error => error instanceof HttpError && error.status === 409);
  await first;
  await assert.rejects(manager.update(session.id, { title: 'Changed' }), error => error instanceof HttpError && error.status === 409);
  assert.equal(manager.get(session.id).turns.length, 1);
  await manager.stop(session.id);
});

test('deletion rejects concurrent starts and updates and removes an upload already in progress', async t => {
  const { manager, directory, started } = await fixture(t, async function* () { yield completed; });
  const session = await manager.create();
  const uploading = manager.uploadImage(session.id, new Uint8Array([1, 2, 3]), 'png');
  const updating = manager.update(session.id, { title: 'Concurrent edit', settings: { workingDirectory: directory } });
  const deleting = manager.delete(session.id);
  const conflict = (error: unknown) => error instanceof HttpError && error.status === 409;
  assert.throws(() => manager.get(session.id), conflict);
  await Promise.all([
    assert.rejects(manager.startTurn(session.id, 'Concurrent turn'), conflict),
    assert.rejects(manager.update(session.id, { title: 'Too late' }), conflict),
    assert.rejects(updating, error => error instanceof HttpError && [404, 409].includes(error.status)),
    deleting,
    uploading,
  ]);
  assert.equal(started.length, 0);
  assert.equal(manager.list().length, 0);
  assert.throws(() => manager.get(session.id), error => error instanceof HttpError && error.status === 404);
  for (const path of [join(manager.dataDirectory, `${session.id}.json`), join(manager.dataDirectory, 'images', session.id)]) {
    await assert.rejects(stat(path), (error: NodeJS.ErrnoException) => error.code === 'ENOENT');
  }
});

test('initial persistence failure restores the previous session and permits retry after storage recovery', async t => {
  const { manager, started } = await fixture(t, async function* () { yield completed; });
  const session = await manager.create();
  const file = join(manager.dataDirectory, `${session.id}.json`);
  const messages: StreamMessage[] = [];
  const unsubscribe = manager.subscribe(session.id, message => messages.push(message));
  await mkdir(`${file}.tmp`);
  await assert.rejects(manager.startTurn(session.id, 'Must not remain running'), (error: NodeJS.ErrnoException) => error.code === 'EISDIR');
  assert.deepEqual(manager.get(session.id), session);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), session);
  assert.equal(started.length, 0);
  assert.deepEqual(messages.at(-1), { type: 'state', session });
  await rm(`${file}.tmp`, { recursive: true });
  await manager.startTurn(session.id, 'Retry after repair');
  await manager.waitForIdle(session.id);
  unsubscribe();
  const retried = manager.get(session.id);
  assert.equal(retried.status, 'completed');
  assert.equal(retried.turns.length, 1);
  assert.equal(retried.turns[0].prompt, 'Retry after repair');
  assert.equal(started.length, 1);
});

test('stop aborts the SDK signal and persists cancellation, permitting a subsequent turn', async t => {
  let observedSignal: AbortSignal | undefined;
  let callCount = 0;
  const { manager } = await fixture(t, async function* (signal) {
    observedSignal = signal;
    if (++callCount === 1) {
      await waitForAbort(signal);
      throw new Error('SDK process aborted');
    }
    yield completed;
  });
  const session = await manager.create();
  await manager.startTurn(session.id, 'Long task');
  await manager.stop(session.id);
  assert.equal(observedSignal?.aborted, true);
  const cancelled = manager.get(session.id);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.turns[0].status, 'cancelled');
  assert.ok(cancelled.turns[0].completedAt);
  assert.equal(cancelled.turns[0].error, undefined);
  await manager.startTurn(session.id, 'Retry');
  await manager.waitForIdle(session.id);
  assert.equal(manager.get(session.id).status, 'completed');
});

test('close waits for a turn reserved before attachment validation and for SDK cancellation cleanup', async t => {
  let entered!: () => void;
  const running = new Promise<void>(resolve => { entered = resolve; });
  let release!: () => void;
  const cleanupGate = new Promise<void>(resolve => { release = resolve; });
  const { manager } = await fixture(t, async function* (signal) {
    entered();
    await waitForAbort(signal);
    await cleanupGate;
    throw new Error('cancelled after process cleanup');
  });
  const session = await manager.create();
  const image = await manager.uploadImage(session.id, new Uint8Array([1]), 'png');
  const starting = manager.startTurn(session.id, 'Race shutdown', [image]);
  let closed = false;
  const closing = manager.close().then(() => { closed = true; });
  try {
    await running;
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(closed, false, 'shutdown must wait for the in-flight SDK cleanup');
  } finally {
    release();
    await Promise.all([starting, closing]);
  }
  assert.equal(manager.get(session.id).status, 'cancelled');
  const persisted: Session = JSON.parse(await readFile(join(manager.dataDirectory, `${session.id}.json`), 'utf8'));
  assert.equal(persisted.turns[0].status, 'cancelled');
  await assert.rejects(manager.startTurn(session.id, 'After shutdown'), error => error instanceof HttpError && error.status === 503);
});

test('SDK failure before the first event becomes visible and releases the session', async t => {
  const { manager } = await fixture(t, async function* () { throw new Error('Codex executable missing'); });
  const session = await manager.create();
  await manager.startTurn(session.id, 'Task');
  await manager.waitForIdle(session.id);
  assert.equal(manager.get(session.id).status, 'failed');
  assert.equal(manager.get(session.id).turns[0].error, 'Codex executable missing');
  await manager.update(session.id, { title: 'Can edit after failure' });
  assert.equal(manager.get(session.id).title, 'Can edit after failure');
});

test('stream ending without a terminal event is failed instead of left running', async t => {
  const { manager } = await fixture(t, async function* () {
    yield { type: 'thread.started', thread_id: 'interrupted-thread' };
  });
  const session = await manager.create();
  await manager.startTurn(session.id, 'Task');
  await manager.waitForIdle(session.id);
  const result = manager.get(session.id);
  assert.equal(result.status, 'failed');
  assert.match(result.turns[0].error ?? '', /未收到完成事件/);
  assert.equal(result.threadId, 'interrupted-thread');
});

test('attachments reject paths outside this session, including cross-session files and symlinks', async t => {
  const { manager, directory } = await fixture(t, async function* () { yield completed; });
  const session = await manager.create();
  const other = await manager.create();
  const ownImage = await manager.uploadImage(session.id, new Uint8Array([1]), 'png');
  const otherImage = await manager.uploadImage(other.id, new Uint8Array([1]), 'png');
  const outside = join(directory, 'outside.png');
  await writeFile(outside, 'outside');
  const link = join(manager.dataDirectory, 'images', session.id, 'symlink.png');
  await symlink(outside, link);
  for (const path of [outside, otherImage, link]) {
    await assert.rejects(manager.startTurn(session.id, 'Read image', [path]), error => error instanceof HttpError && error.status === 400);
  }
  assert.equal(manager.get(session.id).turns.length, 0);
  await manager.startTurn(session.id, 'Read own image', [ownImage]);
  await manager.waitForIdle(session.id);
  assert.equal(manager.get(session.id).status, 'completed');
});

test('startup marks interrupted persisted turns cancelled while retaining history and thread ID', async t => {
  const { manager, defaults, client } = await fixture(t, async function* () { yield completed; });
  const session = await manager.create();
  await manager.close();
  session.status = 'running';
  session.threadId = 'recoverable-thread';
  session.turns.push({ id: 'unfinished-turn', prompt: 'Working', images: [], status: 'running', items: [], startedAt: session.createdAt });
  const file = join(manager.dataDirectory, `${session.id}.json`);
  await writeFile(file, JSON.stringify(session));
  const restarted = new SessionManager(client, manager.dataDirectory, defaults);
  t.after(() => restarted.close());
  await restarted.init();
  const recovered = restarted.get(session.id);
  assert.equal(recovered.status, 'cancelled');
  assert.equal(recovered.threadId, 'recoverable-thread');
  assert.equal(recovered.turns[0].status, 'cancelled');
  assert.match(recovered.turns[0].error ?? '', /服务已重启/);
  assert.ok(recovered.turns[0].completedAt);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), recovered);
});

test('startup persists removal of stale completed-turn errors while preserving failure diagnostics', async t => {
  const { manager, defaults, client } = await fixture(t, async function* () { yield completed; });
  const session = await manager.create();
  await manager.close();
  const retryError = 'Reconnecting... 5/5 (unexpected status 404 Not Found: Invalid URL (GET /v1/responses))';
  session.status = 'failed';
  session.threadId = 'historical-thread';
  session.turns.push({
    id: 'completed-turn', prompt: 'Succeeded after retry', images: [], status: 'completed',
    items: [{ id: 'retry-diagnostic', type: 'error', message: retryError }],
    startedAt: session.createdAt, completedAt: session.updatedAt, usage: completed.usage, error: retryError,
  }, {
    id: 'failed-turn', prompt: 'Failed after retry', images: [], status: 'failed',
    items: [{ id: 'failure-diagnostic', type: 'error', message: retryError }],
    startedAt: session.createdAt, completedAt: session.updatedAt, error: retryError,
  });
  const expected = structuredClone(session);
  delete expected.turns[0].error;
  const file = join(manager.dataDirectory, `${session.id}.json`);
  await writeFile(file, JSON.stringify(session));
  const restarted = new SessionManager(client, manager.dataDirectory, defaults);
  t.after(() => restarted.close());
  await restarted.init();
  assert.deepEqual(restarted.get(session.id), expected);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), expected);
  await restarted.close();

  const restartedAgain = new SessionManager(client, manager.dataDirectory, defaults);
  t.after(() => restartedAgain.close());
  await restartedAgain.init();
  assert.deepEqual(restartedAgain.get(session.id), expected);
});

test('restart preserves completed output if shutdown happened during SDK cleanup', async t => {
  const { manager, defaults, client } = await fixture(t, async function* () { yield completed; });
  const session = await manager.create();
  await manager.close();
  session.status = 'running';
  session.turns.push({ id: 'finished', prompt: 'Reply', images: [], status: 'completed', phase: 'finalizing',
    items: [{ id: 'answer', type: 'agent_message', text: 'Done' }], startedAt: session.createdAt });
  await writeFile(join(manager.dataDirectory, `${session.id}.json`), JSON.stringify(session));
  const restarted = new SessionManager(client, manager.dataDirectory, defaults);
  t.after(() => restarted.close());
  await restarted.init();
  assert.equal(restarted.get(session.id).status, 'completed');
  assert.equal(restarted.get(session.id).turns[0].status, 'completed');
  assert.equal(restarted.get(session.id).turns[0].phase, undefined);
});
