import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { SecretCrypto } from '../secrets/crypto.js';
import { HttpError } from '../../util/errors.js';
import type { ModelCatalogInput } from '../../protocol/model-types.js';
import type { ModelRepository, StoredModelCatalog } from './repository.js';
import { ModelService } from './service.js';
import { ClaudeBoxClient } from '../execution/claude-box.js';
import type { Session } from '../../protocol/types.js';

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


test('Claude channels retain independent defaults and require an unambiguous channel identity', async () => {
  const { service, repo } = await makeService();
  const initial = createCatalog((await service.catalog()).revision);
  const channel = { id: 'anthropic', name: 'Claude', endpoint: 'https://claude.example/prefix/v1',
    protocol: 'anthropic-messages' as const, enabled: true, apiKey: 'claude-secret',
    models: [{ id: 'claude-one', model: 'claude-model', visible: true }] };
  const configured = await service.update({ ...initial, claudeDefaultModelId: 'claude-one', channels: [...initial.channels, channel] });
  assert.equal(configured.defaultModelId, 'a-sol');
  assert.equal(configured.claudeDefaultModelId, 'claude-one');
  assert.deepEqual(await service.claudeDefaultSelection(), { model: 'claude-model', modelEntryId: 'claude-one' });
  assert.equal((await service.options()).some(value => value.id === 'claude-one'), false);
  assert.equal((await service.sessionModelConfig()).claudeModelOptions[0].id, 'claude-one');
  const publicConfig = await service.sessionModelConfig();
  assert.equal(publicConfig.defaults.modelEntryId, 'a-sol');
  assert.equal(publicConfig.claudeDefaults?.modelEntryId, 'claude-one');
  assert.deepEqual(publicConfig.claudeModelOptions.map(item => item.id), ['claude-one']);
  assert.equal((await service.claudeSelection({ model: 'claude-model', modelEntryId: 'claude-one' })).apiKey, 'claude-secret');
  assert.equal(JSON.stringify(configured).includes('claude-secret'), false);
  assert.equal(JSON.stringify(repo.value).includes('claude-secret'), false);
  assert.equal((await service.claudeSelection({ model: 'claude-model' })).channelId, 'anthropic');
  await assert.rejects(service.selection({ model: 'claude-model', modelEntryId: 'claude-one' }), /不存在/);
  await assert.rejects(service.claudeSelection({ model: 'wrong', modelEntryId: 'claude-one' }), /不匹配/);
  const update = { ...configured, claudeDefaultModelId: undefined, channels: configured.channels.map(({ protocol, ...item }) => item) };
  const preserved = await service.update(update);
  assert.equal(preserved.claudeDefaultModelId, 'claude-one');
  assert.equal(preserved.channels.find(item => item.id === 'anthropic')?.protocol, 'anthropic-messages');
  await assert.rejects(service.update({ ...preserved, channels: preserved.channels.map(item => item.id === 'anthropic'
    ? { ...item, protocol: 'responses' } : item) }), /协议不可更改/);
  const changed = await service.update({ ...preserved, channels: [...preserved.channels, { ...channel, id: 'anthropic-two',
    name: 'Claude Two', models: [{ id: 'claude-two', model: 'claude-model', visible: true }] }] });
  await assert.rejects(service.claudeSelection({ model: 'claude-model' }), /唯一有效/);
  const disabled = await service.update({ ...changed, claudeDefaultModelId: null, channels: changed.channels.map(item =>
    item.protocol === 'anthropic-messages' ? { ...item, enabled: false } : item) });
  assert.equal(disabled.claudeDefaultModelId, null);
  await assert.rejects(service.claudeSelection({ model: 'claude-model', modelEntryId: 'claude-one' }), /停用/);
});

test('Anthropic channel discovery and test use the configured proxy prefix and API key', async t => {
  const requests: Array<{ path: string; key?: string; authorization?: string; version?: string; body: string }> = [];
  let messageResponse = JSON.stringify({ type: 'message', content: [{ type: 'text', text: 'OK' }] });
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    requests.push({ path: req.url ?? '', key: String(req.headers['x-api-key'] ?? ''),
      authorization: String(req.headers.authorization ?? ''),
      version: String(req.headers['anthropic-version'] ?? ''), body: Buffer.concat(chunks).toString() });
    res.setHeader('content-type', 'application/json');
    res.end(req.url?.endsWith('/models') ? JSON.stringify({ data: [{ id: 'claude-test' }] })
      : messageResponse);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}/proxy/v1`;
  const { service } = await makeService();
  await service.update({ revision: 1, defaultModelId: null, claudeDefaultModelId: 'c', channels: [
    { id: 'anthropic', name: 'Claude', endpoint, protocol: 'anthropic-messages', enabled: true, apiKey: 'secret',
      models: [{ id: 'c', model: 'claude-test', visible: true }] },
  ] });
  assert.deepEqual(await service.discover('anthropic'), ['claude-test']);
  assert.deepEqual(await service.test('anthropic'), { ok: true });
  assert.deepEqual(requests.map(value => value.path), ['/proxy/v1/models', '/proxy/v1/messages']);
  assert(requests.every(value => value.key === 'secret' && value.version === '2023-06-01'));
  assert.deepEqual(JSON.parse(requests[1].body).messages, [{ role: 'user', content: 'Reply with OK.' }]);
  const initial = await service.catalog();
  const bearer = await service.update({ ...initial, channels: initial.channels.map(channel => ({ ...channel, authMode: 'bearer' })) });
  assert.equal(bearer.channels[0].authMode, 'bearer');
  const mapped = await service.update({ ...bearer, channels: bearer.channels.map(channel => ({ ...channel,
    claudeModelAliases: { haiku: 'fast-model', sonnet: 'work-model', opus: 'work-model' } })) });
  assert.deepEqual((await service.claudeSelection({ model: 'claude-test', modelEntryId: 'c' })).claudeModelAliases,
    { haiku: 'fast-model', sonnet: 'work-model', opus: 'work-model' });
  const legacyClient = { ...mapped, channels: mapped.channels.map(({ authMode: _authMode, claudeModelAliases: _aliases, ...channel }) => channel) };
  const preserved = await service.update(legacyClient);
  assert.equal(preserved.channels[0].authMode, 'bearer');
  assert.deepEqual(preserved.channels[0].claudeModelAliases, mapped.channels[0].claudeModelAliases);
  const selected = await service.claudeSelection({ model: 'claude-test', modelEntryId: 'c' });
  assert.equal(selected.authMode, 'bearer');
  await service.discover('anthropic');
  await service.test('anthropic');
  assert(requests.slice(-2).every(value => value.key === '' && value.authorization === 'Bearer secret'));
  const cleared = await service.update({ ...preserved, channels: preserved.channels.map(channel => ({ ...channel, claudeModelAliases: {} })) });
  assert.deepEqual(cleared.channels[0].claudeModelAliases, {});
  messageResponse = 'null';
  await assert.rejects(service.test('anthropic'), (error: unknown) => error instanceof HttpError && error.status === 502);
});


test('an empty channel can correct its protocol before adding models', async () => {
  const { service } = await makeService();
  const catalog = await service.update({ revision: 1, defaultModelId: null, channels: [
    { id: 'empty', name: 'Empty', endpoint: 'https://example.test', enabled: true, models: [] },
  ] });
  const changed = await service.update({ ...catalog, channels: catalog.channels.map(channel => ({
    ...channel, protocol: 'anthropic-messages',
  })) });
  assert.equal(changed.channels[0].protocol, 'anthropic-messages');
});

test('Claude Box submission passes the selected bearer token without putting it in the model endpoint', async t => {
  let body: Record<string, any> = {};
  let supportsEffort = false;
  const host = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/health') {
      res.end(JSON.stringify({ protocol: 'cocell-claude-acp-v1', active: false, ...(supportsEffort && { supportsEffort }) }));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    body = JSON.parse(Buffer.concat(chunks).toString());
    res.end(JSON.stringify({ turnId: body.id }));
  });
  await new Promise<void>(resolve => host.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => { host.closeAllConnections(); host.close(() => resolve()); }));
  const port = (host.address() as { port: number }).port;
  const client = new ClaudeBoxClient(async () => ({ url: `http://127.0.0.1:${port}`, headers: {} }));
  const session = { id: 'session', settings: { workingDirectory: '/home/agent/workspace' } } as Session;
  const selected = { model: 'model', modelEntryId: 'entry', channelId: 'channel',
    endpoint: 'https://channel.example/proxy/v1', apiKey: 'test-token', authMode: 'bearer' as const,
    claudeModelAliases: { haiku: 'fast-model', sonnet: 'work-model', opus: 'work-model' } };
  assert.equal(await client.submit('box', session, selected, 'turn', 'hello', []), 'turn');
  assert.equal(body.env.ANTHROPIC_AUTH_TOKEN, 'test-token');
  assert.equal(body.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(body.env.ANTHROPIC_BASE_URL, 'https://channel.example/proxy');
  assert.equal(body.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'fast-model');
  assert.equal(body.env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'work-model');
  assert.equal(body.env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'work-model');
  assert.equal(body.effort, undefined);
  session.settings.claudeEffort = 'xhigh';
  await assert.rejects(client.submit('box', session, selected, 'unsupported', 'hello', []), /镜像不支持设置 Claude 推理强度/);
  assert.equal(body.id, 'turn');
  supportsEffort = true;
  await client.submit('box', session, { ...selected, authMode: 'api-key' }, 'turn-2', 'hello', []);
  assert.equal(body.effort, 'xhigh');
  assert.equal(body.env.ANTHROPIC_API_KEY, 'test-token');
  assert.equal(body.env.ANTHROPIC_AUTH_TOKEN, undefined);
});
