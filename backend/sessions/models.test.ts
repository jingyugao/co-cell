import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager, type CodexClient } from './manager.js';
import { MemoryWebStateStore } from '../testing/memory-web-state.js';
import { ModelService } from '../models/service.js';
import { SecretCrypto } from '../secrets/crypto.js';
import type { StoredModelCatalog } from '../models/repository.js';
import type { Settings } from '../../protocol/types.js';

test('session defaults pin channel identity, later defaults affect only new sessions, and disabled channels block submission', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cocell-models-'));
  let catalog: StoredModelCatalog | null = null;
  const models = new ModelService({ init: async () => {}, load: async () => structuredClone(catalog),
    save: async (revision, next) => { if ((catalog?.revision ?? null) !== revision) return false; catalog = structuredClone(next); return true; } },
  new SecretCrypto(Buffer.alloc(32, 3).toString('base64')), { model: 'same', models: [] });
  await models.init();
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
