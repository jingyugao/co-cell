import assert from 'node:assert/strict';
import test from 'node:test';
import { DirectModelProvider } from './direct-provider.js';
import type { ModelService, ModelSelection } from './service.js';

test('direct providers support channels without authentication and preserve legacy retry settings', async () => {
  const selected: ModelSelection = { model: 'm', modelEntryId: 'entry', channelId: 'legacy-default', endpoint: 'http://channel.invalid/v1/', apiKey: '' };
  const service = { selection: async () => selected } as unknown as ModelService;
  const options = await new DirectModelProvider(service, true).threadOptions({ settings: { model: 'm' } } as Parameters<DirectModelProvider['threadOptions']>[0]);
  const config = Object.values(options.providerConfig!)[0] as Record<string, unknown>;
  assert.equal(config.base_url, 'http://channel.invalid/v1');
  assert.equal(config.requires_openai_auth, false);
  assert.equal(config.experimental_bearer_token, undefined);
  assert.equal(config.request_max_retries, 0);
  assert.equal(config.stream_max_retries, 0);
});

test('unmanaged model configuration remains available when no channel is selected', async () => {
  const service = { selection: async () => undefined } as unknown as ModelService;
  assert.deepEqual(await new DirectModelProvider(service).threadOptions({ settings: { model: 'm' } } as Parameters<DirectModelProvider['threadOptions']>[0]), {});
});
