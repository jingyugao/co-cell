import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Session, Settings, Turn } from '../../protocol/types.js';
import { TurnObserverDetached, type SandboxRuntime } from '../execution/container-runtime.js';
import { SessionManager, type CodexClient } from './manager.js';

const defaults: Settings = { executionMode: 'sandbox', workingDirectory: '/home/user/workspace', model: 'test',
  modelReasoningEffort: 'low', sandboxMode: 'danger-full-access', webSearchMode: 'disabled', networkAccessEnabled: true };
const tick = () => new Promise(resolve => setTimeout(resolve, 5));
async function until(check: () => boolean) {
  for (let i = 0; i < 400; i++) { if (check()) return; await tick(); }
  assert.fail('timed out');
}

test('Web detach persists the same worker; startup recovers it without submitting another prompt; stop still aborts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hive-recovery-'));
  const observers = new Map<string, () => void>();
  let launches = 0, recoveries = 0, stops = 0;
  let observedSignal: AbortSignal | undefined;
  const runtime = {
    async close() {},
    detach(turn: Turn) { observers.get(turn.id)?.(); },
    async *run(session: Session, turn: Turn, signal: AbortSignal, onSandbox: (value: Session['sandbox']) => Promise<void>) {
      launches++;
      const stored = JSON.parse(await readFile(join(directory, `${session.id}.json`), 'utf8')) as Session;
      assert.equal(stored.turns[0].execution?.workerId, turn.execution?.workerId);
      assert.equal(stored.turns[0].execution?.state, 'launching');
      await onSandbox({ id: 'test-sandbox', template: 'test', status: 'ready', workingDirectory: defaults.workingDirectory });
      observedSignal = signal;
      yield { type: 'thread.started', thread_id: 'original-thread' };
      yield { type: 'turn.started' };
      await new Promise<void>(resolve => observers.set(turn.id, resolve));
      throw new TurnObserverDetached();
    },
    async *recover(session: Session, turn: Turn, signal: AbortSignal) {
      recoveries++;
      assert.equal(session.threadId, 'original-thread');
      observedSignal = signal;
      await new Promise<void>(resolve => {
        observers.set(turn.id, resolve);
        signal.addEventListener('abort', () => { stops++; resolve(); }, { once: true });
      });
      if (!signal.aborted) throw new TurnObserverDetached();
      throw new DOMException('stopped', 'AbortError');
    },
  } as unknown as SandboxRuntime;
  const first = new SessionManager({} as CodexClient, directory, defaults, runtime);
  const second = new SessionManager({} as CodexClient, directory, defaults, runtime);
  try {
    await first.init();
    const session = await first.create();
    const turnId = await first.startTurn(session.id, 'perform once');
    await until(() => observers.has(turnId));
    const workerId = first.get(session.id).turns[0].execution!.workerId;
    await first.close();
    assert.equal(observedSignal!.aborted, false);
    assert.equal(first.get(session.id).status, 'running');
    assert.equal(first.get(session.id).turns[0].phase, 'recovering');
    await second.init();
    assert.equal(recoveries, 1);
    assert.equal(launches, 1);
    assert.equal(second.get(session.id).turns[0].execution!.workerId, workerId);
    assert.equal(second.getProject(session.projectId!).activeSessionId, session.id);
    await assert.rejects(second.startTurn(session.id, 'duplicate'), /已有任务/);
    await assert.rejects(second.deleteProject(session.projectId!), /任务|执行|运行/);
    await second.stop(session.id);
    assert.equal(stops, 1);
    assert.equal(second.get(session.id).turns[0].status, 'cancelled');
    assert.equal(second.get(session.id).turns[0].execution!.state, 'terminal');
  } finally {
    await first.close(); await second.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('legacy running turns are cancelled on restart instead of resubmitted', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hive-legacy-'));
  const runtime = { async close() {}, async *run() { assert.fail('must not resubmit'); }, async *recover() { assert.fail('legacy cannot recover'); } } as unknown as SandboxRuntime;
  const first = new SessionManager({} as CodexClient, directory, defaults, runtime);
  const second = new SessionManager({} as CodexClient, directory, defaults, runtime);
  try {
    await first.init();
    const session = await first.create();
    await first.close();
    session.status = 'running';
    session.turns.push({ id: 'legacy', prompt: 'old', images: [], status: 'running', items: [], startedAt: session.createdAt });
    await writeFile(join(directory, `${session.id}.json`), JSON.stringify(session));
    await second.init();
    assert.equal(second.get(session.id).status, 'cancelled');
    assert.match(second.get(session.id).turns[0].error!, /没有可恢复的执行任务/);
  } finally {
    await first.close(); await second.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('a worker for a different sandbox is not registered as a current resource usage on restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hive-recovery-mismatch-'));
  const runtime = { async close() {},
    trackExecution() { assert.fail('must not reserve a worker belonging to another sandbox'); },
    async *recover() { assert.fail('must not recover a worker in a different sandbox'); },
  } as unknown as SandboxRuntime;
  const first = new SessionManager({} as CodexClient, directory, defaults, runtime);
  const second = new SessionManager({} as CodexClient, directory, defaults, runtime);
  try {
    await first.init();
    const session = await first.create();
    await first.close();
    const path = join(directory, 'projects', `${session.projectId}.json`);
    const project = JSON.parse(await readFile(path, 'utf8'));
    project.sandbox = { id: 'current-sandbox', status: 'ready', template: 'test', workingDirectory: defaults.workingDirectory };
    await writeFile(path, JSON.stringify(project));
    session.status = 'running';
    session.turns.push({ id: 'old-turn', prompt: 'test', images: [], items: [], status: 'running', startedAt: session.createdAt,
      execution: { kind: 'sandbox-worker', protocolVersion: 1, workerId: 'old-worker', sandboxId: 'old-sandbox', state: 'detached', lastAppliedSeq: 0 } });
    await writeFile(join(directory, `${session.id}.json`), JSON.stringify(session));
    await second.init();
    assert.equal(second.get(session.id).turns[0].status, 'cancelled');
    assert.equal(second.get(session.id).turns[0].execution?.state, 'terminal');
  } finally {
    await first.close(); await second.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('session archive timestamps are persisted and legacy records are backfilled', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hive-session-archive-'));
  const manager = new SessionManager({} as CodexClient, directory, defaults);
  const restarted = new SessionManager({} as CodexClient, directory, defaults);
  try {
    await manager.init();
    const session = await manager.create({ settings: { executionMode: 'local', workingDirectory: process.cwd() } });
    assert.equal(session.startedAt, session.createdAt);
    assert.equal(session.archivedAt, null);

    const archived = await manager.update(session.id, { archived: true });
    assert.ok(archived.archivedAt);
    assert.equal(archived.startedAt, session.createdAt);
    assert.equal((await manager.update(session.id, { archived: false })).archivedAt, null);

    const legacy = JSON.parse(await readFile(join(directory, `${session.id}.json`), 'utf8')) as Record<string, unknown>;
    delete legacy.startedAt;
    delete legacy.archivedAt;
    await writeFile(join(directory, `${session.id}.json`), JSON.stringify(legacy));
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

test('restart drains a worker whose SDK terminal event was already persisted before Web exit', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hive-finalizing-'));
  let recoveries = 0;
  const runtime = { async close() {}, async *recover() { recoveries++; } } as unknown as SandboxRuntime;
  const first = new SessionManager({} as CodexClient, directory, defaults, runtime);
  const second = new SessionManager({} as CodexClient, directory, defaults, runtime);
  try {
    await first.init();
    const session = await first.create();
    await first.close();
    // Legacy project-less persisted session is migrated with its sandbox on init.
    delete session.projectId;
    session.sandbox = { id: 'test', status: 'ready', template: 'test', workingDirectory: defaults.workingDirectory };
    session.status = 'running';
    session.turns.push({ id: 'finalizing', prompt: 'done', images: [], status: 'completed', phase: 'finalizing',
      items: [], startedAt: session.createdAt,
      execution: { kind: 'sandbox-worker', protocolVersion: 1, workerId: 'worker', lastAppliedSeq: 8, state: 'running' } });
    await writeFile(join(directory, `${session.id}.json`), JSON.stringify(session));
    await second.init();
    await second.waitForIdle(session.id);
    const turn = second.get(session.id).turns[0];
    assert.equal(recoveries, 1);
    assert.equal(turn.status, 'completed');
    assert.equal(turn.execution!.state, 'terminal');
    assert.ok(turn.completedAt);
    assert.equal(turn.error, undefined);
  } finally {
    await first.close(); await second.close();
    await rm(directory, { recursive: true, force: true });
  }
});
