import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { SandboxHandle, SandboxInfo } from '@co-cell/sandbox';
import type { SandboxProvider } from '@co-cell/sandbox';
import type { SandboxState } from '../../protocol/sandbox-types.js';
import type { Session, StreamMessage, Turn } from '../../protocol/types.js';
import { CodexAppServerClient } from '../../packages/agentcore/src/index.mjs';
import { ContainerCodexRuntime } from '../execution/container-runtime.js';
import { AppServerReader } from '../execution/app-server-reader.js';
import { runTurn } from '../execution/runner.js';
import { ProjectSandboxes } from './project-sandboxes.js';
import type { WorkspaceTarget } from './types.js';
import { CellboxError } from '../../packages/sandbox/src/providers/cellbox/client.js';
import { CellboxSandboxProvider, type CellboxBox, type CellboxOperation } from '../../packages/sandbox/src/providers/cellbox/index.js';
type TurnExecutionDependencies = Parameters<typeof runTurn>[3];
const runtimePaths = { root: '/home/agent/workspace/.cocell', runtime: '/home/agent/workspace/.cocell/runtime',
  codexHome: '/home/agent/workspace/.cocell/codex', node: '/usr/local/bin/node' };

test('Sandbox stream publishes every delta but persists only thread, turn, and terminal boundaries', async () => {
  const now = new Date().toISOString();
  const turn: Turn = { id: 'turn', prompt: 'stream', images: [], items: [], status: 'running', startedAt: now };
  const session: Session = { id: 'session', projectId: 'project', title: 'test', threadId: null, status: 'running',
    startedAt: now, createdAt: now, updatedAt: now, archivedAt: null, turns: [turn],
    settings: { executionMode: 'sandbox', workingDirectory: '/workspace', model: 'test', modelReasoningEffort: 'low',
      sandboxMode: 'danger-full-access', webSearchMode: 'disabled', networkAccessEnabled: true } };
  const events = [
    { type: 'thread.started' as const, thread_id: 'thread' },
    { type: 'turn.started' as const, turn_id: 'native-turn' },
    ...['a', 'ab', 'abc'].map(text => ({ type: 'item.updated' as const,
      item: { id: 'answer', type: 'agent_message' as const, text } })),
    { type: 'runtime.context_usage' as const, contextUsage: { inputTokens: 10, observedAt: now } },
    { type: 'item.completed' as const, item: { id: 'answer', type: 'agent_message' as const, text: 'final answer' } },
    { type: 'turn.completed' as const, usage: { input_tokens: 10, cached_input_tokens: 0, cache_write_input_tokens: 0,
      output_tokens: 3, reasoning_output_tokens: 0 } },
  ];
  const sandbox = { async *run() { yield* events; } } as unknown as ContainerCodexRuntime;
  const saved: Session[] = [];
  const published: StreamMessage[] = [];
  await runTurn(session, turn, new AbortController(), {
    client: {} as TurnExecutionDependencies['client'], sandbox,
    save: async () => { saved.push(structuredClone(session)); },
    publish: message => published.push(message), snapshot: () => structuredClone(session), updateSandbox: async () => {},
  });
  assert.equal(published.filter(message => message.type === 'sdk').length, events.length);
  assert.equal(saved.length, 3, 'only thread.started, turn.started, and final status should be persisted');
  const finalTurn = saved.at(-1)?.turns[0];
  const finalItem = finalTurn?.items[0];
  assert.equal(finalItem?.type === 'agent_message' ? finalItem.text : undefined, 'final answer');
  assert.equal(finalTurn?.status, 'completed');
});

test('async user-input requests are persisted before they are published while ordinary items stay in native history', async () => {
  const now = new Date().toISOString();
  const turn: Turn = { id: 'turn', prompt: 'ask me', images: [], items: [], status: 'running', startedAt: now };
  const session: Session = { id: 'session', projectId: 'project', title: 'test', threadId: null, status: 'running',
    startedAt: now, createdAt: now, updatedAt: now, archivedAt: null, turns: [turn],
    settings: { executionMode: 'sandbox', workingDirectory: '/workspace', model: 'test', modelReasoningEffort: 'low',
      sandboxMode: 'danger-full-access', webSearchMode: 'disabled', networkAccessEnabled: true } };
  const question = { id: 'question', type: 'agent_message' as const, delivery: 'async' as const, text: '',
    questions: [{ title: 'Continue?', options: ['yes', 'no'] }] };
  const events = [
    { type: 'thread.started' as const, thread_id: 'thread' },
    { type: 'turn.started' as const, turn_id: 'native-turn' },
    ...['one', 'two', 'three'].map(text => ({ type: 'item.updated' as const,
      item: { id: 'tool', type: 'command_execution' as const, command: 'run', aggregated_output: text, status: 'in_progress' as const } })),
    { type: 'item.completed' as const, item: question },
    { type: 'turn.completed' as const },
  ];
  const sandbox = { async *run() { yield* events; } } as unknown as ContainerCodexRuntime;
  const saved: Session[] = [];
  let publishedQuestionSawSave = false;
  await runTurn(session, turn, new AbortController(), {
    client: {} as TurnExecutionDependencies['client'], sandbox,
    save: async () => { saved.push(structuredClone(session)); },
    publish: message => {
      if (message.type === 'sdk' && message.event.type === 'item.completed' && message.event.item.id === question.id) {
        publishedQuestionSawSave = saved.at(-1)?.turns[0].userInputRequests?.[0].id === question.id;
      }
    }, snapshot: () => structuredClone(session), updateSandbox: async () => {},
  });
  assert.equal(saved.length, 4, 'thread, accepted turn, async question, and final status should be persisted');
  assert.equal(publishedQuestionSawSave, true, 'question must be durable before another API instance can answer it');
  assert.equal(saved[2].turns[0].userInputRequests?.[0].id, question.id);
  assert.equal(saved[2].turns[0].items.some(item => item.id === question.id), true);
});

test('history and descendant transcripts use only a shared App Server connection, including archived and paginated children', async t => {
  const { provider, projects, counts, target, record } = fixture();
  const session: Session = { ...target, sandbox: record, title: 'test', threadId: 'root', status: 'completed',
    startedAt: target.updatedAt, createdAt: target.updatedAt, archivedAt: null, turns: [],
    settings: { ...target.settings, executionMode: 'sandbox', model: 'test', modelReasoningEffort: 'low',
      sandboxMode: 'danger-full-access', webSearchMode: 'disabled', networkAccessEnabled: false } };
  let connects = 0, endpoints = 0, closes = 0, historyPages = 0;
  t.mock.method(CodexAppServerClient.prototype, 'connect', async () => { connects++; });
  t.mock.method(CodexAppServerClient.prototype, 'close', async () => { closes++; });
  const child = (id: string, parent: string, depth: number, createdAt: number) => ({ id, createdAt,
    source: { subAgent: { thread_spawn: { parent_thread_id: parent, agent_path: `/root/${id}`,
      agent_nickname: `${id}-nickname`, depth } } } });
  t.mock.method(CodexAppServerClient.prototype, 'request', async (method: string, params: any) => {
    if (method === 'thread/list') {
      assert.equal(params.ancestorThreadId, 'root');
      assert.deepEqual(params.sourceKinds, ['subAgentThreadSpawn']);
      assert.equal(params.useStateDbOnly, true);
      if (params.archived) return { data: [child('grandchild', 'child', 2, 3)] };
      return params.cursor ? { data: [child('other', 'unrelated-root', 1, 0)] }
        : { data: [child('child', 'root', 1, 2)], nextCursor: 'thread-page-2' };
    }
    assert.equal(method, 'thread/turns/list');
    assert.equal(params.itemsView, 'full');
    if (params.threadId === 'root') {
      historyPages++;
      assert.equal(params.sortDirection, 'desc');
      assert.equal(params.limit, 20);
      assert.equal(params.cursor, 'older');
      return { data: [], nextCursor: 'even-older' };
    }
    assert(['child', 'grandchild'].includes(params.threadId), 'unrelated history must not be read');
    assert.equal(params.sortDirection, 'asc');
    return { data: [{ id: `${params.threadId}-${params.cursor ?? 'first'}`, status: 'completed', startedAt: 4,
      items: [{ type: 'userMessage', id: 'injected', content: [{ type: 'text', text: 'private injected prompt' }] },
        { type: 'agentMessage', id: 'answer', text: 'visible answer' }] }],
      nextCursor: params.threadId === 'child' && !params.cursor ? 'turn-page-2' : null };
  });
  const runtime = new ContainerCodexRuntime({ paths: runtimePaths, sandboxes: projects, provider, apiKey: '',
    prepareRemote: async () => { assert.fail('reads must not prepare the Sandbox'); },
    acquireRemoteUsage: async () => { assert.fail('reads must not lease the Sandbox'); },
    appServer: async () => { endpoints++; return { url: 'ws://app-server.test' }; } });
  try {
    const [history, agents] = await Promise.all([runtime.history(session, { cursor: 'older' }), runtime.subagents(session)]);
    assert.equal(history.nextCursor, 'even-older');
    assert.equal(historyPages, 1);
    assert.deepEqual(agents.map(agent => [agent.threadId, agent.parentThreadId, agent.depth, agent.turns.length]),
      [['child', 'root', 1, 2], ['grandchild', 'child', 2, 1]]);
    assert.equal(agents[0].path, '/root/child');
    assert.equal(agents[0].nickname, 'child-nickname');
    assert(agents.every(agent => agent.turns.every(turn => turn.prompt === '' && turn.items[0].type === 'agent_message')));
    assert.equal(connects, 1);
    assert.equal(endpoints, 1);
    assert.equal(closes, 0);
    assert.deepEqual(counts, { create: 0, connect: 0, kill: 0, renew: 0 });
  } finally { await runtime.close(); }
  assert.equal(closes, 1);
});

function fixture() {
  const counts = { create: 0, connect: 0, kill: 0, renew: 0 };
  const connectedIds: string[] = [];
  const sandbox = {
    sandboxId: 'test-sandbox',
    files: { exists: async () => { assert.fail('workspace reads must not inspect the Codex installation'); } },
    commands: { run: async () => ({ stdout: JSON.stringify({ confirmed: true }) }) },
  } as unknown as SandboxHandle;
  const provider: SandboxProvider = {
    create: async () => { counts.create++; return sandbox; },
    connect: async id => { counts.connect++; connectedIds.push(id); return { ...sandbox, sandboxId: id } as SandboxHandle; },
    getInfo: async id => ({ sandboxId: id, state: 'running', startedAt: new Date(),
      endAt: new Date(Date.now() + 3 * 3600_000), templateIdentity: {
        reference: 'base:latest', id: `sha256:${'1'.repeat(64)}`, repoDigests: [], version: '20260914.1',
      } }) as SandboxInfo,
    kill: async () => { counts.kill++; return true; },
    pause: async () => true,
  };
  const projects = new ProjectSandboxes(provider, 'base');
  const target: WorkspaceTarget = { id: randomUUID(), projectId: randomUUID(),
    settings: { workingDirectory: '/home/agent/workspace' }, updatedAt: new Date().toISOString() };
  const record: SandboxState = { id: sandbox.sandboxId, template: 'base', status: 'ready', workingDirectory: target.settings.workingDirectory };
  return { counts, connectedIds, sandbox, provider, projects, target, record };
}

test('pause and resume only submit Cellbox actions despite unavailable App Server', async () => {
  const calls: string[] = [];
  const provider = new CellboxSandboxProvider({ baseUrl: 'http://cellbox.test', profileId: 'k8s', revisionId: 'rev-a', fetch: async (input, init) => {
    const url = new URL(String(input));
    calls.push(`${init?.method ?? 'GET'} ${url.pathname}`);
    assert.equal(new Headers(init?.headers).has('Idempotency-Key'), false);
    assert.equal(init?.body, undefined);
    const kind = url.pathname.endsWith(':resume') ? 'resume' : 'suspend';
    assert.equal(init?.method, 'POST');
    assert.equal(url.pathname, `/v1/boxes/test-sandbox:${kind}`);
    return Response.json({ id: `operation-${kind}`, kind, targetId: 'test-sandbox', status: 'succeeded', version: 1, createdAt: new Date().toISOString() });
  } });
  const projects = new ProjectSandboxes(provider, 'k8s');
  const target: WorkspaceTarget = { id: 'project-one', projectId: 'project-one', updatedAt: new Date().toISOString(),
    settings: { workingDirectory: '/home/agent/workspace' },
    sandbox: { id: 'test-sandbox', template: 'k8s', status: 'unavailable', workingDirectory: '/home/agent/workspace' } };
  const runtime = new ContainerCodexRuntime({ paths: runtimePaths, sandboxes: projects, provider, apiKey: '',
    appServer: async () => { assert.fail('no App Server readiness dependency'); },
    sharedFilesMounted: () => { assert.fail('no mount preflight'); },
    prepareRemote: async () => { assert.fail('no environment preparation'); },
    acquireRemoteUsage: async () => { assert.fail('no remote usage dependency'); } });
  try {
    await runtime.resume(target);
    await runtime.checkpoint(target);
    assert.deepEqual(calls, ['POST /v1/boxes/test-sandbox:resume', 'POST /v1/boxes/test-sandbox:suspend']);
    assert.equal(target.sandbox?.id, 'test-sandbox');
  } finally { await runtime.close(); }
});

test('pause and release close our unused sockets before submitting without probing App Server readiness', async t => {
  let closes = 0;
  t.mock.method(CodexAppServerClient.prototype, 'connect', async () => {});
  t.mock.method(CodexAppServerClient.prototype, 'close', async () => { closes++; });
  t.mock.method(CodexAppServerClient.prototype, 'request', async () => { assert.fail('no readiness RPC'); });
  const reader = new AppServerReader(async () => ({ url: 'ws://app-server.test' }), error => assert.fail(String(error)));
  const { provider, projects, record, target } = fixture();
  target.sandbox = record;
  const calls: string[] = [];
  provider.pause = async () => { assert.equal(closes, 1, 'the unused App Server socket is closed before the provider action'); calls.push('pause'); return true; };
  provider.release = async () => {
    calls.push('release');
    if (closes === 1) throw new CellboxError('BUSY', 'active RPC belongs to Cellbox admission', 409);
    return { sandboxId: record.id, state: 'unknown', startedAt: new Date(0), metadata: { phase: 'deleted' } };
  };
  const runtime = new ContainerCodexRuntime({ paths: runtimePaths, provider, sandboxes: projects, apiKey: '',
    prepareRemote: async () => { assert.fail('no environment preparation'); }, appServerReader: reader });
  try {
    await reader.read(record.id, async () => {});
    await runtime.checkpoint(target);
    const active = await reader.acquire(record.id);
    await assert.rejects(runtime.release(target), error => error instanceof CellboxError && error.code === 'BUSY');
    assert.deepEqual(calls, ['pause', 'release'], 'BUSY is not retried');
    await active.release();
    await runtime.release(target);
    assert.equal(closes, 2);
    assert.deepEqual(calls, ['pause', 'release', 'release']);
  } finally { await runtime.close(); }
});

test('live Sandbox queries ignore reference status without preparing, connecting or persisting', async () => {
  const { provider, projects, counts, target, record } = fixture();
  target.sandbox = { ...record, status: 'unknown' };
  const runtime = new ContainerCodexRuntime({ paths: runtimePaths, prepareRemote: async () => { assert.fail('query prepared the runtime'); },
    provider, apiKey: '', sandboxes: projects });
  const source = { ...record, status: 'unavailable' as const };
  const original = provider.getInfo;
  try {
    assert.equal((await runtime.querySandbox(source)).status, 'ready');
    assert.equal(source.status, 'unavailable');
    const inspection = await projects.inspect(target);
    assert.equal(inspection.info.sandboxId, record.id);
    assert.equal(inspection.record.id, record.id);
    for (const phase of ['creating', 'resuming', 'suspending', 'staged']) {
      provider.getInfo = async id => ({ ...await original(id), state: 'unknown', metadata: { phase } });
      assert.equal((await runtime.querySandbox(source)).status, 'starting');
    }
    provider.getInfo = async id => ({ ...await original(id), state: 'paused', metadata: { phase: 'suspended' } });
    assert.equal((await runtime.querySandbox(source)).status, 'paused');
    provider.getInfo = async id => ({ ...await original(id), state: 'unknown', metadata: { phase: 'suspended', operationId: 'disk-capture' } });
    assert.equal((await runtime.querySandbox(source)).status, 'paused', 'background disk capture keeps the suspended runtime paused');
    provider.getInfo = async () => { throw new CellboxError('NOT_FOUND', 'gone'); };
    assert.equal((await runtime.querySandbox(source)).status, 'unavailable');
    provider.getInfo = async () => { throw new CellboxError('TRANSPORT', 'unreachable'); };
    await assert.rejects(runtime.querySandbox(source), /unreachable/);
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

test('rebuild preserves the durable ID on transport failure and creates a replacement after NOT_FOUND', async () => {
  const { provider, projects, target, sandbox, counts } = fixture();
  target.sandbox = { id: 'removed-box', status: 'unavailable', template: 'base', workingDirectory: target.settings.workingDirectory };
  const saved: SandboxState[] = [];
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
    assert.equal(target.sandbox?.id, 'removed-box', 'transient provider errors preserve the durable reference');
    transportError = false;
    await assert.rejects(projects.inspect(target), { code: 'NOT_FOUND' });
    await runtime.rebuild(target, async state => { saved.push(state); });
    assert.equal(counts.create, 1);
    assert.equal(counts.kill, 0);
    assert.equal(target.sandbox?.id, sandbox.sandboxId);
    assert.equal(saved.at(-1)?.id, sandbox.sandboxId);
  } finally { await runtime.close(); }
});

test('sibling sessions connect through their persisted sandbox IDs without a local project cache', async () => {
  const { counts, projects, target } = fixture();
  const sibling = { ...target, id: randomUUID() };
  const saved: SandboxState[] = [];
  const first = await projects.acquire(target, { create: true, save: async state => { saved.push(state); } });
  sibling.sandbox = target.sandbox;
  const second = await projects.acquire(sibling);
  assert.equal(counts.create, 1);
  assert.notEqual(first.sandbox, second.sandbox, 'each acquisition obtains a fresh provider handle');
  assert.equal(first.sandbox.sandboxId, second.sandbox.sandboxId);
  assert.equal(counts.connect, 1, 'the sibling connects using its persisted ID');
  assert.equal(sibling.sandbox?.id, target.sandbox?.id);
  assert.ok(saved.length > 0);
  assert.equal(saved.at(-1)?.workingDirectory, target.settings.workingDirectory);
  assert.equal(saved.at(-1)?.image?.version, '20260914.1');
  assert.equal(target.sandbox?.image?.id, `sha256:${'1'.repeat(64)}`);
  await projects.delete(target);
  assert.equal(counts.kill, 1);
});

test('independent adapters refresh stale targets from the shared project row after sandbox replacement', async () => {
  const { provider, connectedIds, counts, sandbox } = fixture();
  const original: SandboxState = { id: 'released-box', template: 'base', status: 'paused', workingDirectory: '/home/agent/workspace' };
  let persisted: { sandbox?: SandboxState; imageSelection?: WorkspaceTarget['imageSelection']; sandboxMounts?: WorkspaceTarget['sandboxMounts']; sandboxOwnerKey?: string } = {
    sandbox: original,
  };
  const readProject = async () => structuredClone(persisted);
  const adapterA = new ProjectSandboxes(provider, 'base', undefined, undefined, readProject);
  const adapterB = new ProjectSandboxes(provider, 'base', undefined, undefined, readProject);
  const oldTargetA: WorkspaceTarget = { id: 'session-a', projectId: 'shared-project', sandbox: structuredClone(original),
    settings: { workingDirectory: '/home/agent/workspace' }, updatedAt: new Date().toISOString() };
  const staleTargetB: WorkspaceTarget = structuredClone({ ...oldTargetA, id: 'session-b' });
  const save = async (state: SandboxState) => { persisted = { ...persisted, sandbox: structuredClone(state) }; };
  let releasedId = '';
  provider.release = async id => {
    releasedId = id;
    return { sandboxId: id, state: 'unknown', startedAt: new Date(0), metadata: { phase: 'deleted' } };
  };

  const oldAccess = await adapterA.acquire(oldTargetA);
  assert.equal(oldAccess.record.id, 'released-box');
  assert.deepEqual(connectedIds, ['released-box']);
  await provider.release('released-box');
  assert.equal(releasedId, 'released-box');
  persisted = { ...persisted, sandbox: undefined };
  await assert.rejects(adapterA.acquire(oldTargetA, { create: true }), /持久化入口尚未配置/);
  assert.equal(counts.create, 0, 'create requires a durable save callback');

  const replacement = { ...sandbox, sandboxId: 'replacement-box' } as SandboxHandle;
  provider.create = async () => { counts.create++; return replacement; };
  const created = await adapterA.acquire(oldTargetA, { create: true, save });
  assert.equal(created.record.id, 'replacement-box');
  assert.equal(counts.create, 1);
  assert.equal(persisted.sandbox?.id, 'replacement-box');

  const refreshedAccess = await adapterB.acquire(staleTargetB);
  assert.equal(refreshedAccess.record.id, 'replacement-box');
  assert.equal(staleTargetB.sandbox?.id, 'replacement-box', 'a stale caller target is refreshed from persisted state');
  assert.deepEqual(connectedIds, ['released-box', 'replacement-box']);
  assert.equal(counts.create, 1, 'connecting through another adapter does not replay create');
});

test('creation selects the project template stable revision and reuses retained mounts and owner', async () => {
  const { provider, projects, target, sandbox } = fixture();
  const selection = { imageId: 'python', imageName: 'Python', category: '开发', versionId: 'v1', version: 'v1',
    templateId: 'python-template', revisionId: 'python-r1', image: 'registry/python@sha256:pinned' };
  target.imageSelection = selection;
  target.sandboxOwnerKey = 'project:restored-owner';
  target.sandboxMounts = [{ volumeId: 'retained-volume', mountPath: '/home/agent' }];
  provider.create = async (_template, options) => {
    assert.equal(options.metadata?.cellboxTemplateId, selection.templateId);
    assert.equal(options.metadata?.cellboxRevisionId, undefined, 'an old project revision must not pin a new Box');
    assert.equal(options.metadata?.cellboxOwnerKey, target.sandboxOwnerKey);
    assert.deepEqual(JSON.parse(options.metadata!.cellboxMounts), target.sandboxMounts);
    return sandbox;
  };
  const actualImage = { templateId: selection.templateId, revisionId: 'python-r2', version: 'v2',
    reference: 'registry/python@sha256:stable', id: 'registry/python@sha256:stable', repoDigests: [] };
  provider.getInfo = async () => ({ sandboxId: sandbox.sandboxId, state: 'running', startedAt: new Date(),
    metadata: { ownerKey: target.sandboxOwnerKey! }, mounts: target.sandboxMounts, templateIdentity: actualImage });
  const acquired = await projects.acquire(target, { create: true, save: async () => {} });
  assert.deepEqual(target.sandbox?.image, actualImage, 'record the actual stable revision returned by Cellbox');
  assert.deepEqual(target.sandbox?.mounts, target.sandboxMounts);
  assert.equal(target.sandbox?.ownerKey, target.sandboxOwnerKey);
  assert.equal(acquired.record.id, sandbox.sandboxId);
});

test('creation without a saved image selection uses the configured template rather than its pinned bootstrap revision', async () => {
  const { provider, target, sandbox } = fixture();
  const projects = new ProjectSandboxes(provider, 'base', 'tpl-bootstrap');
  provider.create = async (_template, options) => {
    assert.equal(options.metadata?.cellboxTemplateId, 'tpl-bootstrap');
    assert.equal(options.metadata?.cellboxRevisionId, undefined);
    return sandbox;
  };
  await projects.acquire(target, { create: true, save: async () => {} });
});

test('workspace file reads connect through the provider without a local Sandbox busy guard', async () => {
  const { counts, sandbox, provider, projects, target, record } = fixture();
  target.sandbox = record;
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
  let busy = true;
  provider.kill = async () => {
    counts.kill++;
    if (busy) throw new CellboxError('BUSY', 'provider reports an active operation', 409);
    return true;
  };
  const runtime = new ContainerCodexRuntime({ paths: runtimePaths, prepareRemote: async () => false, provider, apiKey: '', sandboxes: projects });
  try {
    const result = runtime.file(target, '/home/agent/workspace/result.txt');
    await reading;
    await assert.rejects(runtime.delete(target), error => error instanceof CellboxError && error.code === 'BUSY');
    finishRead();
    assert.equal((await result).data.toString(), 'ok');
    assert.equal(counts.create, 0);
    busy = false;
    await runtime.delete(target);
    assert.equal(counts.kill, 2, 'the provider sees each explicit delete request');
  } finally { finishRead(); await runtime.close(); }
});

test('file streaming preserves provider BUSY errors until completion, cancellation or disconnect', async () => {
  for (const ending of ['complete', 'cancel', 'disconnect'] as const) {
    const { sandbox, provider, projects, target, record } = fixture();
    target.sandbox = record;
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
    let busy = true, kills = 0;
    provider.kill = async () => {
      kills++;
      if (busy) throw new CellboxError('BUSY', 'provider reports an active operation', 409);
      return true;
    };
    const abort = new AbortController();
    const request = new Request('http://localhost/files', { signal: abort.signal, headers: { Range: 'bytes=0-4' } });
    try {
      const response = await runtime.fileResponse(target, '/home/agent/workspace/file.txt', request);
      assert.equal(response.status, 206);
      await assert.rejects(runtime.delete(target), error => error instanceof CellboxError && error.code === 'BUSY');
      if (ending === 'complete') { source.close(); assert.equal(await response.text(), 'hello'); }
      else if (ending === 'cancel') { await response.body!.cancel(); assert.equal(cancelled, true); }
      else {
        abort.abort();
        // Allow the asynchronous stream cancellation to finish.
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(cancelled, true);
      }
      busy = false;
      await runtime.delete(target);
      assert.equal(kills, 2);
    } finally { abort.abort(); await runtime.close(); }
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

test('a remote native interruption is persisted as cancellation without a local abort', async () => {
  const now = new Date().toISOString();
  const turn: Turn = { id: 'turn', prompt: 'stop me remotely', images: [], items: [], status: 'running', startedAt: now };
  const session: Session = { id: 'session', projectId: 'project', title: 'test', threadId: 'thread', status: 'running',
    startedAt: now, createdAt: now, updatedAt: now, archivedAt: null, turns: [turn],
    settings: { executionMode: 'sandbox', workingDirectory: '/home/agent/workspace', model: 'test', modelReasoningEffort: 'low',
      sandboxMode: 'danger-full-access', webSearchMode: 'disabled', networkAccessEnabled: true } };
  const sandbox = { async *run() {
    yield { type: 'turn.started' as const, turn_id: 'native-turn' };
    yield { type: 'turn.failed' as const, cancelled: true, error: { message: 'Turn interrupted' } };
  } } as unknown as ContainerCodexRuntime;
  await runTurn(session, turn, new AbortController(), {
    client: {} as TurnExecutionDependencies['client'], sandbox,
    save: async () => {}, publish: () => {}, snapshot: () => structuredClone(session), updateSandbox: async () => {},
  });
  assert.equal(turn.status, 'cancelled');
  assert.equal(turn.error, undefined);
});

test('lost execution ownership detaches before applying or persisting another event', async () => {
  const now = new Date().toISOString();
  const turn: Turn = { id: 'turn', prompt: 'continue elsewhere', images: [], items: [], status: 'running', startedAt: now };
  const session: Session = { id: 'session', projectId: 'project', title: 'test', threadId: 'thread', status: 'running',
    startedAt: now, createdAt: now, updatedAt: now, archivedAt: null, turns: [turn],
    settings: { executionMode: 'sandbox', workingDirectory: '/home/agent/workspace', model: 'test', modelReasoningEffort: 'low',
      sandboxMode: 'danger-full-access', webSearchMode: 'disabled', networkAccessEnabled: true } };
  let checks = 0, saves = 0, publishes = 0;
  const sandbox = ({ async *run() { yield { type: 'turn.failed' as const, error: { message: 'stale observer' } }; } }) as unknown as ContainerCodexRuntime;
  await runTurn(session, turn, new AbortController(), {
    client: {} as TurnExecutionDependencies['client'], sandbox,
    save: async () => { saves++; }, publish: () => { publishes++; }, snapshot: () => structuredClone(session), updateSandbox: async () => {},
    canPersist: () => ++checks < 2,
  });
  assert.equal(turn.status, 'running');
  assert.equal(saves, 0);
  assert.equal(publishes, 0);
});

test('App Server recovery snapshots preserve native status, prompt, and full items', async () => {
  const { provider, projects } = fixture();
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
  } finally { await runtime.close(); }
});

test('App Server recovery polls the accepted native turn and never starts another turn', async t => {
  const { provider, projects, target, record } = fixture();
  const turn: Turn = { id: randomUUID(), nativeTurnId: 'native-turn', codexAccepted: true, prompt: '', images: [], items: [],
    status: 'running', startedAt: target.updatedAt };
  const session: Session = { ...target, sandbox: record, title: 'test', threadId: 'thread-1', status: 'running',
    startedAt: target.updatedAt, createdAt: target.updatedAt, archivedAt: null, turns: [turn],
    settings: { ...target.settings, executionMode: 'sandbox', model: 'test', modelReasoningEffort: 'low',
      sandboxMode: 'danger-full-access', webSearchMode: 'disabled', networkAccessEnabled: false } };
  let listCalls = 0, startCalls = 0, nativeStatus = 'completed';
  t.mock.method(CodexAppServerClient.prototype, 'connect', async () => {});
  t.mock.method(CodexAppServerClient.prototype, 'request', async (method: string) => {
      if (method === 'turn/start') { startCalls++; assert.fail('recovery must not start a turn'); }
      assert.equal(method, 'thread/turns/list');
      listCalls++;
      return { data: [{ id: 'native-turn', status: nativeStatus, startedAt: 1, completedAt: 2,
        items: [{ type: 'agentMessage', id: 'answer', text: 'done after restart' }] }] };
  });
  const runtime = new ContainerCodexRuntime({ paths: runtimePaths, prepareRemote: async () => false, provider, apiKey: '', sandboxes: projects,
    appServer: async () => ({ url: 'ws://app-server.test', token: 'x'.repeat(24) }) });
  try {
    const events = [];
    for await (const event of runtime.recover(session, turn, new AbortController().signal, async () => {})) events.push(event);
    assert.equal(listCalls, 1);
    assert.equal(startCalls, 0);
    assert.deepEqual(events.map(event => event.type), ['turn.started', 'item.completed', 'turn.completed']);
    nativeStatus = 'interrupted';
    const interrupted: Turn = { ...turn, id: randomUUID(), status: 'running', items: [] };
    const interruptedEvents = [];
    for await (const event of runtime.recover(session, interrupted, new AbortController().signal, async () => {})) interruptedEvents.push(event);
    assert.deepEqual(interruptedEvents.map(event => event.type), ['turn.started', 'item.completed', 'turn.failed']);
    assert.equal(interruptedEvents[2].type === 'turn.failed' && interruptedEvents[2].cancelled, true);
  } finally {
    await runtime.close();
  }
});
