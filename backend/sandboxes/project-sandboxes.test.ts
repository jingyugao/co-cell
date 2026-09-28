import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { SandboxHandle, SandboxInfo } from '@co-cell/sandbox';
import { SandboxManager, type SandboxProvider } from '@co-cell/sandbox';
import type { SandboxState } from '../../protocol/sandbox-types.js';
import type { Session, Turn } from '../../protocol/types.js';
import { CodexAppServerClient } from '../../packages/agentcore/src/index.mjs';
import { ContainerCodexRuntime } from '../execution/container-runtime.js';
import { runTurn } from '../execution/runner.js';
import { ProjectSandboxes } from './project-sandboxes.js';
import type { WorkspaceTarget } from './types.js';
type TurnExecutionDependencies = Parameters<typeof runTurn>[3];
const runtimePaths = { root: '/home/agent/workspace/.cocell', runtime: '/home/agent/workspace/.cocell/runtime',
  codexHome: '/home/agent/workspace/.cocell/codex', node: 'node' };

function fixture() {
  const counts = { create: 0, connect: 0, kill: 0, renew: 0 };
  const sandbox = {
    sandboxId: 'test-sandbox',
    setTimeout: async () => { counts.renew++; },
    files: { exists: async () => { assert.fail('workspace reads must not inspect the Codex installation'); } },
    commands: { run: async () => ({ stdout: JSON.stringify({ confirmed: true }) }) },
  } as unknown as SandboxHandle;
  const provider: SandboxProvider = {
    create: async () => { counts.create++; return sandbox; },
    connect: async () => { counts.connect++; return sandbox; },
    getInfo: async () => ({ sandboxId: sandbox.sandboxId, state: 'running', startedAt: new Date(),
      endAt: new Date(Date.now() + 3 * 3600_000), templateIdentity: {
        reference: 'base:latest', id: `sha256:${'1'.repeat(64)}`, repoDigests: [], version: '20260914.1',
      } }) as SandboxInfo,
    kill: async () => { counts.kill++; return true; },
    pause: async () => true,
  };
  const manager = new SandboxManager({ provider });
  const projects = new ProjectSandboxes(manager, 'base');
  const target: WorkspaceTarget = { id: randomUUID(), projectId: randomUUID(),
    settings: { workingDirectory: '/home/agent/workspace' }, updatedAt: new Date().toISOString() };
  const record: SandboxState = { id: sandbox.sandboxId, template: 'base', status: 'ready', workingDirectory: target.settings.workingDirectory };
  return { counts, sandbox, provider, manager, projects, target, record };
}

test('sibling sessions share one sandbox and a stable project persistence callback', async () => {
  const { counts, manager, projects, target } = fixture();
  const sibling = { ...target, id: randomUUID() };
  const saved: SandboxState[] = [];
  let siblingWrites = 0;
  projects.track(target, async state => { saved.push(state); });
  projects.track(sibling, async () => { siblingWrites++; });
  try {
    const [first, second] = await Promise.all([
      projects.acquire(target, { create: true, usageId: 'first' }),
      projects.acquire(sibling, { create: true, usageId: 'second' }),
    ]);
    assert.equal(counts.create, 1);
    assert.equal(first.sandbox, second.sandbox);
    assert.equal(sibling.sandbox?.id, target.sandbox?.id);
    assert.ok(saved.length > 0);
    assert.equal(saved.at(-1)?.workingDirectory, target.settings.workingDirectory);
    assert.equal(saved.at(-1)?.image?.version, '20260914.1');
    assert.equal(target.sandbox?.image?.id, `sha256:${'1'.repeat(64)}`);
    assert.equal(siblingWrites, 0);
    await first.release();
    await assert.rejects(projects.delete(target), { code: 'busy' });
    await second.release();
    await projects.delete(target);
    assert.equal(counts.kill, 1);
  } finally { await manager.close(); }
});

test('workspace file reads use a protected lease without requiring Codex or a model key', async () => {
  const { counts, sandbox, manager, projects, target, record } = fixture();
  target.sandbox = record;
  projects.track(target, async () => {});
  let finishRead!: () => void;
  let startRead!: () => void;
  const reading = new Promise<void>(resolve => { startRead = resolve; });
  const finished = new Promise<void>(resolve => { finishRead = resolve; });
  sandbox.commands.run = (async () => {
    startRead();
    await finished;
    return { exitCode: 0, stderr: '', stdout: JSON.stringify({ path: '/home/agent/workspace/result.txt', size: 2, data: Buffer.from('ok').toString('base64') }) };
  }) as unknown as typeof sandbox.commands.run;
  const runtime = new ContainerCodexRuntime({ paths: runtimePaths, prepareRemote: async () => false, provider: fixture().provider, apiKey: '', sandboxes: projects });
  try {
    const result = runtime.file(target, '/home/agent/workspace/result.txt');
    await reading;
    await assert.rejects(runtime.delete(target), { code: 'busy' });
    finishRead();
    assert.equal((await result).data.toString(), 'ok');
    assert.equal(counts.create, 0);
    await runtime.delete(target);
    assert.equal(counts.kill, 1);
  } finally { finishRead(); await runtime.close(); await manager.close(); }
});

test('a user stop remains cancelled when App Server reports its interrupted turn as failed', async () => {
  const now = new Date().toISOString();
  const turn: Turn = { id: 'turn', prompt: 'stop me', images: [], items: [], status: 'running', startedAt: now };
  const session: Session = { id: 'session', projectId: 'project', title: 'test', threadId: 'thread', status: 'running',
    startedAt: now, createdAt: now, updatedAt: now, archivedAt: null, turns: [turn],
    settings: { executionMode: 'sandbox', workingDirectory: '/home/agent/workspace', model: 'test', modelReasoningEffort: 'low',
      sandboxMode: 'danger-full-access', webSearchMode: 'disabled', networkAccessEnabled: true } };
  const controller = new AbortController();
  controller.abort();
  const sandbox = { async *run() {
    yield { type: 'turn.started' as const, turn_id: 'native-turn' };
    yield { type: 'turn.failed' as const, error: { message: 'Turn interrupted' } };
  } } as unknown as ContainerCodexRuntime;
  await runTurn(session, turn, controller, {
    client: {} as TurnExecutionDependencies['client'], sandbox,
    save: async () => {}, publish: () => {}, snapshot: () => structuredClone(session), updateSandbox: async () => {},
  });
  assert.equal(turn.status, 'cancelled');
  assert.equal(turn.error, undefined);
});

test('App Server recovery snapshots preserve native status, prompt, and full items', async () => {
  const { provider, projects, manager } = fixture();
  const runtime = new ContainerCodexRuntime({ paths: runtimePaths, prepareRemote: async () => false, provider, apiKey: '', sandboxes: projects });
  try {
    const running = runtime['mapAppServerTurn']({ id: 'native-turn', status: 'inProgress', startedAt: 1,
      items: [
        { type: 'userMessage', content: [{ type: 'text', text: 'continue after restart' }] },
        { type: 'commandExecution', id: 'command', command: 'sleep 1', status: 'inProgress', aggregatedOutput: 'working' },
      ] });
    assert.equal(running.status, 'running');
    assert.equal(running.prompt, 'continue after restart');
    assert.deepEqual(running.items[0], { id: 'command', type: 'command_execution', command: 'sleep 1',
      aggregated_output: 'working', status: 'in_progress' });

    const completed = runtime['mapAppServerTurn']({ id: 'native-turn', status: 'completed', startedAt: 1, completedAt: 2,
      items: [{ type: 'agentMessage', id: 'answer', text: 'done' }] });
    assert.equal(completed.status, 'completed');
    assert.equal(completed.completedAt, '1970-01-01T00:00:02.000Z');
    assert.deepEqual(completed.items, [{ id: 'answer', type: 'agent_message', text: 'done' }]);
  } finally { await runtime.close(); await manager.close(); }
});

test('App Server recovery polls the accepted native turn and never starts another turn', async () => {
  const { provider, projects, manager, target, record } = fixture();
  const turn: Turn = { id: randomUUID(), nativeTurnId: 'native-turn', codexAccepted: true, prompt: '', images: [], items: [],
    status: 'running', startedAt: target.updatedAt };
  const session: Session = { ...target, sandbox: record, title: 'test', threadId: 'thread-1', status: 'running',
    startedAt: target.updatedAt, createdAt: target.updatedAt, archivedAt: null, turns: [turn],
    settings: { ...target.settings, executionMode: 'sandbox', model: 'test', modelReasoningEffort: 'low',
      sandboxMode: 'danger-full-access', webSearchMode: 'disabled', networkAccessEnabled: false } };
  let listCalls = 0, startCalls = 0;
  const originalSpawn = CodexAppServerClient.spawn;
  CodexAppServerClient.spawn = (async () => ({
    request: async (method: string) => {
      if (method === 'turn/start') { startCalls++; assert.fail('recovery must not start a turn'); }
      assert.equal(method, 'thread/turns/list');
      listCalls++;
      return { data: [{ id: 'native-turn', status: 'completed', startedAt: 1, completedAt: 2,
        items: [{ type: 'agentMessage', id: 'answer', text: 'done after restart' }] }] };
    },
    turnInterrupt: async () => ({}),
    close: async () => {},
  })) as unknown as typeof CodexAppServerClient.spawn;
  const runtime = new ContainerCodexRuntime({ paths: runtimePaths, prepareRemote: async () => false, provider, apiKey: '', sandboxes: projects,
    appServer: async () => ({ url: 'ws://app-server.test', token: 'x'.repeat(24) }) });
  runtime.track(session, async () => {});
  try {
    const events = [];
    for await (const event of runtime.recover(session, turn, new AbortController().signal, async () => {})) events.push(event);
    assert.equal(listCalls, 1);
    assert.equal(startCalls, 0);
    assert.deepEqual(events.map(event => event.type), ['turn.started', 'item.completed', 'turn.completed']);
  } finally {
    CodexAppServerClient.spawn = originalSpawn;
    await runtime.close(); await manager.close();
  }
});
