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
