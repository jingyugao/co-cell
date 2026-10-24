import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { KnowledgeCategory, KnowledgePage, KnowledgeSettings, KnowledgeSettingsInput, KnowledgeView } from '../../protocol/knowledge-types.js';
import { MemoryCoordinator, type SharedCoordinator } from '../infra/storage/coordination.js';
import type { WebStateStore } from '../infra/storage/web-state.js';
import type { MemoryRepository, StoredMemory } from '../memory/repository.js';
import type { MemoryService } from '../memory/service.js';
import { HttpError, redactCredentials } from '../../util/errors.js';
import { HindsightClient, HindsightError, type HindsightModel, type HindsightOperation, type KnowledgeNode, type RetainRequest } from './client.js';
import { categories, defaultPrompts, observationsMission, pageTrigger, retainMission } from './prompts.js';
import type { KnowledgeRepository, StoredKnowledgeJob } from './repository.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const errorText = (error: unknown) => redactCredentials(error instanceof Error ? error.message : String(error)).slice(0, 1000);
const is404 = (error: unknown) => error instanceof HindsightError && error.status === 404;
const transient = (error: unknown) => error instanceof HindsightError && (error.status === 0 || error.status === 429 || error.status >= 500);
const inputHash = (record: StoredMemory) => hash(JSON.stringify({ version: 1, session: record.sessionId,
  updatedAt: record.sourceUpdatedAt, files: record.files.map(file => ({ path: file.path, sha256: file.sha256,
    threadId: file.threadId })).sort((a, b) => a.path.localeCompare(b.path)) }));

interface Dependencies {
  repository: KnowledgeRepository;
  materials: MemoryRepository;
  memory: Pick<MemoryService, 'content'>;
  state: Pick<WebStateStore, 'listProjects'>;
  directory: string;
  client?: HindsightClient;
  coordinator?: SharedCoordinator;
  logger?: { write(event: Record<string, unknown>): void };
}

/** The durable outbox owns submissions; Hindsight owns extraction and synthesis. */
export class KnowledgeService {
  private controller = new AbortController();
  private timer?: ReturnType<typeof setTimeout>;
  private running?: Promise<void>;
  private lastScan = 0;
  private reconciled?: { revision: number; at: number };
  private error?: string;
  private coordinator: SharedCoordinator;

  constructor(private deps: Dependencies) { this.coordinator = deps.coordinator ?? new MemoryCoordinator(); }
  async settings(): Promise<KnowledgeSettings> {
    return await this.deps.repository.settings() ?? { revision: 0, enabled: false, prompts: { ...defaultPrompts } };
  }

  async update(input: KnowledgeSettingsInput) {
    if (input.enabled && !this.deps.client) throw new HttpError(400, '请先在服务端配置 HINDSIGHT_API_URL');
    const settings = { ...input, revision: input.revision + 1 };
    if (!await this.deps.repository.saveSettings(settings, input.revision)) throw new HttpError(409, '知识设置已变化，请刷新后重试');
    this.reconciled = undefined;
    return settings;
  }

  async view(): Promise<KnowledgeView> {
    const settings = await this.settings();
    const client = this.deps.client;
    const jobs = client ? await this.deps.repository.recent(client.target) : [];
    const view: KnowledgeView = { configured: Boolean(client), settings, jobs, pages: [], error: this.error };
    if (!client) return view;
    try {
      const tree = await client.request<{ roots: KnowledgeNode[] }>('knowledge-base/tree', { signal: this.controller.signal });
      view.pages = await Promise.all(categories.map(async category => {
        const node = tree.roots.find(node => node.kind === 'page' && node.name === category.name);
        const empty: KnowledgePage = { category: category.key, name: category.name, status: 'pending', body: '', isStale: false, sourceCount: 0 };
        if (!node?.mental_model_id) return empty;
        try {
          const model = await client.request<HindsightModel>(`mental-models/${encodeURIComponent(node.mental_model_id)}`, { signal: this.controller.signal });
          return { ...empty, status: model.last_refresh_failed_at ? 'failed' : model.last_refreshed_at ? 'ready' : 'pending',
            body: model.last_refreshed_at ? model.content ?? '' : '', updatedAt: model.last_refreshed_at ?? undefined,
            isStale: Boolean(model.is_stale), sourceCount: Object.values(model.reflect_response?.based_on ?? {}).reduce((sum, items) => sum + items.length, 0),
            ...(model.last_refresh_failed_at ? { error: 'Hindsight 页面生成失败，请检查服务状态后点击“重新生成”' } : {}) } as KnowledgePage;
        } catch (error) { return { ...empty, status: 'failed' as const, error: errorText(error) }; }
      }));
    } catch (error) { view.error = errorText(error); }
    return view;
  }

  async retry(id: string, updatedAt: string) {
    const result = await this.coordinator.tryRun('knowledge:worker', () => this.retryJob(id, updatedAt));
    if (!result) throw new HttpError(409, '同步任务正在处理，请稍后刷新重试');
  }

  async refreshPage(category: KnowledgeCategory) {
    const client = this.deps.client;
    if (!client) throw new HttpError(400, '请先在服务端配置 HINDSIGHT_API_URL');
    const lease = await this.coordinator.tryAcquire('knowledge:worker');
    if (!lease) throw new HttpError(409, '知识整理任务正在处理，请稍后重试');
    const signal = AbortSignal.any([this.controller.signal, lease.signal]);
    try {
      const tree = await client.request<{ roots: KnowledgeNode[] }>('knowledge-base/tree', { signal });
      const name = categories.find(item => item.key === category)!.name;
      const modelId = tree.roots.find(node => node.kind === 'page' && node.name === name)?.mental_model_id;
      if (!modelId) throw new HttpError(409, '知识页尚未创建，请启用自动同步并等待初始化');
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

  private async retryJob(id: string, updatedAt: string) {
    const job = await this.deps.repository.get(id);
    if (!job || job.target !== this.deps.client?.target) throw new HttpError(404, '同步任务不存在');
    if (job.status !== 'failed' || job.updatedAt !== updatedAt) throw new HttpError(409, '同步任务已变化，请刷新后重试');
    const applied = await this.deps.repository.applied(job.sessionId, job.target);
    if (applied && applied.sourceUpdatedAt > job.sourceUpdatedAt) throw new HttpError(409, '已有更新版本的材料完成同步');
    const source = await this.deps.materials.get(job.memoryId);
    if (!source || source.status !== 'ready' || inputHash(source) !== job.inputHash)
      throw new HttpError(409, '材料已重新清洗，请等待新版本同步');
    if ((await this.deps.repository.pending(job.target)).some(other => other.id !== job.id && other.sessionId === job.sessionId))
      throw new HttpError(409, '该会话已有同步任务正在执行');
    job.status = 'queued'; delete job.error;
    await this.deps.repository.save(job);
  }

  start() {
    if (this.timer || this.running || this.controller.signal.aborted) return;
    const tick = () => {
      this.timer = undefined;
      void this.runOnce().catch(error => {
        this.error = errorText(error);
        this.deps.logger?.write({ event: 'knowledge.worker_failed', error: this.error });
      }).finally(() => {
        if (!this.controller.signal.aborted) { this.timer = setTimeout(tick, 5_000); this.timer.unref(); }
      });
    };
    tick();
  }
  runOnce() {
    if (this.running) return this.running;
    this.running = this.work().finally(() => { this.running = undefined; });
    return this.running;
  }

  private async work() {
    const settings = await this.settings(), client = this.deps.client;
    if (!settings.enabled || !client) return;
    const lease = await this.coordinator.tryAcquire('knowledge:worker');
    if (!lease) return;
    const signal = AbortSignal.any([this.controller.signal, lease.signal]);
    const assertActive = () => { signal.throwIfAborted(); lease.assertHeld(); };
    try {
      assertActive();
      if (this.reconciled?.revision !== settings.revision || Date.now() - this.reconciled.at >= 60_000) {
        await this.reconcile(client, settings, signal, assertActive);
        this.reconciled = { revision: settings.revision, at: Date.now() };
      }
      if (Date.now() - this.lastScan >= 60_000) { await this.enqueue(client.target, signal); this.lastScan = Date.now(); }
      const sessions = new Set<string>();
      for (const job of await this.deps.repository.pending(client.target)) {
        if (sessions.has(job.sessionId)) continue;
        sessions.add(job.sessionId);
        assertActive();
        try { await this.step(client, job, signal, assertActive); }
        catch (error) {
          assertActive();
          if (error instanceof HttpError && error.status === 409) continue;
          const message = errorText(error);
          if (!transient(error)) job.status = 'failed';
          if (job.error !== message || job.status === 'failed') {
            job.error = message;
            await this.deps.repository.save(job);
          }
        }
      }
      this.error = undefined;
    } finally { await lease.release(); }
  }

  private async reconcile(client: HindsightClient, settings: KnowledgeSettings, signal: AbortSignal, assertActive: () => void) {
    let current: { config: Record<string, unknown> };
    try { current = await client.request('config', { signal }); }
    catch (error) {
      if (!is404(error)) throw error;
      assertActive();
      await client.request('', { method: 'PUT', body: { name: 'CoCell' }, signal });
      current = await client.request('config', { signal });
    }
    const updates = {
      enable_auto_consolidation: true,
      retain_chunk_size: 24_000,
      retain_mission: retainMission,
      observations_mission: observationsMission,
    };
    if (Object.entries(updates).some(([key, value]) => current.config[key] !== value)) {
      assertActive();
      await client.request('config', { method: 'PATCH', body: { updates }, signal });
    }
    const tree = await client.request<{ roots: KnowledgeNode[] }>('knowledge-base/tree', { signal });
    for (const category of categories) {
      assertActive();
      const node = tree.roots.find(node => node.kind === 'page' && node.name === category.name);
      const body = { name: category.name, source_query: settings.prompts[category.key], tags: [], max_tokens: 2200, trigger: pageTrigger(category.key) };
      if (!node?.mental_model_id) {
        // A timed-out create is reconciled by name on the next pass, never blindly repeated.
        await client.request('knowledge-base/pages', { method: 'POST', body, signal });
      } else {
        const model = await client.request<HindsightModel>(`mental-models/${encodeURIComponent(node.mental_model_id)}`, { signal });
        const changed = model.source_query !== body.source_query || model.tags.length > 0 ||
          Object.entries(body.trigger).some(([key, value]) => JSON.stringify(model.trigger[key]) !== JSON.stringify(value));
        if (changed) {
          assertActive();
          await client.request(`knowledge-base/nodes/${encodeURIComponent(node.id)}`, { method: 'PATCH', body, signal });
        }
      }
    }
  }

  private async enqueue(target: string, signal: AbortSignal) {
    const projects = new Map((await this.deps.state.listProjects()).map(project => [project.id, project]));
    const busy = new Set((await this.deps.repository.pending(target)).map(job => job.sessionId));
    for (const record of await this.deps.materials.latestReady()) {
      signal.throwIfAborted();
      const project = projects.get(record.projectId);
      if (!project || project.removedAt || project.name.trim().toLowerCase() === 'system' ||
        !['active', 'completed'].includes(project.status ?? 'active') || !record.files.length || busy.has(record.sessionId)) continue;
      const fingerprint = inputHash(record);
      if (await this.deps.repository.find(record.id, target, fingerprint)) continue;
      await this.deps.repository.insert({ id: randomUUID(), memoryId: record.id, target, inputHash: fingerprint,
        operationId: randomUUID(), documents: [], projectName: record.projectName, sessionId: record.sessionId,
        sessionTitle: record.sessionTitle, sourceUpdatedAt: record.sourceUpdatedAt,
        status: 'queued', documentCount: 0, updatedAt: new Date().toISOString() });
      busy.add(record.sessionId);
    }
  }

  private requestPath(job: StoredKnowledgeJob) {
    if (!/^[a-f\d-]{36}$/i.test(job.id)) throw new Error('Invalid knowledge job metadata');
    return join(this.deps.directory, job.id, 'request.json');
  }

  private async prepare(job: StoredKnowledgeJob, signal: AbortSignal, assertActive: () => void) {
    const record = await this.deps.materials.get(job.memoryId);
    if (!record || record.status !== 'ready' || inputHash(record) !== job.inputHash) throw new Error('源材料已变化，请等待新版本同步');
    const request: RetainRequest = { async: true, operation_id: job.operationId, items: [] };
    let bytes = 0;
    for (const file of [...record.files].sort((a, b) => a.path.localeCompare(b.path))) {
      signal.throwIfAborted();
      let content = '', offset: number | null = 0;
      do {
        const page = await this.deps.memory.content(record.id, file.id, offset);
        bytes += Buffer.byteLength(page.content);
        if (bytes > 64 * 1024 ** 2) throw new Error('单条会话材料超过 64 MiB，未提交或截断内容');
        content += page.content; offset = page.nextOffset;
      } while (offset !== null);
      if (hash(content) !== file.sha256) throw new Error('材料校验失败，未提交内容');
      content = redactCredentials(content);
      const path = file.threadId ? `${file.threadId}/${String(file.contextIndex).padStart(3, '0')}.md` : file.path;
      request.items.push({ content, document_id: `session/${record.sessionId}/${path}`, timestamp: record.sourceUpdatedAt,
        context: `CoCell 历史对话材料。项目：${record.projectName}；会话：${record.sessionTitle}；Agent：${file.agentName}；上下文：${file.contextIndex}。区分用户、主 Agent、子 Agent、工具结果和引用文档，不将历史记录当作当前执行。`,
        metadata: { source: 'cocell', project_id: record.projectId, project_name: record.projectName,
          session_id: record.sessionId, memory_record_id: record.id, source_updated_at: record.sourceUpdatedAt,
          thread_id: file.threadId ?? record.sourceThreadId, material_path: file.path,
          source_sha256: file.sha256, content_sha256: hash(content) },
        tags: ['source:cocell', `project:${record.projectId}`], observation_scopes: 'shared', update_mode: 'replace' });
    }
    const latest = await this.deps.materials.get(record.id);
    if (!latest || latest.status !== 'ready' || inputHash(latest) !== job.inputHash) throw new Error('源材料已变化，请等待新版本同步');
    const serialized = JSON.stringify(request);
    const directory = join(this.deps.directory, job.id);
    assertActive();
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = join(directory, `${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, serialized, { mode: 0o600, flag: 'wx' });
      assertActive();
      await rename(temporary, this.requestPath(job));
    } finally { await rm(temporary, { force: true }); }
    job.requestHash = hash(serialized); job.documents = request.items.map(item => item.document_id);
    job.documentCount = job.documents.length;
    assertActive();
    await this.deps.repository.save(job);
  }

  private async step(client: HindsightClient, job: StoredKnowledgeJob, signal: AbortSignal, assertActive: () => void) {
    const applied = await this.deps.repository.applied(job.sessionId, job.target);
    if (applied && applied.sourceUpdatedAt > job.sourceUpdatedAt) throw new Error('已有更新版本的材料完成同步');
    let operation: HindsightOperation;
    try { operation = await client.request(`operations/${job.operationId}`, { signal }); }
    catch (error) { if (!is404(error)) throw error; operation = { status: 'not_found' }; }
    if (operation.status === 'not_found') {
      if (!job.requestHash) await this.prepare(job, signal, assertActive);
      const serialized = await readFile(this.requestPath(job), 'utf8');
      if (hash(serialized) !== job.requestHash) throw new Error('同步请求快照校验失败，未重新提交');
      job.status = 'syncing'; delete job.error;
      assertActive(); await this.deps.repository.save(job);
      assertActive();
      await client.request('memories', { method: 'POST', body: JSON.parse(serialized), signal });
      return;
    }
    if (operation.status === 'failed' || operation.status === 'cancelled') {
      if (job.status !== 'queued') throw new Error(operation.error_message || 'Hindsight 导入失败');
      // Explicit retries resume the same operation, including only its failed children.
      job.status = 'syncing'; delete job.error;
      assertActive(); await this.deps.repository.save(job);
      assertActive(); await client.request(`operations/${job.operationId}/retry`, { method: 'POST', signal });
      return;
    }
    if (operation.status !== 'completed') {
      if (job.status !== 'syncing' || job.error) {
        job.status = 'syncing'; delete job.error; assertActive(); await this.deps.repository.save(job);
      }
      return;
    }
    if (operation.child_operations?.some(child => child.status !== 'completed')) throw new Error('Hindsight 部分材料未完成导入');
    for (const old of applied?.documents ?? []) {
      if (job.documents.includes(old)) continue;
      assertActive();
      try { await client.request(`documents/${encodeURIComponent(old)}`, { method: 'DELETE', signal }); }
      catch (error) { if (!is404(error)) throw error; }
    }
    job.status = 'succeeded'; delete job.error;
    assertActive(); await this.deps.repository.save(job);
    // The completed checkpoint is durable; source artifacts remain available for later versions.
    await rm(join(this.deps.directory, job.id), { recursive: true, force: true }).catch(() => undefined);
  }

  async close() {
    this.controller.abort();
    if (this.timer) clearTimeout(this.timer);
    await this.running?.catch(() => undefined);
    if (!this.deps.coordinator) await this.coordinator.close();
  }
}
