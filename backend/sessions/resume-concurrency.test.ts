import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Project, Settings } from '../../protocol/types.js';
import type { SandboxRuntime } from '../execution/container-runtime.js';
import { MemoryCoordinator, type SharedLease } from '../infra/storage/coordination.js';
import { MemoryWebStateStore } from '../testing/memory-web-state.js';
import { SessionManager, type CodexClient } from './manager.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

const settings: Settings = { executionMode: 'sandbox', workingDirectory: '/home/agent/workspace', model: 'test',
  modelReasoningEffort: 'low', sandboxMode: 'danger-full-access', webSearchMode: 'disabled', networkAccessEnabled: true };

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'cocell-resume-concurrent-'));
  const state = new MemoryWebStateStore();
  const coordinator = new MemoryCoordinator();
  const at = new Date().toISOString();
  const project: Project = { id: 'resume-project', name: 'Resume test', status: 'active', requirementUrl: null,
    executionMode: 'sandbox', workingDirectory: settings.workingDirectory, completedAt: null, archivedAt: null,
    createdAt: at, updatedAt: at, sandbox: { id: 'resume-box', status: 'paused', template: 'test',
      workingDirectory: settings.workingDirectory, pausedAt: at } };
  await state.saveProject(project);
  await state.saveSession({ id: 'resume-session', projectId: project.id, title: 'Session', threadId: null,
    settings, status: 'idle', archivedAt: null, createdAt: at, startedAt: at, updatedAt: at, turns: [], sandbox: project.sandbox });
  const managers: SessionManager[] = [];
  const workers: Array<{ started: ReturnType<typeof deferred>; finish: ReturnType<typeof deferred>; calls: number; signal?: AbortSignal }> = [];
  let ready = false;
  const start = async () => {
    const worker = { started: deferred(), finish: deferred(), calls: 0, signal: undefined as AbortSignal | undefined };
    workers.push(worker);
    const runtime = {
      async close() {},
      async querySandbox(sandbox) { return { ...sandbox, status: ready ? 'ready' as const : 'paused' as const }; },
      async resume(target, signal) {
        worker.calls++; worker.signal = signal; worker.started.resolve();
        // Deliberately emulate a remote call that was accepted before cancellation.
        await worker.finish.promise;
        ready = true;
        return { ...target.sandbox!, status: 'ready', pausedAt: undefined };
      },
    } satisfies Partial<SandboxRuntime>;
    const manager = new SessionManager({} as CodexClient, directory, settings, state, runtime as SandboxRuntime,
      undefined, undefined, undefined, undefined, undefined, coordinator);
    managers.push(manager);
    await manager.init();
    return manager;
  };
  const drain = (manager: SessionManager) => (manager as unknown as { sandboxOperations: { close(): Promise<void> } }).sandboxOperations.close();
  const recover = (manager: SessionManager) => (manager as unknown as { recoverSharedExecutions(): Promise<void> }).recoverSharedExecutions();
  return { state, coordinator, project, workers, start, drain, recover, async close() {
    for (const worker of workers) worker.finish.resolve();
    for (const manager of managers) await manager.close();
    await coordinator.close();
    await rm(directory, { recursive: true, force: true });
  } };
}

test('two APIs join one resume without a project lease; metadata edits survive its terminal commit', async () => {
  const f = await fixture();
  try {
    const a = await f.start(), b = await f.start();
    let mutations = 0, callbackWrites = 0;
    const mutate = f.state.mutateProject.bind(f.state), save = f.state.saveProject.bind(f.state);
    f.state.mutateProject = (id, change) => mutate(id, current => {
      const before = JSON.stringify(current); change(current);
      if (JSON.stringify(current) !== before) mutations++;
    });
    f.state.saveProject = async (...args) => { callbackWrites++; return save(...args); };
    const accepted = await a.resumeProjectSandbox(f.project.id);
    await f.workers[0].started.promise;
    let crossReplicaWaitFinished = false;
    const waitStartedAt = Date.now();
    const crossReplicaWait = b.readProject(f.project.id, { waitForOperation: accepted.sandboxOperation!.id!, waitMs: 300 })
      .then(project => { crossReplicaWaitFinished = true; return project; });
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(crossReplicaWaitFinished, false, 'a replica without a local waiter must honor the durable wait budget');
    const timedOut = await crossReplicaWait;
    assert.ok(Date.now() - waitStartedAt >= 250, 'cross-replica waiting should poll state rather than return immediately');
    assert.equal(timedOut.sandboxOperation?.status, 'running');
    const waiterController = new AbortController();
    const cancelledWait = b.readProject(f.project.id, { waitForOperation: accepted.sandboxOperation!.id!, waitMs: 5_000 }, waiterController.signal);
    await new Promise(resolve => setTimeout(resolve, 30));
    waiterController.abort(new Error('caller stopped waiting'));
    await assert.rejects(cancelledWait, /caller stopped waiting/);
    assert.equal((await f.state.getProject(f.project.id))?.sandboxOperation?.status, 'running', 'cancelling a waiter leaves durable work running');
    assert.equal(f.workers[0].signal?.aborted, false, 'HTTP waiter cancellation must not cancel the runtime owner');
    const joined = await b.resumeProjectSandbox(f.project.id);
    assert.equal(joined.sandboxOperation?.id, accepted.sandboxOperation?.id);
    assert.equal(f.workers[1].calls, 0);
    for (const scope of ['project-control', 'project-maintenance']) {
      const lease = await f.coordinator.tryAcquire(`${scope}:${f.project.id}`);
      assert(lease, `${scope} must not be held during restore`);
      await lease.release();
    }
    await b.updateProject(f.project.id, { name: 'Edited during restore' });
    await assert.rejects(b.checkpointProjectSandbox(f.project.id), /恢复|维护/);
    await assert.rejects(b.deleteProject(f.project.id), /恢复|维护/);
    await assert.rejects(b.startTurn('resume-session', 'must wait'), /恢复|维护/);
    await f.recover(b);
    assert.equal(f.workers[1].calls, 0, 'a live owner must never be stolen');
    f.workers[0].finish.resolve();
    await f.drain(a);
    const finished = await f.state.getProject(f.project.id);
    assert.equal(finished?.name, 'Edited during restore');
    assert.equal(finished?.sandboxOperation?.id, accepted.sandboxOperation?.id);
    assert.equal(finished?.sandboxOperation?.status, 'succeeded');
    assert.equal(finished?.sandbox?.pausedAt, undefined);
    assert.equal(mutations, 2, 'normal resume persists acceptance and completion only');
    assert.equal(callbackWrites, 1, 'only the unrelated project rename uses saveProject');
  } finally { await f.close(); }
});

test('resume admission reports a competing project mutation immediately instead of queuing', async () => {
  const f = await fixture();
  try {
    const api = await f.start();
    const lease = await f.coordinator.tryAcquire(`project-control:${f.project.id}`);
    assert(lease);
    try {
      await assert.rejects(api.resumeProjectSandbox(f.project.id), /正在提交其他操作/);
      assert.equal(f.workers[0].calls, 0);
    } finally { await lease.release(); }
  } finally { await f.close(); }
});

test('a lost terminal commit acknowledgement observes durable success without repeating restore', async () => {
  const f = await fixture();
  try {
    const api = await f.start();
    let lost = false;
    const mutate = f.state.mutateProject.bind(f.state);
    f.state.mutateProject = async (id, change) => {
      const result = await mutate(id, change);
      if (!lost && result.sandboxOperation?.status === 'succeeded') {
        lost = true;
        throw new Error('commit acknowledgement lost');
      }
      return result;
    };
    await api.resumeProjectSandbox(f.project.id);
    f.workers[0].finish.resolve();
    await f.drain(api);
    assert(lost);
    assert.equal((await f.state.getProject(f.project.id))?.sandboxOperation?.status, 'succeeded');
    assert.equal(f.workers[0].calls, 1);
  } finally { await f.close(); }
});

test('a dead API resume is recovered under the same operation ID and its late result cannot publish', async () => {
  const f = await fixture();
  try {
    const a = await f.start(), b = await f.start();
    const accepted = await a.resumeProjectSandbox(f.project.id);
    await f.workers[0].started.promise;
    const presence = (a as unknown as { apiPresence: SharedLease & { controller: AbortController } }).apiPresence;
    presence.controller.abort(new Error('simulated connection loss'));
    await presence.release();
    assert.equal(f.workers[0].signal?.aborted, true);
    await f.recover(b);
    await f.workers[1].started.promise;
    const transferred = await f.state.getProject(f.project.id);
    assert.equal(transferred?.sandboxOperation?.id, accepted.sandboxOperation?.id);
    assert.notEqual(transferred?.sandboxOperation?.resume?.ownerId, accepted.sandboxOperation?.resume?.ownerId);
    f.workers[0].finish.resolve();
    await f.drain(a);
    assert.equal((await f.state.getProject(f.project.id))?.sandboxOperation?.status, 'running', 'late old owner cannot complete or fail the successor');
    f.workers[1].finish.resolve();
    await f.drain(b);
    assert.equal((await f.state.getProject(f.project.id))?.sandboxOperation?.status, 'succeeded');
    await a.resumeProjectSandbox(f.project.id);
    await f.drain(a);
    const reconnected = await f.state.getProject(f.project.id);
    assert.equal(f.workers[0].calls, 2, 'the disconnected API can resume again without a restart');
    assert.equal(f.workers[0].signal?.aborted, false);
    assert.notEqual(reconnected?.sandboxOperation?.resume?.ownerId, accepted.sandboxOperation?.resume?.ownerId);
    assert.equal(reconnected?.sandboxOperation?.status, 'succeeded');
  } finally { await f.close(); }
});

test('an API reconnects with a new owner epoch while its cancelled worker is still returning', async () => {
  const f = await fixture();
  try {
    const api = await f.start();
    const accepted = await api.resumeProjectSandbox(f.project.id);
    await f.workers[0].started.promise;
    const oldSignal = f.workers[0].signal;
    const presence = (api as unknown as { apiPresence: SharedLease & { controller: AbortController } }).apiPresence;
    presence.controller.abort(new Error('simulated connection loss'));
    await presence.release();
    await f.recover(api);
    const recovered = await f.state.getProject(f.project.id);
    assert.equal(recovered?.sandboxOperation?.id, accepted.sandboxOperation?.id);
    assert.notEqual(recovered?.sandboxOperation?.resume?.ownerId, accepted.sandboxOperation?.resume?.ownerId);
    assert.equal(f.workers[0].calls, 2);
    assert.equal(oldSignal?.aborted, true);
    assert.equal(f.workers[0].signal?.aborted, false);
    f.workers[0].finish.resolve();
    await f.drain(api);
    const finished = await f.state.getProject(f.project.id);
    assert.equal(finished?.sandboxOperation?.status, 'succeeded');
    assert.equal(finished?.sandboxOperation?.resume?.ownerId, recovered?.sandboxOperation?.resume?.ownerId);
  } finally { await f.close(); }
});

test('single-API startup replays an unknown resume outcome with the same durable operation ID', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cocell-local-resume-recovery-'));
  const state = new MemoryWebStateStore();
  const at = new Date().toISOString();
  const operationId = 'resume-recovery-operation';
  const project: Project = { id: 'resume-project', name: 'Resume test', status: 'active', requirementUrl: null,
    executionMode: 'sandbox', workingDirectory: settings.workingDirectory, completedAt: null, archivedAt: null,
    createdAt: at, updatedAt: at, sandbox: { id: 'resume-box', status: 'paused', template: 'test',
      workingDirectory: settings.workingDirectory, pausedAt: at },
    sandboxOperation: { id: operationId, kind: 'resume', phase: '恢复中', status: 'running', updatedAt: at,
      resume: { sandboxId: 'resume-box', ownerId: 'previous-api' } } };
  await state.saveProject(project);
  let calls = 0;
  const operationIds: string[] = [];
  const runtime = {
    async close() {},
    async querySandbox(sandbox) { return { ...sandbox, status: 'paused' as const }; },
    async resume(target, _signal, currentOperationId) {
      assert(currentOperationId);
      calls++; operationIds.push(currentOperationId);
      if (calls === 1) throw Object.assign(new Error('response lost after accepting command'), { code: 'UNKNOWN_OUTCOME' });
      return { ...target.sandbox!, status: 'ready' as const, pausedAt: undefined };
    },
  } satisfies Partial<SandboxRuntime>;
  const manager = new SessionManager({} as CodexClient, directory, settings, state, runtime as SandboxRuntime);
  try {
    await manager.init();
    const deadline = Date.now() + 4_000;
    let current = await state.getProject(project.id);
    while (current?.sandboxOperation?.status === 'running' && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 25));
      current = await state.getProject(project.id);
    }
    assert.equal(current?.sandboxOperation?.id, operationId);
    assert.equal(current?.sandboxOperation?.status, 'succeeded', JSON.stringify(current?.sandboxOperation));
    assert.equal(calls, 2, 'the local reconciler retries the unknown operation after its first worker exits');
    assert.deepEqual(operationIds, [operationId, operationId], 'recovery preserves Cellbox idempotency identity');
    assert.equal(current?.sandboxOperation?.result?.sandbox.id, 'resume-box');
  } finally { await manager.close(); await rm(directory, { recursive: true, force: true }); }
});
