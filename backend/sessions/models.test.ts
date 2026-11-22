import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager, type CodexClient } from './manager.js';
import { MemoryWebStateStore } from '../testing/memory-web-state.js';
import { ModelService, type ModelSelection } from '../models/service.js';
import { SecretCrypto } from '../secrets/crypto.js';
import type { StoredModelCatalog } from '../models/repository.js';
import { ClaudeBoxClient } from '../execution/claude-box.js';
import type { SandboxRuntime } from '../execution/container-runtime.js';
import type { Settings, Session } from '../../protocol/types.js';

async function modelService() {
  let catalog: StoredModelCatalog | null = null;
  const models = new ModelService({ init: async () => {}, load: async () => structuredClone(catalog),
    save: async (revision, next) => { if ((catalog?.revision ?? null) !== revision) return false; catalog = structuredClone(next); return true; } },
  new SecretCrypto(Buffer.alloc(32, 3).toString('base64')), { model: 'same', models: [] });
  await models.init();
  return models;
}

test('session defaults pin channel identity, later defaults affect only new sessions, and disabled channels block submission', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cocell-models-'));
  const models = await modelService();
  await models.update({ revision: 1, defaultModelId: 'a-model', channels: [
    { id: 'a', name: 'A', endpoint: 'https://a.example/v1', enabled: true, apiKey: 'key-a', models: [{ id: 'a-model', model: 'same', visible: true }] },
    { id: 'b', name: 'B', endpoint: 'https://b.example/v1', enabled: true, apiKey: 'key-b', models: [{ id: 'b-model', model: 'same', visible: true }] },
  ] });
  const defaults: Settings = { executionMode: 'local', workingDirectory: directory, model: 'old-default', modelReasoningEffort: 'low',
    sandboxMode: 'read-only', webSearchMode: 'disabled', networkAccessEnabled: false };
  const manager = new SessionManager({} as CodexClient, directory, defaults, new MemoryWebStateStore());
  manager.setModelService(models);
  try {
    await manager.init();
    const first = await manager.create();
    assert.equal(first.settings.modelEntryId, 'a-model');
    let config = await models.catalog();
    await models.update({ ...config, defaultModelId: 'b-model' });
    assert.equal((await manager.create()).settings.modelEntryId, 'b-model');
    assert.equal(manager.get(first.id).settings.modelEntryId, 'a-model');
    await assert.rejects(manager.update(first.id, { settings: { model: 'wrong', modelEntryId: 'b-model' } }), /不匹配/);
    const changed = await manager.update(first.id, { settings: { model: 'same', modelEntryId: 'b-model' } });
    assert.equal(changed.settings.modelEntryId, 'b-model');
    config = await models.catalog();
    await models.update({ ...config, defaultModelId: 'a-model', channels: config.channels.map(channel => channel.id === 'b'
      ? { ...channel, models: channel.models.map(model => ({ ...model, visible: false })) } : channel) });
    assert.equal((await manager.update(first.id, { title: 'still retained' })).settings.modelEntryId, 'b-model');
    await assert.rejects(manager.create({ settings: { model: 'same', modelEntryId: 'b-model' } }), /隐藏/);
    config = await models.catalog();
    await models.update({ ...config, channels: config.channels.map(channel => channel.id === 'b' ? { ...channel, enabled: false } : channel) });
    await assert.rejects(manager.startTurn(first.id, 'hello'), /停用/);
    assert.equal(manager.get(first.id).turns.length, 0);
  } finally { await manager.close(); await rm(directory, { recursive: true, force: true }); }
});


test('Claude sessions pin their managed entry and resolve channel edits before the next turn', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cocell-claude-model-'));
  const models = await modelService();
  const entries = ['a', 'b'].map(id => ({ id, name: id, endpoint: 'http://' + id + '.test', protocol: 'anthropic-messages' as const,
    enabled: true, apiKey: 'test-' + id, models: [{ id: id + '-entry', model: 'same', visible: true }] }));
  await models.update({ revision: 1, defaultModelId: null, claudeDefaultModelId: 'a-entry', channels: entries });
  const store = new MemoryWebStateStore();
  const at = new Date().toISOString();
  const settings: Settings = { executionMode: 'sandbox', workingDirectory: '/home/agent/workspace', model: 'codex-only', modelReasoningEffort: 'low',
    webSearchMode: 'disabled', networkAccessEnabled: true, sandboxMode: 'danger-full-access' };
  const sandbox = { id: 'box', workingDirectory: settings.workingDirectory, template: 'default', status: 'ready' as const };
  await store.saveProject({ id: 'project', name: 'Project', status: 'active', type: 1, requirementUrl: null, executionMode: 'sandbox',
    workingDirectory: settings.workingDirectory, sandbox, createdAt: at, updatedAt: at });
  const calls: string[][] = [];
  class Host extends ClaudeBoxClient {
    override async reserve() {}
    override async snapshot() { return { snapshot: { threadId: null, turns: [] } }; }
    override async submit(_box: string, session: Session, selected: ModelSelection, id: string) {
      calls.push([selected.modelEntryId, selected.endpoint, selected.apiKey, session.settings.claudeEffort ?? 'default']); return id;
    }
  }
  const runtime = { async close() {}, async querySandbox() { return sandbox; } };
  const manager = new SessionManager({} as CodexClient, directory, settings, store, runtime as unknown as SandboxRuntime);
  manager.setModelService(models);
  manager.setClaudeRuntime(new Host(async () => assert.fail('unexpected service access')));
  try {
    await manager.init();
    const session = await manager.create({ projectId: 'project', agentKind: 'claude-code' });
    assert.equal(session.settings.modelEntryId, 'a-entry');
    const saved = await models.catalog();
    await models.update({ ...saved, claudeDefaultModelId: 'b-entry', channels: saved.channels.map(channel =>
      channel.id === 'a' ? { ...channel, endpoint: 'http://rotated.test', apiKey: 'rotated' } : channel) });
    await manager.startTurn(session.id, 'continue');
    await manager.update(session.id, { settings: { claudeEffort: 'xhigh' } });
    const updated = await manager.update(session.id, { settings: { model: 'same', modelEntryId: 'b-entry' } });
    assert.equal(updated.settings.claudeEffort, 'xhigh');
    await manager.startTurn(session.id, 'continue on B');
    assert.deepEqual(calls, [['a-entry', 'http://rotated.test', 'rotated', 'default'], ['b-entry', 'http://b.test', 'test-b', 'xhigh']]);
    const disabled = await models.catalog();
    await models.update({ ...disabled, claudeDefaultModelId: 'a-entry', channels: disabled.channels.map(channel =>
      channel.id === 'b' ? { ...channel, enabled: false } : channel) });
    await assert.rejects(manager.startTurn(session.id, 'blocked'), /停用/);
    assert.equal(calls.length, 2);
  } finally { await manager.close(); await rm(directory, { recursive: true, force: true }); }
});

test('managed workflow sessions keep their owner after restart and gate native turn submission', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cocell-managed-'));
  const store = new MemoryWebStateStore();
  const at = new Date().toISOString();
  const workingDirectory = '/home/agent/workspace';
  const sandbox = { id: 'box', template: 'default', workingDirectory, status: 'ready' as const };
  const defaults: Settings = {
    executionMode: 'sandbox',
    workingDirectory,
    model: 'model',
    modelReasoningEffort: 'low',
    sandboxMode: 'danger-full-access',
    networkAccessEnabled: true,
    webSearchMode: 'disabled',
  };
  await store.saveProject({
    id: 'project',
    name: 'fixture',
    executionMode: 'sandbox',
    status: 'active',
    requirementUrl: null,
    workingDirectory,
    sandbox,
    createdAt: at,
    updatedAt: at,
  });
  let sends = 0;
  const native = {
    async close() {},
    async querySandbox() {
      return sandbox;
    },
    async openNativeConnection() {
      throw Error('unexpected relay');
    },
    async prepareNativeSession(s: Session) {
      return { threadId: s.threadId, threadOptions: { sandbox: s.settings.sandboxMode }, turnOptions: {} };
    },
    async nativeRequest(
      _session: Session,
      method: string,
      params: Record<string, unknown>,
      guard?: () => Promise<void>
    ) {
      if (method === 'thread/start') {
        assert.equal(params.sandbox, 'read-only');
        return { thread: { id: 'thread' }, sandbox: { type: 'readOnly', networkAccess: false } };
      }
      if (method === 'thread/read') return { thread: { id: 'thread' } };
      assert.equal(method, 'turn/start');
      assert.deepEqual(params.sandboxPolicy, { type: 'readOnly', networkAccess: false });
      await guard!();
      sends++;
      return { turn: { id: 'turn' } };
    },
  };
  const open = () =>
    new SessionManager({} as CodexClient, directory, defaults, store, native as unknown as SandboxRuntime);
  const owner = { kind: 'workflow' as const, runId: 'run', taskId: 'design', writable: false };
  let manager = open();
  try {
    await manager.init();
    const s = await manager.ensureWorkflowSession('session', owner, 'project', '设计', 'model');
    assert.deepEqual(s.managedBy, owner);
    await manager.close();
    manager = open();
    await manager.init();
    const restored = await manager.ensureWorkflowSession('session', owner, 'project', '设计', 'model');
    assert.equal(restored.settings.sandboxMode, 'read-only');
    assert.equal(restored.settings.networkAccessEnabled, false);
    await assert.rejects(
      manager.ensureWorkflowSession('session', { ...owner, writable: true }, 'project', '实施', 'model'),
      /归属/
    );
    await assert.rejects(manager.startTurn('session', 'manual'), /工作台/);
    assert.equal(await manager.prepareWorkflowThread('session'), 'thread');
    assert.equal(await manager.isWorkflowThread('thread'), true);
    await assert.rejects(
      manager.submitWorkflowTurn('session', 'thread', 'prompt', {}, async () => {
        throw Error('stale');
      }),
      /stale/
    );
    assert.equal(sends, 0);
    assert.equal(await manager.submitWorkflowTurn('session', 'thread', 'prompt', {}, async () => {}), 'turn');
    assert.equal(sends, 1);
  } finally {
    await manager.close();
    await rm(directory, { recursive: true, force: true });
  }
});
