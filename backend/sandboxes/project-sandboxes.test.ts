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
import { CellboxError } from '../../packages/sandbox/src/providers/cellbox/client.js';
type TurnExecutionDependencies = Parameters<typeof runTurn>[3];
const runtimePaths = { root: '/home/agent/workspace/.cocell', runtime: '/home/agent/workspace/.cocell/runtime',
  codexHome: '/home/agent/workspace/.cocell/codex', node: '/usr/local/bin/node' };

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

test('live Sandbox queries ignore reference status without preparing, connecting or persisting', async () => {
  const { provider, projects, counts, target, record } = fixture();
  let writes = 0;
  target.sandbox = { ...record, status: 'unknown' };
  projects.track(target, async () => { writes++; });
  const runtime = new ContainerCodexRuntime({ paths: runtimePaths, prepareRemote: async () => { assert.fail('query prepared the runtime'); },
    provider, apiKey: '', sandboxes: projects });
  const source = { ...record, status: 'unavailable' as const };
  const original = provider.getInfo;
  try {
    assert.equal((await runtime.querySandbox(source)).status, 'ready');
    assert.equal(source.status, 'unavailable');
    for (const phase of ['creating', 'resuming', 'suspending', 'staged']) {
      provider.getInfo = async id => ({ ...await original(id), state: 'unknown', metadata: { phase } });
      assert.equal((await runtime.querySandbox(source)).status, 'starting');
    }
    provider.getInfo = async id => ({ ...await original(id), state: 'paused', metadata: { phase: 'suspended' } });
    assert.equal((await runtime.querySandbox(source)).status, 'paused');
    provider.getInfo = async () => { throw new CellboxError('NOT_FOUND', 'gone'); };
    assert.equal((await runtime.querySandbox(source)).status, 'unavailable');
    provider.getInfo = async () => { throw new CellboxError('TRANSPORT', 'unreachable'); };
    await assert.rejects(runtime.querySandbox(source), /unreachable/);
    assert.equal(writes, 0);
    assert.deepEqual(counts, { create: 0, connect: 0, kill: 0, renew: 0 });
  } finally { await runtime.close(); }
});

test('batch observations map missing and transitional boxes without per-box reads', async () => {
  const { provider, projects, record } = fixture();
  let calls = 0;
  provider.getInfo = async () => { assert.fail('batch used per-box inspection'); };
  provider.getInfos = async ids => {
    calls++;
    assert.deepEqual(ids, ['running', 'paused', 'restoring', 'checkpointing', 'missing']);
    return ['running', 'paused', 'restoring', 'checkpointing'].map(id => ({ sandboxId: id,
      state: id === 'running' ? 'running' as const : id === 'paused' ? 'paused' as const : 'unknown' as const,
      startedAt: new Date(), endAt: new Date(), metadata: { phase: id } }));
  };
  const runtime = new ContainerCodexRuntime({ paths: runtimePaths, provider, apiKey: '', sandboxes: projects,
    prepareRemote: async () => { assert.fail('batch prepared runtime'); } });
  try {
    const ids = ['running', 'paused', 'restoring', 'checkpointing', 'missing', 'running'];
    const observed = await runtime.querySandboxes(ids.map(id => ({ ...record, id })));
    assert.deepEqual(observed.map(box => box.status), ['ready', 'paused', 'starting', 'starting', 'unavailable', 'ready']);
    assert.equal(calls, 1);
    provider.getInfos = async () => { throw new Error('source unavailable'); };
    await assert.rejects(runtime.querySandboxes([record]), /source unavailable/);
  } finally { await runtime.close(); }
});

test('rebuild replaces a missing box but preserves the binding on a transport failure', async () => {
  const { provider, manager, projects, target, sandbox, counts } = fixture();
  target.sandbox = { id: 'removed-box', status: 'unavailable', template: 'base', workingDirectory: target.settings.workingDirectory };
  const saved: SandboxState[] = [];
  projects.track(target, async state => { saved.push(state); });
  const originalInfo = provider.getInfo;
  let transportError = true;
  provider.getInfo = async id => {
    if (id === 'removed-box') throw new CellboxError(transportError ? 'TRANSPORT' : 'NOT_FOUND', 'Box lookup failed');
    return originalInfo(id);
  };
  sandbox.files.write = async () => {};
  sandbox.files.rename = async () => {};
  sandbox.files.remove = async () => {};
  const runtime = new ContainerCodexRuntime({ paths: runtimePaths, prepareRemote: async () => false,
    provider, apiKey: '', sandboxes: projects, sharedDataDirectory: new URL('file:///nonexistent-cocell-fixture/') });
  try {
    await assert.rejects(runtime.rebuild(target, async state => { saved.push(state); }), /Box lookup failed/);
    assert.equal(counts.create, 0);
    assert.equal(manager.peek(`project:${target.projectId}`)?.id, 'removed-box');
    transportError = false;
    await assert.rejects(projects.inspect(target), { code: 'not_accessible' });
    await runtime.rebuild(target, async state => { saved.push(state); });
    assert.equal(counts.create, 1);
    assert.equal(counts.kill, 0);
    assert.equal(manager.peek(`project:${target.projectId}`)?.id, sandbox.sandboxId);
    assert.equal(saved.at(-1)?.id, sandbox.sandboxId);
  } finally { await runtime.close(); }
});

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

test('project image selection reaches sandbox creation and overrides the default image identity', async () => {
  const { provider, manager, projects, target, sandbox } = fixture();
  const selection = { imageId: 'python', imageName: 'Python', category: '开发', versionId: 'v1', version: 'v1',
    importedImageId: 'imported-python-v1', image: 'registry/python@sha256:pinned' };
  target.imageSelection = selection;
  provider.create = async (_template, options) => {
    assert.equal(options.metadata?.cellboxImportedImageId, selection.importedImageId);
    return sandbox;
  };
  const runtime = new ContainerCodexRuntime({ paths: runtimePaths, prepareRemote: async () => false, provider, apiKey: '', sandboxes: projects });
  try {
    const lease = await projects.acquire(target, { create: true, save: async () => {} });
    assert.equal((await runtime.currentImageIdentity(target)).id, selection.image);
    await lease.release();
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
  sandbox.files.readBytes = async () => {
    startRead();
    await finished;
    return Buffer.from('ok');
  };
  sandbox.commands.run = (async () => { assert.fail('file reads must use the native API'); }) as typeof sandbox.commands.run;
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

test('file streaming retains the sandbox lease until completion, cancellation or disconnect', async () => {
  for (const ending of ['complete', 'cancel', 'disconnect'] as const) {
    const { sandbox, provider, manager, projects, target, record } = fixture();
    target.sandbox = record;
    projects.track(target, async () => {});
    let source!: ReadableStreamDefaultController<Uint8Array>;
    let cancelled = false;
    sandbox.files.readResponse = async (path, options) => {
      assert.equal(path, '/home/agent/workspace/file.txt');
      assert.equal(options?.headers?.get('range'), 'bytes=0-4');
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) { source = controller; controller.enqueue(Buffer.from('hello')); },
        cancel() { cancelled = true; },
      }), { status: 206, headers: { 'Content-Range': 'bytes 0-4/10' } });
    };
    const runtime = new ContainerCodexRuntime({ paths: runtimePaths, prepareRemote: async () => false, provider, apiKey: '', sandboxes: projects });
    const abort = new AbortController();
    const request = new Request('http://localhost/files', { signal: abort.signal, headers: { Range: 'bytes=0-4' } });
    try {
      const response = await runtime.fileResponse(target, '/home/agent/workspace/file.txt', request);
      assert.equal(response.status, 206);
      await assert.rejects(runtime.delete(target), { code: 'busy' });
      if (ending === 'complete') { source.close(); assert.equal(await response.text(), 'hello'); }
      else if (ending === 'cancel') { await response.body!.cancel(); assert.equal(cancelled, true); }
      else {
        abort.abort();
        // Allow the asynchronous stream cancellation to finish releasing the lease.
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(cancelled, true);
      }
      await runtime.delete(target);
    } finally { abort.abort(); await runtime.close(); await manager.close(); }
  }
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
