import { createHash } from 'node:crypto';
import type { ThreadOptions } from '../../packages/agentcore/src/index.mjs';
import type { Session } from '../../protocol/types.js';
import type { ModelService } from './service.js';

/** Resolve the selected channel into a provider used directly by the Sandbox. */
export class DirectModelProvider {
  constructor(private models: ModelService, private disableLegacyRetries = false) {}

  async threadOptions(session: Pick<Session, 'settings'>): Promise<Pick<ThreadOptions, 'model' | 'modelProvider' | 'providerConfig'>> {
    const selected = await this.models.selection(session.settings);
    if (!selected) return {};
    const endpoint = selected.endpoint.replace(/\/+$/, '');
    const retryConfig = selected.channelId === 'legacy-default' && this.disableLegacyRetries
      ? { request_max_retries: 0, stream_max_retries: 0 } : {};
    // Loaded native threads retain their provider. Give each channel configuration
    // an immutable identity so endpoint/key/retry changes adopt it through a history fork.
    const revision = createHash('sha256').update(JSON.stringify([selected.channelId, endpoint, selected.apiKey, retryConfig])).digest('hex');
    const provider = `cocell_direct_${revision}`;
    return { model: selected.model, modelProvider: provider, providerConfig: {
      [`model_providers.${provider}`]: { name: provider, base_url: endpoint,
        wire_api: 'responses', supports_websockets: false, requires_openai_auth: false,
        ...(selected.apiKey ? { experimental_bearer_token: selected.apiKey } : {}),
        ...retryConfig },
    } };
  }
}
