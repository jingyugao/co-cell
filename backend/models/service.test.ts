import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { SecretCrypto } from '../secrets/crypto.js';
import { HttpError } from '../../util/errors.js';
import type { ModelCatalogInput } from '../../protocol/model-types.js';
import type { ModelRepository, StoredModelCatalog } from './repository.js';
import { ModelService } from './service.js';

class MemoryRepository implements ModelRepository {
  value: StoredModelCatalog | null = null;
  async init() {}
  async load() { return this.value ? structuredClone(this.value) : null; }
  async save(expectedRevision: number | null, catalog: StoredModelCatalog) {
    if (expectedRevision === null ? this.value !== null : this.value?.revision !== expectedRevision) return false;
    this.value = structuredClone(catalog); return true;
  }
}

const crypto = () => new SecretCrypto(Buffer.alloc(32, 9).toString('base64'));
const makeService = async (repo = new MemoryRepository(), seed: { endpoint?: string; apiKey?: string; model: string; models: string[] } = { model: 'gpt-6-sol', models: ['gpt-6-sol'] }) => {
  const service = new ModelService(repo, crypto(), seed); await service.init(); return { service, repo };
};
const createCatalog = (revision: number): ModelCatalogInput => ({ revision, defaultModelId: 'a-sol', channels: [
  { id: 'a', name: '渠道 A', endpoint: 'https://a.example/v1', enabled: true, apiKey: 'key-a', models: [
    { id: 'a-sol', model: 'gpt-6-sol', visible: true }, { id: 'a-mini', model: 'gpt-6-mini', visible: true },
  ] },
  { id: 'b', name: '渠道 B', endpoint: 'https://b.example/v1', enabled: true, apiKey: 'key-b', models: [
    { id: 'b-sol', model: 'gpt-6-sol', visible: true },
  ] },
] });

test('same model from different channels remains distinct and key material is encrypted/write-only', async () => {
  const { service, repo } = await makeService();
  await service.update(createCatalog((await service.catalog()).revision));
  const catalog = await service.catalog();
  assert.equal(catalog.channels[0].hasApiKey, true);
  assert.equal(JSON.stringify(catalog).includes('key-a'), false);
  assert.equal(JSON.stringify(repo.value).includes('key-a'), false);
  assert.deepEqual((await service.options()).filter(option => option.model === 'gpt-6-sol').map(option => option.label), ['gpt-6-sol（渠道 A）', 'gpt-6-sol（渠道 B）']);
  assert.equal((await service.selection({ model: 'gpt-6-sol', modelEntryId: 'b-sol' }))?.channelId, 'b');
  assert.equal((await service.defaultSelection()).modelEntryId, 'a-sol');
});

test('rejects duplicate channel names, stale revisions, and a default that is hidden or disabled', async () => {
  const { service } = await makeService();
  await service.update(createCatalog((await service.catalog()).revision));
  const current = await service.catalog();
  const duplicate = structuredClone(current) as unknown as ModelCatalogInput;
  duplicate.channels[1].name = ' 渠道 A ';
  await assert.rejects(service.update(duplicate), (error: unknown) => error instanceof HttpError && error.status === 400);
  const hiddenDefault = structuredClone(current) as unknown as ModelCatalogInput;
  hiddenDefault.channels[0].models[0].visible = false;
  await assert.rejects(service.update(hiddenDefault), (error: unknown) => error instanceof HttpError && error.status === 400);
  await assert.rejects(service.update(createCatalog(current.revision - 1)), (error: unknown) => error instanceof HttpError && error.status === 409);
});

test('hiding keeps existing sessions usable, while disabling blocks execution selection', async () => {
  const { service } = await makeService();
  await service.update(createCatalog((await service.catalog()).revision));
  let current = await service.catalog();
  const hidden = structuredClone(current) as unknown as ModelCatalogInput;
  hidden.defaultModelId = 'a-mini'; hidden.channels[0].models[0].visible = false;
  await service.update(hidden);
  await assert.rejects(service.selection({ model: 'gpt-6-sol', modelEntryId: 'a-sol' }, true),
    (error: unknown) => error instanceof HttpError && error.status === 400, 'hidden entry cannot be newly selected');
  // Existing explicit selections may still use hidden entries when marked as non-selectable.
  assert.equal((await service.selection({ model: 'gpt-6-sol', modelEntryId: 'a-sol' }, false))?.channelId, 'a');
  current = await service.catalog();
  const disabled = structuredClone(current) as unknown as ModelCatalogInput;
  disabled.defaultModelId = 'b-sol';
  disabled.channels[0].enabled = false;
  await service.update(disabled);
  await assert.rejects(service.selection({ model: 'gpt-6-mini', modelEntryId: 'a-mini' }),
    (error: unknown) => error instanceof HttpError && error.status === 400);
});

test('legacy environment is migrated once and legacy model names stay on the original channel', async () => {
  const repo = new MemoryRepository();
  const first = await makeService(repo, { endpoint: 'https://legacy.example/v1', apiKey: 'legacy-secret', model: 'gpt-6-sol', models: ['gpt-6-sol'] });
  assert.equal((await first.service.catalog()).channels[0].id, 'legacy-default');
  const initial = await first.service.catalog();
  const added = createCatalog(initial.revision);
  added.channels.unshift(initial.channels[0]);
  added.defaultModelId = 'a-sol';
  await first.service.update(added);
  assert.equal((await first.service.selection({ model: 'gpt-6-sol' }))?.channelId, 'legacy-default');
  const historical = await first.service.selection({ model: 'old-unlisted-model' });
  assert.equal(historical?.model, 'old-unlisted-model');
  assert.equal(historical?.channelId, 'legacy-default');
  await assert.rejects(first.service.selection({ model: 'old-unlisted-model' }, true),
    (error: unknown) => error instanceof HttpError && error.status === 400);
  const second = await makeService(repo, { endpoint: 'https://changed.example/v1', apiKey: 'new-secret', model: 'other', models: ['other'] });
  assert.equal((await second.service.catalog()).channels.some(channel => channel.endpoint.includes('changed.example')), false);
  assert.equal((await second.service.selection({ model: 'gpt-6-sol' }))?.endpoint, 'https://legacy.example/v1');
});

test('optimistic revision permits only one concurrent catalog update', async () => {
  const repo = new MemoryRepository();
  const one = await makeService(repo), two = await makeService(repo);
  const revision = (await one.service.catalog()).revision;
  const outcomes = await Promise.allSettled([
    one.service.update(createCatalog(revision)),
    two.service.update({ ...createCatalog(revision), defaultModelId: 'b-sol' }),
  ]);
  assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
  const rejected = outcomes.find(result => result.status === 'rejected');
  assert.equal(rejected?.status, 'rejected');
  if (rejected?.status === 'rejected') assert.ok(rejected.reason instanceof HttpError && rejected.reason.status === 409);
});

test('invalid, mismatched, and disabled explicit model selections never fall through to another channel', async () => {
  const { service } = await makeService();
  await service.update(createCatalog((await service.catalog()).revision));
  await assert.rejects(service.selection({ model: 'gpt-6-sol', modelEntryId: 'missing-id' }),
    (error: unknown) => error instanceof HttpError && error.status === 400);
  await assert.rejects(service.selection({ model: 'gpt-6-mini', modelEntryId: 'a-sol' }),
    (error: unknown) => error instanceof HttpError && error.status === 400);
  const current = await service.catalog() as unknown as ModelCatalogInput;
  current.defaultModelId = 'b-sol'; current.channels[0].enabled = false;
  await service.update(current);
  await assert.rejects(service.selection({ model: 'gpt-6-sol', modelEntryId: 'a-sol' }),
    (error: unknown) => error instanceof HttpError && error.status === 400);
});

test('a default cannot be cleared after models become selectable, and other service instances see updates', async () => {
  const repo = new MemoryRepository();
  const one = await makeService(repo), two = await makeService(repo);
  await one.service.update(createCatalog((await one.service.catalog()).revision));
  assert.equal((await two.service.catalog()).defaultModelId, 'a-sol');
  await assert.rejects(one.service.update({ ...createCatalog((await one.service.catalog()).revision), defaultModelId: null }),
    (error: unknown) => error instanceof HttpError && error.status === 400);
  assert.equal((await two.service.options()).length, 3);
});

test('reserves legacy-default for environment migration', async () => {
  const { service } = await makeService();
  await assert.rejects(service.update({ revision: (await service.catalog()).revision, defaultModelId: 'legacy-model', channels: [
    { id: 'legacy-default', name: 'Manual', endpoint: 'https://manual.example/v1', enabled: true,
      models: [{ id: 'legacy-model', model: 'm', visible: true }] },
  ] }), (error: unknown) => error instanceof HttpError && error.status === 400);
});

test('discovery and test use the configured key, validate successful Responses JSON, and sanitize failures', async t => {
  const requests: Array<{ path: string; authorization?: string; body: string }> = [];
  let responseBody = JSON.stringify({ object: 'response', status: 'incomplete', error: null, incomplete_details: { reason: 'max_output_tokens' } });
  let responseStatus = 200;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    requests.push({ path: req.url ?? '', authorization: req.headers.authorization, body: Buffer.concat(chunks).toString() });
    res.statusCode = responseStatus;
    res.setHeader('content-type', 'application/json');
    res.end(req.url === '/v1/models' && responseStatus === 200
      ? JSON.stringify({ data: [{ id: 'm2' }, { id: 'm1' }, { id: 'm1' }] }) : responseBody);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  const { service } = await makeService();
  const revision = (await service.catalog()).revision;
  await service.update({ revision, defaultModelId: 'test-model', channels: [{ id: 'test', name: 'Test', endpoint, enabled: true,
    apiKey: 'test-secret', models: [{ id: 'test-model', model: 'm1', visible: true }] }] });
  assert.deepEqual(await service.discover('test'), ['m1', 'm2']);
  assert.deepEqual(await service.test('test'), { ok: true });
  assert.equal(requests[0].authorization, 'Bearer test-secret');
  assert.equal(requests[1].authorization, 'Bearer test-secret');
  assert.equal(JSON.parse(requests[1].body).stream, false);

  responseBody = JSON.stringify({ object: 'error', error: { code: 'invalid_api_key', message: 'rejected test-secret' } });
  await assert.rejects(service.test('test'), (error: unknown) => error instanceof HttpError && error.status === 502
    && error.message.includes('invalid_api_key') && !error.message.includes('test-secret'));
  responseBody = JSON.stringify({ object: 'response', status: 'failed', error: { message: 'failed test-secret' } });
  await assert.rejects(service.test('test'), (error: unknown) => error instanceof HttpError && error.status === 502
    && !error.message.includes('test-secret'));
  responseStatus = 401; responseBody = JSON.stringify({ error: { code: 'invalid_api_key', message: 'test-secret' } });
  await assert.rejects(service.test('test'), (error: unknown) => error instanceof HttpError && error.status === 502
    && error.message.includes('HTTP 401') && !error.message.includes('test-secret'));
  await assert.rejects(service.discover('test'), (error: unknown) => error instanceof HttpError && error.status === 502
    && !error.message.includes('test-secret'));
});
