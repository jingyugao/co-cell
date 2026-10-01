import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Session, Settings, Turn } from '../../protocol/types.js';
import { TurnObserverDetached, type SandboxRuntime } from '../execution/container-runtime.js';
import { SessionManager, type CodexClient } from './manager.js';
import { MemoryWebStateStore } from '../testing/memory-web-state.js';

const defaults: Settings = { executionMode: 'sandbox', workingDirectory: '/home/agent/workspace', model: 'test',
  modelReasoningEffort: 'low', sandboxMode: 'danger-full-access', webSearchMode: 'disabled', networkAccessEnabled: true };
const provisioning = {
  async rebuild(_target: Parameters<SandboxRuntime['rebuild']>[0], save: Parameters<SandboxRuntime['rebuild']>[1]) {
    await save({ id: 'test-sandbox', template: 'test', status: 'ready', workingDirectory: defaults.workingDirectory });
  },
  async verifySandbox() {},
};
const tick = () => new Promise(resolve => setTimeout(resolve, 5));
async function until(check: () => boolean) {
  for (let i = 0; i < 400; i++) { if (check()) return; await tick(); }
  assert.fail('timed out');
}

test('legacy running turns are cancelled on restart instead of resubmitted', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hive-legacy-'));
  const runtime = { ...provisioning, async close() {}, async *run() { assert.fail('must not resubmit'); }, async *recover() { assert.fail('legacy cannot recover'); } } as unknown as SandboxRuntime;
  const state = new MemoryWebStateStore();
  const first = new SessionManager({} as CodexClient, directory, defaults, state, runtime);
  const second = new SessionManager({} as CodexClient, directory, defaults, state, runtime);
  try {
    await first.init();
    const session = await first.create();
    await first.close();
    session.status = 'running';
    session.turns.push({ id: 'legacy', prompt: 'old', images: [], status: 'running', items: [], startedAt: session.createdAt });
    await state.saveSession(session);
    await second.init();
    assert.equal(second.get(session.id).status, 'cancelled');
    assert.match(second.get(session.id).turns[0].error!, /没有可恢复的执行任务/);
  } finally {
    await first.close(); await second.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('an accepted App Server turn is recovered after restart without submitting its prompt again', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hive-app-server-recovery-'));
  let recoveries = 0, launches = 0, tracked = 0;
  const runtime = {
    ...provisioning,
    async close() {},
    trackExecution(_session: Session, turn: Turn) { tracked++; assert.equal(turn.nativeTurnId, 'native-turn'); },
    async *run() { launches++; assert.fail('must not resubmit an accepted App Server turn'); },
    async *recover(_session: Session, turn: Turn) {
      recoveries++;
      yield { type: 'turn.started' as const, turn_id: 'native-turn' };
      yield { type: 'item.completed' as const, item: { id: 'answer', type: 'agent_message' as const, text: 'finished remotely' } };
      yield { type: 'turn.completed' as const, usage: { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0,
        output_tokens: 0, reasoning_output_tokens: 0 } };
    },
  } as unknown as SandboxRuntime;
  const state = new MemoryWebStateStore();
  const first = new SessionManager({} as CodexClient, directory, defaults, state, runtime);
  const second = new SessionManager({} as CodexClient, directory, defaults, state, runtime);
  try {
    await first.init();
    const session = await first.create();
    await first.close();
    const sandbox = { id: 'test-sandbox', template: 'test', status: 'ready' as const, workingDirectory: defaults.workingDirectory };
    const project = (await state.listProjects()).find(value => value.id === session.projectId)!;
    project.sandbox = sandbox;
    await state.saveProject(project);
    session.sandbox = sandbox;
    session.threadId = 'thread-1';
    session.status = 'running';
    session.turns.push({ id: 'web-turn', nativeTurnId: 'native-turn', codexAccepted: true, prompt: '', images: [],
      status: 'running', phase: 'running', items: [], startedAt: session.createdAt });
    await state.saveSession(session);

    await second.init();
    assert.equal(second.get(session.id).turns[0].phase, 'recovering');
    await second.waitForIdle(session.id);
    const recovered = second.get(session.id);
    assert.equal(tracked, 1);
    assert.equal(recoveries, 1);
    assert.equal(launches, 0);
    assert.equal(recovered.status, 'completed');
    assert.equal(recovered.turns[0].status, 'completed');
    assert.equal(recovered.turns[0].nativeTurnId, 'native-turn');
    assert.equal(recovered.turns[0].error, undefined);
  } finally {
    await first.close(); await second.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('closing Web detaches an accepted App Server turn without aborting it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hive-app-server-detach-'));
  let detach!: () => void;
  let observedSignal: AbortSignal | undefined;
  let detachCalls = 0;
  const runtime = {
    ...provisioning,
    async close() {},
    detach(turn: Turn) { detachCalls++; assert.equal(turn.nativeTurnId, 'native-turn'); detach(); },
    async *run(_session: Session, _turn: Turn, signal: AbortSignal, onSandbox: (value: Session['sandbox']) => Promise<void>) {
      observedSignal = signal;
      await onSandbox({ id: 'test-sandbox', template: 'test', status: 'ready', workingDirectory: defaults.workingDirectory });
      yield { type: 'thread.started' as const, thread_id: 'thread-1' };
      yield { type: 'turn.started' as const, turn_id: 'native-turn' };
      await new Promise<void>(resolve => { detach = resolve; });
      throw new TurnObserverDetached();
    },
  } as unknown as SandboxRuntime;
  const state = new MemoryWebStateStore();
  const manager = new SessionManager({} as CodexClient, directory, defaults, state, runtime);
  try {
    await manager.init();
    const session = await manager.create();
    const turnId = await manager.startTurn(session.id, 'keep running');
    await until(() => Boolean(detach));
    await manager.close();
    const turn = manager.get(session.id).turns.find(candidate => candidate.id === turnId)!;
    assert.equal(detachCalls, 1);
    assert.equal(observedSignal?.aborted, false);
    assert.equal(turn.status, 'running');
    assert.equal(turn.phase, 'recovering');
  } finally {
    await manager.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('session archive timestamps are persisted and legacy records are backfilled', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hive-session-archive-'));
  const state = new MemoryWebStateStore();
  const manager = new SessionManager({} as CodexClient, directory, defaults, state);
  const restarted = new SessionManager({} as CodexClient, directory, defaults, state);
  try {
    await manager.init();
    const session = await manager.create({ settings: { executionMode: 'local', workingDirectory: process.cwd() } });
    assert.equal(session.startedAt, session.createdAt);
    assert.equal(session.archivedAt, null);

    const archived = await manager.update(session.id, { archived: true });
    assert.ok(archived.archivedAt);
    assert.equal(archived.startedAt, session.createdAt);
    assert.equal((await manager.update(session.id, { archived: false })).archivedAt, null);

    const legacy = (await state.listSessions()).find(value => value.id === session.id)! as Partial<Session>;
    delete legacy.startedAt;
    delete legacy.archivedAt;
    await state.saveSession(legacy as Session);
    await manager.close();
    await restarted.init();
    const migrated = restarted.get(session.id);
    assert.equal(migrated.startedAt, session.createdAt);
    assert.equal(migrated.archivedAt, null);
  } finally {
    await manager.close(); await restarted.close();
    await rm(directory, { recursive: true, force: true });
  }
});
