import type { ReportSettings, ReportUsage } from '../../protocol/report-types.js';
import type { WebStateStore } from '../infra/storage/web-state.js';
import type { SessionManager } from '../sessions/manager.js';
import type { ModelService } from '../models/service.js';
import { HttpError } from '../../util/errors.js';
import { countTokens, extractTurnText } from '../../util/tokenizer.js';
import { estimateTokenCostUsd } from '../../util/model-costs.js';
import type { ReportCall } from './types.js';

/** One dedicated system session per call makes unknown submissions recoverable by identity. */
export class ReportRunner {
  constructor(private deps: {
    state: Pick<WebStateStore, 'listProjects'>;
    manager: Pick<SessionManager, 'create' | 'startTurn' | 'read' | 'readProject' | 'stop'>;
    models: Pick<ModelService, 'catalog'>;
  }) {}

  async assertRetryable(calls: ReportCall[]) {
    for (const call of calls) if (call.sessionId && call.status !== 'ready') {
      const session = await this.deps.manager.read(call.sessionId);
      if (session.historyError || session.turns.some(turn => turn.status === 'running'))
        throw new HttpError(409, '生成会话仍在运行或状态无法确认，请先查看生成过程');
    }
  }

  async advance(call: ReportCall, prompt: string, title: string, settings: ReportSettings, save: () => Promise<void>): Promise<string | undefined> {
    if (call.status === 'failed') throw new Error(call.error ?? '报告生成失败');
    if (!call.sessionId) {
      const projects = (await this.deps.state.listProjects()).filter(project => project.name.trim().toLowerCase() === 'system'
        && project.status === 'active' && !project.removedAt);
      if (projects.length !== 1 || !projects[0].sandbox)
        throw new HttpError(409, '请先准备一个可用的 system 项目；报告任务不会创建或恢复 Sandbox');
      // Persistent metadata deliberately stores status=unknown. Observe Cellbox through the read path.
      const project = await this.deps.manager.readProject(projects[0].id);
      if (project.sandbox?.id !== projects[0].sandbox.id || project.sandbox.status !== 'ready')
        throw new HttpError(409, '请先准备一个可用的 system 项目；报告任务不会创建或恢复 Sandbox');
      const catalog = await this.deps.models.catalog();
      const entry = catalog.channels.filter(channel => channel.enabled).flatMap(channel => channel.models)
        .find(model => model.visible && model.model === settings.model && (!settings.modelEntryId || model.id === settings.modelEntryId));
      if (!entry) throw new Error('报告模型尚未在可用渠道中配置，请先在模型管理中添加或重新选择模型');
      const session = await this.deps.manager.create({ projectId: projects[0].id, title: title.slice(0, 100),
        settings: { model: entry.model, modelEntryId: entry.id, modelReasoningEffort: 'low',
          sandboxMode: 'read-only', webSearchMode: 'disabled', networkAccessEnabled: false } });
      call.sessionId = session.id;
      await save();
    }
    if (call.status === 'pending') {
      call.status = 'submitting';
      call.startedAt = new Date().toISOString();
      call.usage = { inputTokens: countTokens(prompt), cachedInputTokens: 0, outputTokens: 0,
        unknownCalls: 1, estimatedCostUsd: null };
      call.usage.estimatedCostUsd = estimateTokenCostUsd(settings.model, call.usage);
      await save();
      try {
        call.turnId = await this.deps.manager.startTurn(call.sessionId, prompt, []);
        call.status = 'running';
        await save();
      } catch (error) {
        // A disconnected RPC may already have started the turn. Observe it on the next tick.
        call.error = error instanceof Error ? error.message : '报告提交结果尚未确认';
        await save();
      }
      return undefined;
    }
    const session = await this.deps.manager.read(call.sessionId);
    if (session.historyError) throw new Error(session.historyError);
    const turn = call.turnId ? session.turns.find(turn => turn.nativeTurnId === call.turnId || turn.id === call.turnId)
      : session.turns.find(turn => turn.prompt === prompt);
    if (!turn) {
      call.status = 'failed';
      call.error = '生成会话缺少已提交的轮次；未自动重复提交，请查看生成会话后手动重试';
      await save();
      throw new Error(call.error);
    }
    call.turnId = turn.nativeTurnId ?? turn.id;
    call.status = 'running';
    if (turn.status === 'running' || turn.status === 'idle') {
      if (call.startedAt && Date.now() - Date.parse(call.startedAt) > 30 * 60_000) {
        await this.deps.manager.stop(call.sessionId);
        throw new Error('报告生成超过 30 分钟，已停止本任务的生成会话');
      }
      await save();
      return undefined;
    }
    const usage = turn.usage;
    const validTokens = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
    call.usage = { inputTokens: validTokens(usage?.input_tokens) ? usage.input_tokens : countTokens(prompt),
      cachedInputTokens: validTokens(usage?.cached_input_tokens) ? usage.cached_input_tokens : 0,
      outputTokens: validTokens(usage?.output_tokens) ? usage.output_tokens : countTokens(extractTurnText({ prompt: '', items: turn.items })),
      unknownCalls: validTokens(usage?.input_tokens) && validTokens(usage?.output_tokens) ? 0 : 1, estimatedCostUsd: null } satisfies ReportUsage;
    call.usage.estimatedCostUsd = estimateTokenCostUsd(settings.model, call.usage);
    if (turn.status !== 'completed') {
      call.status = 'failed';
      call.error = turn.error ?? `生成轮次未完成（${turn.status}）`;
      await save();
      throw new Error(call.error);
    }
    const messages = turn.items.filter(item => item.type === 'agent_message');
    const result = messages.at(-1)?.text.trim();
    if (!result) {
      call.status = 'failed';
      call.error = '模型没有返回报告正文，请查看生成会话';
      await save();
      throw new Error(call.error);
    }
    delete call.error;
    return result;
  }
}
