import { createHash } from 'node:crypto';
import type { KnowledgePage, KnowledgePagePrompt, KnowledgeTreeNode, KnowledgeView } from '../../protocol/knowledge-types.js';
import { MemoryCoordinator, type SharedCoordinator } from '../infra/storage/coordination.js';
import { HttpError, redactCredentials } from '../../util/errors.js';
import type { HookRetain } from './retain.js';
import { HindsightClient, HindsightError, type HindsightModel, type KnowledgeNode } from './client.js';

function findPage(nodes: KnowledgeNode[], id?: string): KnowledgeNode | undefined {
  for (const node of nodes) {
    if (node.kind === 'page' && (!id || node.id === id)) return node;
    if (node.children?.length) {
      const match = findPage(node.children, id);
      if (match) return match;
    }
  }
}

function directory(nodes: KnowledgeNode[]): KnowledgeTreeNode[] {
  return nodes.map(({ kind, id, name, children }) => kind === 'folder'
    ? { kind, id, name, children: directory(children ?? []) }
    : { kind, id, name });
}

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function pagePrompt(model: HindsightModel): KnowledgePagePrompt {
  if (model.source_query !== null && typeof model.source_query !== 'string') throw new HttpError(502, 'Hindsight 未返回知识页提示词');
  return { text: model.source_query ?? '', version: hash(JSON.stringify([model.id, model.source_query])) };
}
const errorText = (error: unknown) => redactCredentials(error instanceof Error ? error.message : String(error)).slice(0, 1000);
const transient = (error: unknown) => error instanceof HindsightError && (error.status === 0 || error.status === 429 || error.status >= 500);
interface Dependencies {
  hooks?: HookRetain;
  client?: HindsightClient;
  coordinator?: SharedCoordinator;
}

export class KnowledgeService {
  private controller = new AbortController();
  private coordinator: SharedCoordinator;

  constructor(private deps: Dependencies) { this.coordinator = deps.coordinator ?? new MemoryCoordinator(); }

  get hooks() { return this.deps.hooks; }

  private async tree(client: HindsightClient, signal: AbortSignal) {
    const { roots } = await client.request<{ roots: KnowledgeNode[] }>('knowledge-base/tree', { signal });
    return roots;
  }

  async view(pageId?: string): Promise<KnowledgeView> {
    const { client, hooks } = this.deps;
    const view: KnowledgeView = { configured: Boolean(client), settings: { enabled: Boolean(hooks) }, bankId: client?.bankId, pages: [] };
    if (!client) return view;
    try {
      const roots = await this.tree(client, this.controller.signal);
      view.pages = directory(roots);
      const node = findPage(roots, pageId) ?? findPage(roots);
      if (node) view.selectedPage = await this.readPage(client, node);
    } catch (error) { view.error = errorText(error); }
    return view;
  }

  private async readPage(client: HindsightClient, node: KnowledgeNode): Promise<KnowledgePage> {
    const page: KnowledgePage = { id: node.id, name: node.name, status: 'pending', body: '', isStale: false, sourceCount: 0 };
    try {
      if (!node.mental_model_id) throw new Error('Hindsight 知识页缺少关联模型');
      // The page body and source query live on its backing model, alongside refresh evidence.
      const model = await client.request<HindsightModel>(`mental-models/${encodeURIComponent(node.mental_model_id)}`, { signal: this.controller.signal });
      const generated = Boolean(model.content || model.last_refreshed_at);
      return { ...page, status: model.last_refresh_failed_at ? 'failed' : generated ? 'ready' : 'pending',
        body: model.content ?? '', prompt: pagePrompt(model), updatedAt: model.last_refreshed_at ?? undefined,
        isStale: Boolean(node.is_stale ?? model.is_stale), sourceCount: Object.values(model.reflect_response?.based_on ?? {}).reduce((sum, items) => sum + items.length, 0),
        ...(model.last_refresh_failed_at ? { error: 'Hindsight 页面生成失败，可点击“重新生成”重试' } : {}) };
    } catch (error) { return { ...page, status: 'failed', error: errorText(error) }; }
  }

  async updatePagePrompt(pageId: string, input: KnowledgePagePrompt): Promise<KnowledgePagePrompt> {
    const client = this.deps.client;
    if (!client) throw new HttpError(503, 'Hindsight 尚未配置');
    const lease = await this.coordinator.tryAcquire(`knowledge:prompt:${pageId}`);
    if (!lease) throw new HttpError(409, '该提示词正在保存，请稍后重试');
    const signal = AbortSignal.any([this.controller.signal, lease.signal]);
    try {
      const node = findPage(await this.tree(client, signal), pageId);
      if (!node?.mental_model_id) throw new HttpError(409, '知识页尚未创建或已移除，请重新加载');
      const path = `mental-models/${encodeURIComponent(node.mental_model_id)}`;
      const read = async () => pagePrompt(await client.request<HindsightModel>(path, { signal }));
      const current = await read();
      if (current.text === input.text) return current;
      if (current.version !== input.version) throw new HttpError(409, 'Hindsight 中的提示词已变化，请重新加载后再编辑');
      lease.assertHeld();
      try {
        await client.request(`knowledge-base/nodes/${encodeURIComponent(node.id)}`, { method: 'PATCH', body: { source_query: input.text }, signal });
      } catch (error) {
        if (!transient(error) || signal.aborted) throw error;
        // The upstream may have committed before its response was lost.
        const actual = await read();
        if (actual.text === input.text) return actual;
        throw error;
      }
      const saved = await read();
      if (saved.text !== input.text) throw new HttpError(409, 'Hindsight 中的提示词已变化，请重新加载');
      return saved;
    } catch (error) {
      if (error instanceof HindsightError) {
        if (error.status >= 400 && error.status < 500) throw new HttpError(error.status, `Hindsight 拒绝了提示词请求（HTTP ${error.status}）`);
        throw new HttpError(502, '无法确认 Hindsight 中的提示词，请刷新查看后重试');
      }
      throw error;
    } finally { await lease.release(); }
  }

  async refreshPage(pageId: string) {
    const client = this.deps.client;
    if (!client) throw new HttpError(400, '请先在服务端配置 HINDSIGHT_API_URL');
    const lease = await this.coordinator.tryAcquire(`knowledge:refresh:${pageId}`);
    if (!lease) throw new HttpError(409, '知识整理任务正在处理，请稍后重试');
    const signal = AbortSignal.any([this.controller.signal, lease.signal]);
    try {
      const modelId = findPage(await this.tree(client, signal), pageId)?.mental_model_id;
      if (!modelId) throw new HttpError(409, '在 Hindsight 中找不到此知识页，请重新加载');
      // Recover a submitted refresh after a lost response before scheduling another.
      for (const status of ['pending', 'processing']) {
        for (let offset = 0; ; offset += 100) {
          const { operations } = await client.request<{ operations: Array<{ mental_model_id?: string }> }>(
            `operations?type=refresh_mental_model&status=${status}&limit=100&offset=${offset}`, { signal });
          if (operations.some(operation => operation.mental_model_id === modelId)) return;
          if (operations.length < 100) break;
        }
      }
      signal.throwIfAborted(); lease.assertHeld();
      await client.request(`mental-models/${encodeURIComponent(modelId)}/refresh`, { method: 'POST', signal });
    } finally { await lease.release(); }
  }

  async close() {
    this.controller.abort();
    if (!this.deps.coordinator) await this.coordinator.close();
  }
}
