import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import type { Session, Turn } from '../../shared/types.js';
import { E2BCodexRuntime, TurnLaunchCancelled, TurnObserverDetached } from './e2b.js';

function fixture() {
  const turn: Turn = { id: randomUUID(), prompt: 'test', images: [], items: [], status: 'running', startedAt: new Date().toISOString(),
    execution: { kind: 'e2b-worker', protocolVersion: 1, workerId: randomUUID(), lastAppliedSeq: 0, state: 'running' } };
  const session: Session = { id: randomUUID(), title: 'test', threadId: null, status: 'running', startedAt: turn.startedAt, archivedAt: null, createdAt: turn.startedAt,
    updatedAt: turn.startedAt, turns: [turn], sandbox: { id: 'test-sandbox', status: 'ready', template: 'test', workingDirectory: '/tmp' },
    settings: { executionMode: 'e2b', workingDirectory: '/tmp', model: 'test', modelReasoningEffort: 'low',
      sandboxMode: 'danger-full-access', webSearchMode: 'disabled', networkAccessEnabled: false } };
  const runtime = new E2BCodexRuntime({ connection: {}, template: 'test', apiKey: 'secret-api-key' });
  const envelope = (seq: number, event: Record<string, unknown>) => ({ v: 1 as const, workerId: turn.execution!.workerId, turnId: turn.id, seq, event });
  const state = (lastSeq: number, status: 'running' | 'completed' = 'completed') => ({ protocolVersion: 1 as const,
    workerId: turn.execution!.workerId, sessionId: session.id, turnId: turn.id, pid: 123, status, threadId: null, lastSeq });
  const entry = { sandbox: { commands: { run: async () => ({}) } }, metadata: session.sandbox,
    preparation: {}, lease: { signal: new AbortController().signal, release: async () => {} },
  } as unknown as Parameters<typeof runtime['observeWorker']>[0];
  return { runtime, session, turn, entry, envelope, state };
}

test('terminal state ahead of journal read drains final SDK events before returning', async () => {
  const { runtime, session, turn, entry, envelope, state } = fixture();
  let reads = 0;
  runtime['readWorkerEvents'] = async () => ++reads === 1 ? [envelope(1, { type: 'thread.started', thread_id: 'thread' })]
    : [envelope(1, { type: 'thread.started', thread_id: 'thread' }), envelope(2, { type: 'turn.completed', usage: {} })];
  runtime['readWorkerState'] = async () => state(2);
  try {
    const events = [];
    for await (const event of runtime['observeWorker'](entry, session, turn, new AbortController().signal)) events.push(event.type);
    assert.deepEqual(events, ['thread.started', 'turn.completed']);
    assert.equal(turn.execution!.lastAppliedSeq, 2);
  } finally { await runtime.close(); }
});

test('SDK cursor cannot advance while the consumer is still applying an event', async () => {
  const { runtime, session, turn, entry, envelope, state } = fixture();
  runtime['readWorkerEvents'] = async () => [envelope(1, { type: 'thread.started', thread_id: 'thread' })];
  runtime['readWorkerState'] = async () => state(1);
  const stream = runtime['observeWorker'](entry, session, turn, new AbortController().signal);
  try {
    assert.equal((await stream.next()).value?.type, 'thread.started');
    assert.equal(turn.execution!.lastAppliedSeq, 0);
    assert.equal((await stream.next()).done, true);
    assert.equal(turn.execution!.lastAppliedSeq, 1);
  } finally { await stream.return(undefined); await runtime.close(); }
});

test('recovery replays pending control requests even after their UI cursor was saved', async () => {
  const { runtime, session, turn, entry, envelope, state } = fixture();
  const requestId = randomUUID();
  turn.execution!.lastAppliedSeq = 1;
  runtime['readWorkerEvents'] = async () => [envelope(1, { type: 'runtime.user_approval_request', requestId, input: {} })];
  let writes = 0;
  let requests = 0;
  runtime['readWorkerState'] = async () => state(1, writes ? 'completed' : 'running');
  runtime['writeAtomic'] = async (_entry, path, content) => {
    writes++;
    assert.ok(path.endsWith(`/approvals/${requestId}.json`));
    assert.equal(JSON.parse(String(content)).approval.id, requestId);
  };
  try {
    for await (const _event of runtime['observeWorker'](entry, session, turn, new AbortController().signal, async id => {
      requests++;
      return { id, title: 'test', target: 'test', action: 'test', impact: 'test', status: 'approved', createdAt: turn.startedAt };
    })) assert.fail('control requests must not be forwarded as SDK events');
    assert.equal(requests, 1);
    assert.equal(writes, 1);
  } finally { await runtime.close(); }
});

test('a failed receipt write is retried without resending model input', async () => {
  const { runtime, session, turn, entry, envelope, state } = fixture();
  const requestId = randomUUID();
  turn.execution!.lastAppliedSeq = 1;
  runtime['readWorkerEvents'] = async () => [envelope(1, { type: 'runtime.user_approval_request', requestId, input: {} })];
  let writes = 0;
  runtime['readWorkerState'] = async () => state(1, writes >= 2 ? 'completed' : 'running');
  runtime['writeAtomic'] = async () => { if (++writes === 1) throw new Error('temporary transport failure'); };
  try {
    for await (const _event of runtime['observeWorker'](entry, session, turn, new AbortController().signal, async id => ({
      id, title: 'test', target: 'test', action: 'test', impact: 'test', status: 'approved', createdAt: turn.startedAt,
    }))) assert.fail('unexpected SDK event');
    assert.equal(writes, 2);
  } finally { await runtime.close(); }
});

test('detach before observer registration is explicit, not a successful empty stream', async () => {
  const { runtime, session, turn, entry } = fixture();
  runtime.detach(turn);
  try {
    await assert.rejects(runtime['observeWorker'](entry, session, turn, new AbortController().signal).next(), TurnObserverDetached);
  } finally { await runtime.close(); }
});

test('detach before run starts never acquires a sandbox or launches a worker', async () => {
  const { runtime, session, turn } = fixture();
  runtime['acquire'] = async () => { assert.fail('must not acquire'); };
  runtime.detach(turn);
  try {
    await assert.rejects(runtime.run(session, turn, new AbortController().signal, async () => {}).next(), TurnLaunchCancelled);
  } finally { await runtime.close(); }
});

test('detach during preparation cancels only the unlaunched turn', async () => {
  const { runtime, session, turn, entry } = fixture();
  runtime['acquire'] = async () => entry;
  let preparing!: () => void;
  const ready = new Promise<void>(resolve => { preparing = resolve; });
  runtime['prepare'] = async (_entry, signal) => {
    preparing();
    await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    assert.fail('must cancel preparation');
  };
  const controller = new AbortController();
  const running = runtime.run(session, turn, controller.signal, async () => {}).next();
  try {
    await ready;
    runtime.detach(turn);
    await assert.rejects(running, TurnLaunchCancelled);
    assert.equal(controller.signal.aborted, false);
  } finally { await runtime.close(); }
});

test('temporary observation transport errors do not finish a remotely running turn', async () => {
  const { runtime, session, turn, entry, envelope, state } = fixture();
  let reads = 0;
  runtime['readWorkerEvents'] = async () => {
    if (++reads === 1) throw new Error('fetch failed');
    return [envelope(1, { type: 'turn.completed', usage: {} })];
  };
  runtime['readWorkerState'] = async () => state(1);
  try {
    const events = [];
    for await (const event of runtime['observeWorker'](entry, session, turn, new AbortController().signal)) events.push(event.type);
    assert.deepEqual(events, ['turn.completed']);
    assert.equal(reads, 2);
  } finally { await runtime.close(); }
});

test('failed worker state is surfaced without configured secrets', async () => {
  const { runtime, session, turn, entry, state } = fixture();
  runtime['readWorkerEvents'] = async () => [];
  runtime['readWorkerState'] = async () => ({ ...state(0), status: 'failed', error: 'denied secret-api-key' });
  try {
    await assert.rejects(runtime['observeWorker'](entry, session, turn, new AbortController().signal).next(), /denied \[REDACTED\]/);
  } finally { await runtime.close(); }
});

test('termination cannot confirm a delayed launch from a missing PID or an unrelated terminal record', async () => {
  const { runtime, turn, entry } = fixture();
  let terminalState: Record<string, unknown> | undefined;
  entry.sandbox.commands.run = (async (command: string) => {
    const match = / -e '(.*)'$/s.exec(command);
    assert.ok(match);
    const script = match[1].replaceAll("'\\''", "'");
    let stdout = '';
    await runInNewContext(script, {
      require: (name: string) => name === 'node:fs' ? {
        readFileSync: (path: string) => {
          if (path.endsWith('/state.json') && terminalState) return JSON.stringify(terminalState);
          throw new Error('ENOENT');
        },
      } : { execFileSync: () => assert.fail('no process inspection without a PID') },
      process: { stdout: { write: (value: string) => { stdout += value; } }, kill: () => assert.fail('no signal without a PID') },
    });
    return { stdout, stderr: '', exitCode: 0 };
  }) as unknown as typeof entry.sandbox.commands.run;
  try {
    assert.equal(await runtime['terminateWorker'](entry, turn), false);
    terminalState = { workerId: turn.execution!.workerId, turnId: turn.id, status: 'running' };
    assert.equal(await runtime['terminateWorker'](entry, turn), false);
    terminalState = { ...terminalState, status: 'completed', workerId: randomUUID() };
    assert.equal(await runtime['terminateWorker'](entry, turn), false);
    terminalState.workerId = turn.execution!.workerId;
    assert.equal(await runtime['terminateWorker'](entry, turn), true);
  } finally { await runtime.close(); }
});
