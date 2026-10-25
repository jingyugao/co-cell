import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ReportDetail, ReportKind, ReportSettings, ReportSource, ReportSourceContent, ReportUsage, ReportsView } from '../../protocol/report-types.js';
import { dueReportSchedules, reportPeriod, reportSchedule } from '../../util/report-periods.js';
import { HttpError, redactCredentials } from '../../util/errors.js';
import { MemoryCoordinator, type SharedCoordinator } from '../infra/storage/coordination.js';
import type { WebStateStore } from '../infra/storage/web-state.js';
import type { ConversationMaterialsService } from '../conversation-materials/service.js';
import type { ConversationMaterialCollector } from '../conversation-materials/collector.js';
import { readMaterialContent } from '../conversation-materials/content.js';
import { defaultReportSettings, reportRules, summaryPrompt } from './prompts.js';
import type { ReportRepository } from './repository.js';
import type { ReportRunner } from './runner.js';
import { publicReport, type StoredWorkReport } from './types.js';

const DAY = 86_400_000;
const MAX_CHARS = 48_000;
const emptyUsage = (): ReportUsage => ({ inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, unknownCalls: 0, estimatedCostUsd: 0 });
const message = (error: unknown) => redactCredentials(error instanceof Error ? error.message : String(error)).slice(0, 1500);
const localDate = (now: Date) => new Date(now.getTime() + 8 * 3_600_000).toISOString().slice(0, 10);
const instant = (date: string) => new Date(`${date}T00:00:00+08:00`);
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

/** Split only when necessary, prefer whole Markdown messages, and never drop an oversized message. */
export function reportChunks(text: string): string[] {
  const result: string[] = [];
  let current = '';
  for (const section of text.split(/(?=\n## )/)) {
    if (current && current.length + section.length > MAX_CHARS) { result.push(current); current = ''; }
    let remaining = section;
    while (remaining.length > MAX_CHARS) {
      let end = MAX_CHARS;
      if (/[\uD800-\uDBFF]/.test(remaining[end - 1])) end--;
      result.push(remaining.slice(0, end));
      remaining = remaining.slice(end);
    }
    current += remaining;
  }
  if (current.trim()) result.push(current);
  return result;
}

export class ReportService {
  private controller = new AbortController();
  private timer?: ReturnType<typeof setTimeout>;
  private running?: Promise<void>;
  private coordinator: SharedCoordinator;
  private now: () => Date;
  constructor(private deps: {
    repository: ReportRepository;
    state: Pick<WebStateStore, 'listProjects' | 'listSessions'>;
    materials: ConversationMaterialsService;
    collector: Pick<ConversationMaterialCollector, 'collect'>;
    runner: Pick<ReportRunner, 'advance' | 'assertRetryable'>;
    directory: string;
    coordinator?: SharedCoordinator;
    now?: () => Date;
    logger?: { write(event: Record<string, unknown>): void };
  }) {
    this.coordinator = deps.coordinator ?? new MemoryCoordinator();
    this.now = deps.now ?? (() => new Date());
  }

  async settings() { return await this.deps.repository.settings() ?? structuredClone(defaultReportSettings); }
  async view(offset = 0, limit = 50): Promise<ReportsView> {
    const settings = await this.settings();
    return { settings, nextRuns: reportSchedule(settings, this.now()), ...await this.deps.repository.list(offset, limit) };
  }
  async update(input: ReportSettings) {
    reportSchedule(input, this.now());
    const result = await this.coordinator.tryRun('reports:schedule', async () => {
      const settings = { ...input, revision: input.revision + 1 };
      if (!await this.deps.repository.saveSettings(settings, input.revision)) throw new HttpError(409, '报告设置已变化，请刷新后重试');
      return settings;
    });
    if (!result) throw new HttpError(409, '报告计划正在更新，请稍后重试');
    return result.value;
  }
  async generate(kind: ReportKind, date: string) {
    const period = reportPeriod(kind, date);
    if (period.periodEnd > localDate(this.now())) throw new HttpError(400, '请选择已经结束的完整自然日或自然周');
    const now = this.now().toISOString();
    const settings = await this.settings();
    return publicReport(await this.deps.repository.insert({ ...period, id: randomUUID(), runId: randomUUID(), kind,
      status: 'queued', model: settings.model, settings, sources: [], calls: [], sourceCount: 0, missingCount: 0,
      sessionIds: [], usage: emptyUsage(), createdAt: now, updatedAt: now }));
  }
  async detail(id: string): Promise<ReportDetail> {
    const report = await this.require(id);
    const sources = await Promise.all(report.sources.map(async source => ({ ...source,
      summary: await this.read(join(this.directory(report), 'sources', `${source.sessionId}.summary.md`)) })));
    return { report: publicReport(report), sources,
      body: await this.read(join(this.directory(report), 'report.md')), prompt: report.settings.prompts[report.kind] };
  }
  async source(id: string, sessionId: string, offset = 0): Promise<ReportSourceContent> {
    const report = await this.require(id);
    if (!report.sources.some(source => source.sessionId === sessionId)) throw new HttpError(404, '报告来源不存在');
    const directory = join(this.directory(report), 'sources');
    const input = `${sessionId}.input.md`;
    const exists = await access(join(directory, input)).then(() => true).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    });
    return readMaterialContent(directory, exists ? input : `${sessionId}.summary.md`, offset);
  }
  async retry(id: string, updatedAt: string) {
    const result = await this.coordinator.tryRun('reports:worker', async () => {
      const report = await this.require(id);
      if (report.status !== 'failed' || report.updatedAt !== updatedAt) throw new HttpError(409, '报告状态已变化，请刷新后重试');
      await this.deps.runner.assertRetryable(report.calls);
      // In-flight calls are resumed by identity, never blindly submitted a second time.
      const unknown = report.calls.find(call => call.status === 'running' || call.status === 'submitting');
      if (unknown) {
        report.status = report.inputsReady ? 'summarizing' : 'collecting';
        delete report.error;
        await this.save(report);
        return;
      }
      report.previousUsage = report.usage;
      report.runId = randomUUID();
      report.settings = await this.settings();
      report.model = report.settings.model;
      report.calls = []; report.sources = []; report.sourceCount = 0; report.missingCount = 0;
      delete report.inputsReady; delete report.dailyReportIds; delete report.rawSourceIds; delete report.generatedAt; delete report.error;
      report.status = 'queued';
      await this.save(report);
    });
    if (!result) throw new HttpError(409, '报告任务正在处理，请稍后重试');
  }

  start() {
    if (this.timer || this.running || this.controller.signal.aborted) return;
    const tick = () => {
      this.timer = undefined;
      void this.runOnce().catch(error => this.deps.logger?.write({ event: 'reports.worker_failed', error: message(error) })).finally(() => {
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
    const lease = await this.coordinator.tryAcquire('reports:worker');
    if (!lease) return;
    const signal = AbortSignal.any([this.controller.signal, lease.signal]);
    try {
      await this.coordinator.run('reports:schedule', async () => {
        const settings = await this.settings();
        const cursor = await this.deps.repository.cursor();
        if (!cursor) return;
        const now = this.now();
        // Bound catch-up after long downtime; older dates remain available through manual generation.
        const since = new Date(Math.min(now.getTime(), Math.max(Date.parse(cursor), now.getTime() - 30 * DAY)));
        for (const due of dueReportSchedules(settings, since, now)) {
          signal.throwIfAborted(); lease.assertHeld();
          await this.generate(due.kind, due.periodStart);
        }
        await this.deps.repository.saveCursor(now.toISOString(), settings.revision);
      });
      const report = (await this.deps.repository.pending())[0];
      if (!report) return;
      const save = async () => { signal.throwIfAborted(); lease.assertHeld(); await this.save(report); };
      try {
        if (!report.inputsReady) { await this.collect(report, signal, save); return; }
        await this.summarize(report, signal, save);
      } catch (error) {
        signal.throwIfAborted(); lease.assertHeld();
        if (error instanceof HttpError && error.status === 409
          && (await this.deps.repository.get(report.id))?.updatedAt !== report.updatedAt) throw error;
        report.status = 'failed'; report.error = message(error);
        await save();
      }
    } finally { await lease.release(); }
  }

  private async collect(report: StoredWorkReport, signal: AbortSignal, save: () => Promise<void>) {
    report.status = 'collecting'; await save();
    const directory = this.directory(report);
    await rm(join(directory, 'sources'), { recursive: true, force: true });
    await mkdir(join(directory, 'sources'), { recursive: true, mode: 0o700 });
    const readyDays = new Set<string>();
    const reused = new Map<string, ReportSource>();
    const dailyBodies: string[] = [];
    report.dailyReportIds = [];
    report.rawSourceIds = [];
    if (report.kind === 'weekly') {
      for (let at = instant(report.periodStart).getTime(); at < instant(report.periodEnd).getTime(); at += DAY) {
        const date = localDate(new Date(at));
        const daily = await this.deps.repository.find('daily', date);
        if (daily?.status !== 'ready' || daily.missingCount || daily.snapshotCount) continue;
        const body = await this.read(join(this.directory(daily), 'report.md'));
        if (!body) continue;
        readyDays.add(date); report.dailyReportIds.push(daily.id);
        dailyBodies.push(`# ${date} 工作日报\n\n${body}`);
        for (const source of daily.sources) {
          if (source.status !== 'included') continue;
          reused.set(source.sessionId, { ...source, summary: undefined });
          const summary = await this.read(join(this.directory(daily), 'sources', `${source.sessionId}.summary.md`));
          const existing = await this.read(join(directory, 'sources', `${source.sessionId}.summary.md`));
          await this.write(join(directory, 'sources', `${source.sessionId}.summary.md`), [existing, `## ${date}\n\n${summary}`].filter(Boolean).join('\n\n'));
        }
      }
    }
    await this.write(join(directory, 'daily-input.md'), dailyBodies.join('\n\n'));
    const [projects, sessions] = await Promise.all([this.deps.state.listProjects(), this.deps.state.listSessions()]);
    const byProject = new Map(projects.filter(project => !project.removedAt && project.name.trim().toLowerCase() !== 'system'
      && ['active', 'completed'].includes(project.status ?? 'active')).map(project => [project.id, project]));
    const needsRaw = report.kind === 'daily' || readyDays.size < 7;
    const sources = new Map(reused);
    if (needsRaw) for (const session of sessions) {
      signal.throwIfAborted();
      const project = session.projectId ? byProject.get(session.projectId) : undefined;
      if (!project || !session.threadId || session.settings.executionMode !== 'sandbox'
        || !(session.turnCount || session.turns.length)
        || session.status !== 'running' && Date.parse(session.updatedAt) < instant(report.periodStart).getTime()) continue;
      const source: ReportSource = { sessionId: session.id, projectId: project.id, projectName: project.name,
        sessionTitle: session.title, sourceUpdatedAt: session.updatedAt, status: 'empty' };
      try {
        const material = await this.deps.collector.collect(session, signal);
        source.materialId = material.id;
        source.isSnapshot = !material.complete;
        source.collectedAt = material.createdAt;
        const parts: string[] = [];
        let bytes = 0;
        for (let at = instant(report.periodStart).getTime(); at < instant(report.periodEnd).getTime(); at += DAY) {
          const date = localDate(new Date(at));
          if (readyDays.has(date)) continue;
          const selected = await this.deps.materials.period(material.id, new Date(at), new Date(at + DAY), signal);
          for (const part of selected) {
            const content = `# ${date} · ${part.path}\n\n${part.content}`;
            bytes += Buffer.byteLength(content);
            if (bytes > 64 * 1024 ** 2) throw new Error('单条会话的报告材料超过 64 MiB，未截断或提交');
            parts.push(content);
          }
        }
        if (parts.length) {
          source.status = 'included';
          report.rawSourceIds.push(source.sessionId);
          const previous = await this.read(join(directory, 'sources', `${source.sessionId}.summary.md`));
          await this.write(join(directory, 'sources', `${source.sessionId}.input.md`),
            [previous ? `# 已有日报中的进展\n\n${previous}` : '', ...parts].filter(Boolean).join('\n\n'));
          // Any earlier daily summary is now background for a new, period-wide summary.
          await this.write(join(directory, 'sources', `${source.sessionId}.summary.md`), '');
        } else if (reused.has(source.sessionId)) continue;
      } catch (error) {
        signal.throwIfAborted();
        source.status = 'failed'; source.error = message(error);
      }
      sources.set(source.sessionId, source);
      report.sources = [...sources.values()]; await save();
    }
    report.sources = [...sources.values()]; report.inputsReady = true;
    report.status = 'summarizing'; await save();
  }

  private async summarize(report: StoredWorkReport, signal: AbortSignal, save: () => Promise<void>) {
    const directory = this.directory(report);
    for (const source of report.sources.filter(source => source.status === 'included')) {
      signal.throwIfAborted();
      const output = join(directory, 'sources', `${source.sessionId}.summary.md`);
      if (await this.read(output)) continue;
      const input = await this.read(join(directory, 'sources', `${source.sessionId}.input.md`));
      if (!input) throw new Error('报告来源材料丢失，未生成不完整摘要');
      const chunks = reportChunks(input);
      const summaries: string[] = [];
      for (let index = 0; index < chunks.length; index++) {
        const prompt = `${reportRules}\n\n${summaryPrompt}\n\n报告要求：${report.settings.prompts[report.kind]}\n统计期间：${report.periodStart} 至 ${report.periodEnd}（不含结束日，北京时间）。\n`
          + `项目：${source.projectName}\n对话：${source.sessionTitle}\n来源：[原始对话](/sessions/${source.sessionId})\n`
          + (source.isSnapshot ? `此来源含进行中轮次，采集于${source.collectedAt}。只描述快照中可证实的进展，不能推断最终完成。\n` : '')
          + `材料分段：${index + 1}/${chunks.length}\n\n<工作材料>\n${chunks[index]}\n</工作材料>`;
        const result = await this.call(report, prompt, `${source.projectName} · 业务进展摘要`, true, save);
        if (result === undefined) return;
        summaries.push(result);
      }
      const folded = await this.fold(report, summaries.join('\n\n'), save);
      if (folded === undefined) return;
      await this.write(output, `## ${source.projectName} · ${source.sessionTitle}\n\n来源：[原始对话](/sessions/${source.sessionId})\n\n${folded}`);
    }
    const summaries = await Promise.all(report.sources.filter(source => source.status === 'included')
      .map(source => this.read(join(directory, 'sources', `${source.sessionId}.summary.md`))));
    const dailyInput = await this.read(join(directory, 'daily-input.md'));
    // Ready daily reports already contain the reused sources; do not duplicate their summaries in the weekly input.
    const direct = summaries.filter((_summary, index) => (report.rawSourceIds ?? []).includes(
      report.sources.filter(source => source.status === 'included')[index].sessionId)).join('\n\n');
    const combined = [dailyInput, dailyInput ? direct : summaries.join('\n\n')].filter(Boolean).join('\n\n');
    const missing = report.sources.filter(source => source.status === 'failed');
    if (!combined.trim()) {
      if (missing.length) throw new Error(`有 ${missing.length} 条对话材料读取失败，无法判断本期业务进展`);
      await this.complete(report, '# 工作报告\n\n本期可读取的对话中没有新增工作材料。', save);
      return;
    }
    const folded = await this.fold(report, combined, save);
    if (folded === undefined) return;
    report.status = 'generating'; await save();
    const gaps = missing.length ? `\n材料缺失：${missing.map(source => `${source.projectName} / ${source.sessionTitle}`).join('；')}。报告必须注明覆盖不完整，不可推断这些事项没有进展。` : '';
    const prompt = `${reportRules}\n\n${report.settings.prompts[report.kind]}\n\n统计期间：${report.periodStart} 至 ${report.periodEnd}（不含结束日，北京时间）。${gaps}\n控制在 800—1500 个汉字左右。\n\n<业务进展材料>\n${folded}\n</业务进展材料>`;
    const body = await this.call(report, prompt, `${report.kind === 'daily' ? '工作日报' : '工作周报'} · ${report.periodStart}`, false, save);
    if (body === undefined) return;
    await this.complete(report, body + (missing.length ? `\n\n> 本报告有 ${missing.length} 条对话材料未能读取，覆盖不完整。` : ''), save);
  }

  private async fold(report: StoredWorkReport, text: string, save: () => Promise<void>): Promise<string | undefined> {
    let current = text;
    for (let level = 0; current.length > MAX_CHARS; level++) {
      if (level >= 8) throw new Error('报告摘要规模过大，未截断业务材料');
      const results: string[] = [];
      for (const chunk of reportChunks(current)) {
        const result = await this.call(report, `${reportRules}\n\n将下列业务进展摘要归并为不超过 1200 个汉字的中间摘要。`
          + `保留业务事项、进展、状态变化、验证边界和来源。报告期间：${report.periodStart} 至 ${report.periodEnd}（不含结束日）。\n\n${chunk}`,
        '业务进展归并', true, save);
        if (result === undefined) return;
        results.push(result);
      }
      current = results.join('\n\n');
    }
    return current;
  }

  private async call(report: StoredWorkReport, prompt: string, title: string, cacheable: boolean, save: () => Promise<void>) {
    const key = hash(JSON.stringify([1, report.model, report.settings.modelEntryId, prompt]));
    const cachePath = join(this.deps.directory, 'summaries', `${key}.md`);
    let call = report.calls.find(call => call.key === key);
    if (!call && cacheable) {
      const cached = await this.deps.repository.summary(key);
      const text = cached ? await this.read(cachePath) : '';
      if (cached && text) {
        call = { key, status: 'ready', sessionId: cached.sessionId, usage: emptyUsage() };
        report.calls.push(call); await save();
        return text;
      }
    }
    if (!call) { call = { key, status: 'pending' }; report.calls.push(call); await save(); }
    const path = join(this.directory(report), 'calls', `${key}.output.md`);
    if (call.status === 'ready') {
      const text = await this.read(path) || (cacheable ? await this.read(cachePath) : '');
      if (!text) throw new Error('已生成的摘要文件丢失，请检查共享存储');
      return text;
    }
    await this.write(join(this.directory(report), 'calls', `${key}.input.md`), prompt);
    const result = await this.deps.runner.advance(call, prompt, title, report.settings, save);
    if (result === undefined) return undefined;
    await this.write(path, result);
    if (cacheable) {
      await this.write(cachePath, result);
      await this.deps.repository.saveSummary(key, { sessionId: call.sessionId!, usage: call.usage ?? emptyUsage() });
    }
    call.status = 'ready'; await save();
    return result;
  }

  private async complete(report: StoredWorkReport, body: string, save: () => Promise<void>) {
    await this.write(join(this.directory(report), 'report.md'), body);
    report.status = 'ready'; report.generatedAt = this.now().toISOString(); delete report.error;
    await save();
  }
  private async save(report: StoredWorkReport) {
    report.sourceCount = report.sources.filter(source => source.status === 'included').length;
    report.missingCount = report.sources.filter(source => source.status === 'failed').length;
    report.snapshotCount = report.sources.filter(source => source.status === 'included' && source.isSnapshot).length;
    report.sessionIds = [...new Set([...report.sessionIds, ...report.calls.flatMap(call => call.sessionId ? [call.sessionId] : [])])];
    const usage = report.previousUsage ? { ...report.previousUsage } : emptyUsage();
    for (const call of report.calls) if (call.usage) {
      usage.inputTokens += call.usage.inputTokens; usage.cachedInputTokens += call.usage.cachedInputTokens;
      usage.outputTokens += call.usage.outputTokens; usage.unknownCalls += call.usage.unknownCalls;
      usage.estimatedCostUsd = usage.estimatedCostUsd === null || call.usage.estimatedCostUsd === null ? null : usage.estimatedCostUsd + call.usage.estimatedCostUsd;
    }
    report.usage = usage;
    await this.deps.repository.save(report);
  }
  private directory(report: StoredWorkReport) {
    if (![report.id, report.runId].every(id => /^[a-f\d-]{36}$/i.test(id))) throw new Error('Invalid report metadata');
    return join(this.deps.directory, report.id, report.runId);
  }
  private async require(id: string) {
    const report = await this.deps.repository.get(id);
    if (!report) throw new HttpError(404, '工作报告不存在');
    return report;
  }
  private async read(path: string) {
    try { return await readFile(path, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error; }
  }
  private async write(path: string, content: string) {
    await mkdir(join(path, '..'), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, content, { mode: 0o600 });
    await rename(temporary, path);
  }
  async close() {
    this.controller.abort();
    if (this.timer) clearTimeout(this.timer);
    await this.running?.catch(() => undefined);
  }
}
