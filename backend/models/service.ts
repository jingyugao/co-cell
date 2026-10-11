import { createHash } from 'node:crypto';
import type { ManagedModel, ModelCatalog, ModelCatalogInput, ModelOption } from '../../protocol/model-types.js';
import { SecretCrypto } from '../secrets/crypto.js';
import { HttpError } from '../../util/errors.js';
import type { ModelRepository, StoredModelCatalog, StoredModelChannel } from './repository.js';

const keyContext = 'model-channel-api-key-v1';
const legacyModelId = (model: string) => `legacy-${createHash('sha256').update(model).digest('hex')}`;
const cleanEndpoint = (value: string) => value.replace(/\/+$/, '');

function validateEndpoint(value: string) {
  let url: URL;
  try { url = new URL(value); } catch { throw new HttpError(400, 'Endpoint 必须是有效的 HTTP(S) 地址'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new HttpError(400, 'Endpoint 必须是没有凭据、查询参数或片段的 HTTP(S) 地址');
  return cleanEndpoint(url.toString());
}

const trimmed = (value: string, field: string, max: number) => {
  const result = value.trim();
  if (!result || result.length > max || result.includes('\0')) throw new HttpError(400, `${field} 无效`);
  return result;
};
const safeId = (value: string, field: string) => {
  const id = trimmed(value, field, 100);
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new HttpError(400, `${field} 无效`);
  return id;
};

export interface LegacyModelSeed { endpoint?: string; apiKey?: string; model: string; models: string[] }
export interface ModelSelection { model: string; modelEntryId: string; channelId: string; endpoint: string; apiKey: string }

export class ModelService {
  private state: StoredModelCatalog | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly repository: ModelRepository, private readonly crypto: SecretCrypto, private readonly legacy: LegacyModelSeed) {}

  async init() {
    await this.repository.init();
    let stored = await this.repository.load();
    if (!stored) {
      const initial = this.fromLegacySeed();
      if (await this.repository.save(null, initial)) stored = initial;
      else stored = await this.repository.load();
    }
    if (!stored) throw new Error('Model catalog initialization failed');
    this.state = stored;
  }

  private fromLegacySeed(): StoredModelCatalog {
    if (!this.legacy.endpoint) return { revision: 1, defaultModelId: null, channels: [] };
    const endpoint = validateEndpoint(this.legacy.endpoint);
    const modelNames = [...new Set([this.legacy.model, ...this.legacy.models].map(model => trimmed(model, '模型名称', 200)))];
    const models: ManagedModel[] = modelNames.map(model => ({ id: legacyModelId(model), model, visible: true }));
    const defaultModel = models.find(model => model.model === this.legacy.model) ?? models[0];
    const channel: StoredModelChannel = {
      id: 'legacy-default', name: '默认渠道', endpoint, enabled: true, hasApiKey: Boolean(this.legacy.apiKey),
      ...(this.legacy.apiKey ? { apiKeyCiphertext: this.crypto.seal('legacy-default', keyContext, Buffer.from(this.legacy.apiKey)) } : {}), models,
    };
    return { revision: 1, defaultModelId: defaultModel?.id ?? null, channels: [channel] };
  }

  private current(): StoredModelCatalog {
    if (!this.state) throw new HttpError(503, '模型管理尚未初始化');
    return this.state;
  }

  private async refresh() {
    const latest = await this.repository.load();
    if (latest) this.state = latest;
    return this.current();
  }

  async catalog(): Promise<ModelCatalog> {
    await this.refresh();
    const { revision, defaultModelId, channels } = this.current();
    return { revision, defaultModelId, channels: channels.map(({ apiKeyCiphertext: _ciphertext, ...channel }) => ({ ...channel, models: channel.models.map(model => ({ ...model })) })) };
  }

  async update(input: ModelCatalogInput): Promise<ModelCatalog> {
    return this.exclusive(async () => {
      const current = await this.refresh();
      if (input.revision !== current.revision) throw new HttpError(409, '模型配置已被其他管理员修改，请刷新后重试');
      const channels = this.prepareChannels(input, current);
      this.validateDefault(input.defaultModelId, channels);
      const next: StoredModelCatalog = { revision: current.revision + 1, defaultModelId: input.defaultModelId, channels };
      if (!await this.repository.save(current.revision, next)) {
        await this.refresh();
        throw new HttpError(409, '模型配置已被其他管理员修改，请刷新后重试');
      }
      this.state = next;
      return this.catalog();
    });
  }

  private async exclusive<T>(work: () => Promise<T>): Promise<T> {
    const task = this.queue.catch(() => {}).then(work);
    this.queue = task;
    return task;
  }

  private prepareChannels(input: ModelCatalogInput, current: StoredModelCatalog): StoredModelChannel[] {
    if (!Array.isArray(input.channels) || input.channels.length > 100) throw new HttpError(400, '渠道列表无效');
    const ids = new Set<string>(), names = new Set<string>();
    const previousChannels = new Map(current.channels.map(channel => [channel.id, channel]));
    const previousModels = new Map(current.channels.flatMap(channel => channel.models.map(model => [model.id, { ...model, channelId: channel.id }] as const)));
    const nextChannels = input.channels.map(channel => {
      const id = safeId(channel.id, '渠道 ID'), name = trimmed(channel.name, '渠道名称', 100);
      const nameKey = name.toLowerCase();
      if (ids.has(id)) throw new HttpError(400, '渠道 ID 不能重复');
      if (names.has(nameKey)) throw new HttpError(400, '渠道名称不能重复');
      ids.add(id); names.add(nameKey);
      if (typeof channel.enabled !== 'boolean' || !Array.isArray(channel.models) || channel.models.length > 500)
        throw new HttpError(400, '渠道配置无效');
      const endpoint = validateEndpoint(channel.endpoint);
      const prior = previousChannels.get(id);
      if (id === 'legacy-default' && !prior) throw new HttpError(400, 'legacy-default 是保留的迁移渠道 ID');
      if (!prior && current.channels.some(existing => existing.id === id)) throw new HttpError(400, '渠道 ID 无效');
      if (prior && prior.id !== id) throw new HttpError(400, '渠道 ID 不可更改');
      if (channel.apiKey !== undefined && (typeof channel.apiKey !== 'string' || !channel.apiKey.trim() || channel.apiKey.length > 4096
        || /[\u0000-\u001f\u007f]/.test(channel.apiKey)))
        throw new HttpError(400, 'API Key 无效');
      const models = channel.models.map(model => ({ id: safeId(model.id, '模型条目 ID'), model: trimmed(model.model, '模型名称', 200), visible: model.visible }));
      const modelIds = new Set<string>(), modelNames = new Set<string>();
      for (const model of models) {
        if (typeof model.visible !== 'boolean') throw new HttpError(400, '模型可见状态无效');
        if (modelIds.has(model.id)) throw new HttpError(400, '模型条目 ID 不能重复');
        if (modelNames.has(model.model)) throw new HttpError(400, '同一渠道中的模型名称不能重复');
        modelIds.add(model.id); modelNames.add(model.model);
        const priorModel = previousModels.get(model.id);
        if (priorModel && (priorModel.channelId !== id || priorModel.model !== model.model))
          throw new HttpError(400, '已有模型条目的渠道和模型名称不可更改');
      }
      if (prior) {
        for (const old of prior.models) if (!models.some(model => model.id === old.id)) throw new HttpError(400, '不能删除已有模型条目，请隐藏该模型');
        if (channel.apiKey !== undefined) {
          return { id, name, endpoint, enabled: channel.enabled, hasApiKey: true,
            apiKeyCiphertext: this.crypto.seal(id, keyContext, Buffer.from(channel.apiKey.trim())), models };
        }
        return { id, name, endpoint, enabled: channel.enabled, hasApiKey: prior.hasApiKey,
          ...(prior.apiKeyCiphertext ? { apiKeyCiphertext: prior.apiKeyCiphertext } : {}), models };
      }
      return { id, name, endpoint, enabled: channel.enabled, hasApiKey: Boolean(channel.apiKey),
        ...(channel.apiKey ? { apiKeyCiphertext: this.crypto.seal(id, keyContext, Buffer.from(channel.apiKey.trim())) } : {}), models };
    });
    for (const old of current.channels) if (!nextChannels.some(channel => channel.id === old.id)) throw new HttpError(400, '不能删除已有渠道，请停用该渠道');
    const allModelIds = nextChannels.flatMap(channel => channel.models.map(model => model.id));
    if (new Set(allModelIds).size !== allModelIds.length) throw new HttpError(400, '模型条目 ID 必须全局唯一');
    return nextChannels;
  }

  private validateDefault(defaultModelId: string | null, channels: StoredModelChannel[]) {
    const currentDefault = this.current().defaultModelId;
    const hasSelectable = channels.some(channel => channel.enabled && channel.models.some(entry => entry.visible));
    if (defaultModelId === null) {
      if (hasSelectable || currentDefault !== null) throw new HttpError(400, '请为已启用的模型设置默认模型');
      return;
    }
    const model = channels.flatMap(channel => channel.models.map(entry => ({ entry, channel }))).find(value => value.entry.id === defaultModelId);
    if (!model || !model.entry.visible || !model.channel.enabled) throw new HttpError(400, '默认模型必须来自已启用且可见的模型');
  }

  async options(): Promise<ModelOption[]> {
    await this.refresh();
    return this.current().channels.filter(channel => channel.enabled).flatMap(channel => channel.models.filter(model => model.visible).map(model => ({
      id: model.id, model: model.model, channelId: channel.id, channelName: channel.name, label: `${model.model}（${channel.name}）`,
    })));
  }

  async defaultSelection(): Promise<{ model: string; modelEntryId?: string }> {
    await this.refresh();
    const catalog = this.current();
    for (const channel of catalog.channels) {
      const model = channel.models.find(entry => entry.id === catalog.defaultModelId);
      if (model) return { model: model.model, modelEntryId: model.id };
    }
    return { model: this.legacy.model };
  }

  async selection(settings: { model: string; modelEntryId?: string }, selectable = false): Promise<ModelSelection | undefined> {
    const channels = (await this.refresh()).channels;
    let channel: StoredModelChannel | undefined;
    let entry: ManagedModel | undefined;
    if (settings.modelEntryId !== undefined) {
      for (const candidate of channels) {
        const found = candidate.models.find(model => model.id === settings.modelEntryId);
        if (found) { channel = candidate; entry = found; break; }
      }
      if (!entry) throw new HttpError(400, '所选模型不存在，请刷新模型列表');
      if (entry.model !== settings.model) throw new HttpError(400, '所选模型与模型条目不匹配');
    } else {
      // Old sessions persisted only a model name. Keep resolving them through the
      // channel that was seeded from the original environment configuration.
      channel = channels.find(candidate => candidate.id === 'legacy-default');
      entry = channel?.models.find(model => model.model === settings.model);
      if (!channel && channels.length === 0) return undefined;
      if (!channel && channels.length > 0) throw new HttpError(400, '此会话没有有效的模型渠道，请重新选择模型');
      if (channel && !entry && !selectable) {
        if (!channel.enabled) throw new HttpError(400, '模型渠道已停用，请重新选择模型');
        let apiKey = '';
        if (channel.apiKeyCiphertext) apiKey = this.crypto.open(channel.id, keyContext, channel.apiKeyCiphertext).toString('utf8');
        return { model: settings.model, modelEntryId: legacyModelId(settings.model), channelId: channel.id, endpoint: channel.endpoint, apiKey };
      }
    }
    if (!channel || !entry) throw new HttpError(400, '所选模型不存在，请重新选择模型');
    if (!channel.enabled) throw new HttpError(400, '模型渠道已停用，请重新选择模型');
    if (selectable && !entry.visible) throw new HttpError(400, '模型已隐藏，请重新选择模型');
    let apiKey = '';
    if (channel.apiKeyCiphertext) apiKey = this.crypto.open(channel.id, keyContext, channel.apiKeyCiphertext).toString('utf8');
    return { model: entry.model, modelEntryId: entry.id, channelId: channel.id, endpoint: channel.endpoint, apiKey };
  }

  async discover(id: string): Promise<string[]> {
    const channel = (await this.refresh()).channels.find(value => value.id === id);
    if (!channel) throw new HttpError(404, '渠道不存在');
    if (!channel.enabled) throw new HttpError(400, '渠道已停用');
    let response: Response;
    try {
      response = await fetch(`${channel.endpoint}/models`, { method: 'GET', headers: channel.apiKeyCiphertext ? { Authorization: `Bearer ${this.decryptKey(channel)}` } : {},
        redirect: 'manual', signal: AbortSignal.timeout(15_000) });
    } catch { throw new HttpError(502, '无法连接模型渠道'); }
    if (!response.ok || response.status >= 300) { await response.body?.cancel(); throw new HttpError(502, '模型渠道未能返回模型列表'); }
    try {
      const body = await readJsonLimited(response, 1_048_576) as { data?: unknown };
      if (!Array.isArray(body.data)) throw new Error();
      return [...new Set(body.data.map(item => (item as { id?: unknown })?.id).filter((value): value is string => typeof value === 'string' && !!value.trim()).map(value => value.trim()))].sort();
    } catch { throw new HttpError(502, '模型渠道返回的模型列表格式无效'); }
  }

  async test(id: string, requestedModel?: string): Promise<{ ok: true }> {
    const channel = (await this.refresh()).channels.find(value => value.id === id);
    if (!channel) throw new HttpError(404, '渠道不存在');
    if (!channel.enabled) throw new HttpError(400, '渠道已停用');
    const model = requestedModel?.trim() || channel.models.find(value => value.visible)?.model;
    if (!model) throw new HttpError(400, '请指定要测试的模型');
    let response: Response;
    try {
      response = await fetch(`${channel.endpoint}/responses`, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(15_000),
        headers: { 'Content-Type': 'application/json', ...(channel.apiKeyCiphertext ? { Authorization: `Bearer ${this.decryptKey(channel)}` } : {}) },
        body: JSON.stringify({ model, input: 'Reply with OK.', max_output_tokens: 8, stream: false }) });
    } catch { throw new HttpError(502, '无法连接模型渠道'); }
    if (!response.ok || response.status >= 300) {
      await cancelQuietly(response);
      throw new HttpError(502, `模型渠道测试失败（HTTP ${response.status}）`);
    }
    let body: unknown;
    try { body = await readJsonLimited(response, 1_048_576); }
    catch {
      await cancelQuietly(response);
      throw new HttpError(502, '模型渠道测试响应格式无效');
    }
    const value = body as { object?: unknown; status?: unknown; error?: unknown };
    if (!value || value.object !== 'response' || value.error != null || value.status === 'failed') {
      await cancelQuietly(response);
      const diagnostic = safeFailureCode(value?.error, channel.apiKeyCiphertext ? this.decryptKey(channel) : '');
      throw new HttpError(502, diagnostic ? `模型渠道测试失败（${diagnostic}）` : '模型渠道测试响应无效');
    }
    return { ok: true };
  }

  private decryptKey(channel: StoredModelChannel) {
    try { return this.crypto.open(channel.id, keyContext, channel.apiKeyCiphertext!).toString('utf8'); }
    catch { throw new HttpError(500, '渠道 API Key 无法解密，请重新配置'); }
  }
}

async function readJsonLimited(response: Response, limit: number): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Response body unavailable');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new Error('Response body too large'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

function safeFailureCode(error: unknown, secret: string): string | undefined {
  if (!error || typeof error !== 'object') return;
  const value = error as { code?: unknown; type?: unknown };
  for (const candidate of [value.code, value.type]) {
    if (typeof candidate === 'string' && /^[A-Za-z0-9_.-]{1,80}$/.test(candidate)
      && (!secret || !candidate.includes(secret))) return candidate;
  }
}

async function cancelQuietly(response: Response) {
  try { await response.body?.cancel(); } catch { /* The body may already be consumed or canceled. */ }
}
