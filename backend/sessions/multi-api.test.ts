import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { Project, Session, Settings, Turn } from '../../protocol/types.js';
import { TurnObserverDetached, type SandboxRuntime } from '../execution/container-runtime.js';
import type { WorkspaceTarget } from '../sandboxes/types.js';
import type { CodexClient } from './manager.js';
import { SessionManager } from './manager.js';
import { MemoryWebStateStore } from '../testing/memory-web-state.js';
import { MemoryCoordinator } from '../infra/storage/coordination.js';

const settings: Settings = { executionMode: 'sandbox', workingDirectory: '/home/agent/workspace', model: 'test',
  modelReasoningEffort: 'low', sandboxMode: 'danger-full-access', webSearchMode: 'disabled', networkAccessEnabled: true };
const questionItem = { id: 'request-1', type: 'agent_message' as const, delivery: 'async', text: 'Need a choice.',
  questions: [{ title: 'Continue?', options: ['Yes', 'No'] }] };
const usage = { input_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function waitUntil(action: () => boolean | Promise<boolean>, timeoutMs = 3000) {
  const until = Date.now() + timeoutMs;
  return new Promise<void>((resolve, reject) => {
    const poll = async () => {
      try { if (await action()) return resolve(); }
      catch (error) { return reject(error); }
      if (Date.now() >= until) return reject(new Error('Timed out waiting for multi-API state'));
      setTimeout(poll, 10);
    };
    void poll();
  });
}

type Control = {
  runCalls: number;
  recoverCalls: number;
  steers: string[];
  interrupts: number;
  maintenanceCalls: number;
  archiveCaptures: number;
  questionReady: ReturnType<typeof deferred<void>>;
  recoveryReady: ReturnType<typeof deferred<void>>;
  terminal: ReturnType<typeof deferred<'completed' | 'cancelled'>>;
  nativeTurn?: Turn;
};

function runtimeFor(control: Control): SandboxRuntime {
  const observers = new Map<string, ReturnType<typeof deferred<void>>>();
  async function* observe(kind: 'run' | 'recover', session: Session, turn: Turn,
    signal: AbortSignal, onSandbox: (value: NonNullable<Session['sandbox']>) => Promise<void>) {
    const detached = deferred<void>();
    observers.set(turn.id, detached);
    if (kind === 'run') control.runCalls++; else control.recoverCalls++;
    const nativeTurn: Turn = { ...turn, id: 'native-turn', nativeTurnId: 'native-turn', codexAccepted: true,
      status: 'running', startedAt: turn.startedAt, items: [questionItem] };
    control.nativeTurn = nativeTurn;
    if (kind === 'recover') control.recoveryReady.resolve();
    else {
      await onSandbox(session.sandbox!);
      yield { type: 'thread.started' as const, thread_id: 'shared-thread' };
    }
    yield { type: 'turn.started' as const, turn_id: 'native-turn' };
    yield { type: 'item.completed' as const, item: questionItem };
    if (kind === 'run') control.questionReady.resolve();
    const outcome = await Promise.race([
      control.terminal.promise,
      detached.promise.then(() => 'detached' as const),
      new Promise<'aborted'>(resolve => signal.addEventListener('abort', () => resolve('aborted'), { once: true })),
    ]);
    if (outcome === 'detached' || outcome === 'aborted') throw new TurnObserverDetached();
    nativeTurn.status = outcome === 'completed' ? 'completed' : 'cancelled';
    nativeTurn.completedAt = new Date().toISOString();
    if (outcome === 'cancelled') yield { type: 'turn.failed' as const, cancelled: true, error: { message: 'Turn interrupted' } };
    else yield { type: 'turn.completed' as const, usage };
    observers.delete(turn.id);
  }
  return {
    async close() {},
    track() {},
    async querySandbox(sandbox: NonNullable<Session['sandbox']>) { return { ...sandbox, status: 'ready' as const }; },
    async inspect(_target: WorkspaceTarget) { return {}; },
    async rebuild() {},
    async checkpoint(target: WorkspaceTarget) { control.maintenanceCalls++; return target.sandbox!; },
    remoteArchives: { async capture() { control.archiveCaptures++; throw new Error('unexpected scheduled capture'); } },
    async *run(session: Session, turn: Turn, signal: AbortSignal,
      onSandbox: (value: NonNullable<Session['sandbox']>) => Promise<void>) { yield* observe('run', session, turn, signal, onSandbox); },
    async *recover(session: Session, turn: Turn, signal: AbortSignal,
      onSandbox: (value: NonNullable<Session['sandbox']>) => Promise<void>) { yield* observe('recover', session, turn, signal, onSandbox); },
    detach(turn: Turn) { observers.get(turn.id)?.resolve(); },
    async steer(_session: Session, _turn: Turn, text: string) { control.steers.push(text); return true; },
    async interrupt() { control.interrupts++; control.terminal.resolve('cancelled'); },
    async history() { return { turns: control.nativeTurn ? [structuredClone(control.nativeTurn)] : [] }; },
  } as unknown as SandboxRuntime;
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'cocell-multi-api-'));
  const coordinator = new MemoryCoordinator();
  const state = new MemoryWebStateStore();
  const now = new Date().toISOString();
  const projectId = randomUUID(), sessionId = randomUUID();
  const project: Project = { id: projectId, name: 'Shared project', requirementUrl: null, executionMode: 'sandbox',
    workingDirectory: settings.workingDirectory, status: 'active', completedAt: null, archivedAt: null,
    sandbox: { id: 'shared-box', template: 'test', status: 'ready', workingDirectory: settings.workingDirectory },
    createdAt: now, updatedAt: now };
  const session: Session = { id: sessionId, projectId, threadId: null, title: 'Shared session', settings: { ...settings },
    status: 'idle', startedAt: now, createdAt: now, updatedAt: now, archivedAt: null,
    sandbox: structuredClone(project.sandbox), turns: [] };
  await state.saveProject(project);
  await state.saveSession(session);
  const control: Control = { runCalls: 0, recoverCalls: 0, steers: [], interrupts: 0, maintenanceCalls: 0,
    archiveCaptures: 0, questionReady: deferred<void>(), recoveryReady: deferred<void>(), terminal: deferred<'completed' | 'cancelled'>() };
  const managers: SessionManager[] = [];
  const start = async () => {
    const manager = new SessionManager({} as CodexClient, directory, settings, state, runtimeFor(control), undefined, undefined,
      undefined, undefined, undefined, coordinator);
    managers.push(manager);
    await manager.init();
    return manager;
  };
  return { control, state, coordinator, start, projectId, sessionId, async closeManager(manager: SessionManager) {
    const index = managers.indexOf(manager);
    if (index >= 0) managers.splice(index, 1);
    await manager.close();
  }, async close() {
    for (const manager of managers.reverse()) await manager.close();
    await coordinator.close();
    await rm(directory, { recursive: true, force: true });
  } };
}

test('a second API sees the running turn, steers its async answer, and rejects a duplicate start', async () => {
  const f = await fixture();
  try {
    const apiA = await f.start();
    const apiB = await f.start();
    const events: Array<{ type: string; session?: Session }> = [];
    const ownerEvents: Array<{ type: string; session?: Session }> = [];
    const unsubscribeOwner = apiA.subscribe(f.sessionId, message => {
      if (message.type === 'state') ownerEvents.push(message);
    });
    const unsubscribe = apiB.subscribe(f.sessionId, message => {
      if (message.type === 'snapshot' || message.type === 'state') events.push(message);
    });
    try {
      const turnId = await apiA.startTurn(f.sessionId, 'Run the shared task');
      await f.control.questionReady.promise;
      await waitUntil(() => events.some(event => event.session?.turns.some(turn => turn.id === turnId
        && turn.userInputRequests?.some(request => request.status === 'pending'))));
      const state = apiB.get(f.sessionId);
      await assert.rejects(apiB.startTurn(f.sessionId, 'duplicate task'), /执行|任务|running|running/i);
      await apiB.answerUserInput(f.sessionId, turnId, 'request-1', 'Yes', ['Yes']);
      assert.equal(f.control.runCalls, 1);
      assert.equal(f.control.steers.length, 1);
      assert.match(f.control.steers[0], /Yes/);
      assert.equal(state.turns[0].status, 'running');
      await waitUntil(() => ownerEvents.some(event => event.session?.turns.some(turn => turn.id === turnId
        && turn.userInputRequests?.some(request => request.status === 'answered'))));
    } finally { unsubscribe(); unsubscribeOwner(); }
  } finally { f.control.terminal.resolve('completed'); await f.close(); }
});

test('a second API blocks maintenance and remotely stops the native turn as cancelled', async () => {
  const f = await fixture();
  try {
    const apiA = await f.start();
    const apiB = await f.start();
    const turnId = await apiA.startTurn(f.sessionId, 'Run until stopped');
    await f.control.questionReady.promise;
    await assert.rejects(apiB.checkpointProjectSandbox(f.projectId));
    assert.equal(f.control.maintenanceCalls, 0);
    await apiB.stop(f.sessionId);
    await apiA.waitForIdle(f.sessionId);
    const persisted = await f.state.getSession(f.sessionId);
    assert.equal(f.control.interrupts, 1);
    assert.equal(f.control.runCalls, 1);
    assert.equal(persisted?.turns.find(turn => turn.id === turnId)?.status, 'cancelled');
  } finally { await f.close(); }
});

test('a new API does not fail another API turn and takes over observation after it closes', async () => {
  const f = await fixture();
  try {
    const apiA = await f.start();
    const turnId = await apiA.startTurn(f.sessionId, 'Continue after API restart');
    await f.control.questionReady.promise;
    const apiB = await f.start();
    assert.equal(apiB.get(f.sessionId).turns.find(turn => turn.id === turnId)?.status, 'running');
    await f.closeManager(apiA);
    await waitUntil(() => f.control.recoverCalls === 1);
    f.control.terminal.resolve('completed');
    await waitUntil(async () => (await f.state.getSession(f.sessionId))?.turns.find(turn => turn.id === turnId)?.status === 'completed');
    assert.equal(f.control.runCalls, 1);
    assert.equal(f.control.recoverCalls, 1);
    assert.equal((await f.state.getSession(f.sessionId))?.turns.find(turn => turn.id === turnId)?.status, 'completed');
  } finally { f.control.terminal.resolve('completed'); await f.close(); }
});

test('scheduled archive leaves a newly created project alone until its archive interval elapses', async () => {
  const f = await fixture();
  try {
    const api = await f.start();
    await api.scheduledArchive();
    assert.equal(f.control.archiveCaptures, 0);
    assert.equal((await f.state.getProject(f.projectId))?.sandboxOperation, undefined);
  } finally { await f.close(); }
});

test('shared recovery rechecks the persisted operation after acquiring maintenance ownership', async () => {
  const f = await fixture();
  let held: Awaited<ReturnType<typeof f.coordinator.tryAcquire>> = null;
  try {
    const project = await f.state.getProject(f.projectId);
    assert.ok(project);
    project.sandboxOperation = { id: 'old-operation', kind: 'resume', phase: '恢复中', status: 'running', updatedAt: new Date().toISOString() };
    await f.state.saveProject(project);
    held = await f.coordinator.tryAcquire(`project-maintenance:${f.projectId}`);
    assert.ok(held);

    const originalTryAcquire = f.coordinator.tryAcquire.bind(f.coordinator);
    const acquisitionStarted = deferred<void>();
    const continueAcquisition = deferred<void>();
    f.coordinator.tryAcquire = async key => {
      if (key === `project-maintenance:${f.projectId}`) {
        acquisitionStarted.resolve();
        await continueAcquisition.promise;
      }
      return originalTryAcquire(key);
    };
    const starting = f.start();
    await acquisitionStarted.promise;

    project.sandboxOperation.status = 'succeeded';
    project.sandboxOperation.phase = '完成';
    await f.state.saveProject(project);
    await held.release();
    held = null;
    continueAcquisition.resolve();

    const api = await starting;
    assert.equal((await f.state.getProject(f.projectId))?.sandboxOperation?.status, 'succeeded');
    await f.closeManager(api);
  } finally {
    await held?.release();
    await f.close();
  }
});

test('pre-acceptance recovery does not attach a recent completed duplicate prompt', async () => {
  const f = await fixture();
  try {
    const previousStartedAt = new Date(Date.now() - 500).toISOString();
    const pendingStartedAt = new Date().toISOString();
    const previousTurn: Turn = { id: 'previous-web-turn', nativeTurnId: 'native-turn', prompt: 'Repeat this prompt',
      images: [], status: 'completed', codexAccepted: true, items: [], itemTimestamps: {},
      startedAt: previousStartedAt, completedAt: pendingStartedAt };
    const unacceptedTurn: Turn = { id: 'pending-web-turn', prompt: 'Repeat this prompt', images: [],
      status: 'running', codexAccepted: false, phase: 'starting', items: [], itemTimestamps: {}, startedAt: pendingStartedAt };
    const session = await f.state.getSession(f.sessionId);
    assert.ok(session);
    session.threadId = 'shared-thread';
    session.status = 'running';
    session.turns = [previousTurn, unacceptedTurn];
    await f.state.saveSession(session);
    f.control.nativeTurn = { ...previousTurn, id: 'native-turn', prompt: previousTurn.prompt };

    const api = await f.start();
    await waitUntil(async () => (await f.state.getSession(f.sessionId))?.turns.find(turn => turn.id === unacceptedTurn.id)?.status === 'cancelled');

    const persisted = await f.state.getSession(f.sessionId);
    assert.equal(persisted?.turns.find(turn => turn.id === previousTurn.id)?.status, 'completed');
    assert.equal(persisted?.turns.find(turn => turn.id === unacceptedTurn.id)?.nativeTurnId, undefined);
    assert.equal(persisted?.turns.find(turn => turn.id === unacceptedTurn.id)?.status, 'cancelled');
    assert.equal(f.control.runCalls, 0);
    assert.equal(f.control.recoverCalls, 0);
    await f.closeManager(api);
  } finally { await f.close(); }
});
