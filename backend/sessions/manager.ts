import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { mkdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve, sep, posix } from 'node:path';
import type { Project, ProjectSummary, Session, SessionSummary, SessionTurnPage, Settings, StreamMessage, SubagentConversation, Turn } from '../../protocol/types.js';
import type { UserInputQuestion, UserInputRequest } from '../../protocol/user-input-types.js';
import type { SandboxRuntime } from '../execution/container-runtime.js';
import { SandboxLifecycleService } from '../projects/sandbox-lifecycle.js';
import { ProjectSandboxOperations } from '../projects/sandbox-operations.js';
import type { WorkspaceFileReadOptions } from '../workspaces/files.js';
import type { RuntimeLog } from '../infra/diagnostics/runtime-log.js';
import type { ArchiveService } from '@co-cell/archives';

import { HttpError } from '../../util/errors.js';
import { ProjectService, type ProjectInput, type ProjectUpdate } from '../projects/service.js';
import { AtomicJsonWriter } from '../infra/storage/atomic-json.js';
import { createWebStateStore, type WebStateStore } from '../infra/storage/web-state.js';
import { runTurn, type CodexClient } from '../execution/runner.js';
import type { WorkspaceTarget } from '../sandboxes/types.js';
import { ApprovalRequests, approvalDecisionSchema, cancelPersistedApprovals } from '../approvals/requests.js';
import { readNativeHistory, readSubagentConversations } from '../execution/native-history.mjs';
import type { NotificationStore } from '../notifications/store.js';
import { estimateSessionCosts, type SessionCostBreakdown } from '../../util/billing.js';
import { MODEL_TOKEN_RATES } from '../../util/model-costs.js';

export type { CodexClient } from '../execution/runner.js';
type Subscriber = (message: StreamMessage) => void;
type ActiveExecution = {
  controller: AbortController;
  done: Promise<void>;
  turnId?: string;
  approvals?: ApprovalRequests;
  finish(): void;
};

function normalizeExecutionSettings(settings: Settings): Settings {
  // Sandbox is the isolation boundary; Codex inside it uses guidance rather than
  // another filesystem/network sandbox (toolchain caches live outside cwd).
  return settings.executionMode === 'sandbox'
    ? { ...settings, sandboxMode: 'danger-full-access', networkAccessEnabled: true }
    : settings;
}

export interface SandboxLifecycleOptions {
  archivedReclaimAfterMs?: number;
  scanIntervalMs?: number;
  now?: () => number;
}
export class SessionManager {
  private lifecycle?: SandboxLifecycleService;
  private notifications?: NotificationStore;
  private projects: ProjectService;
  private sandboxOperations?: ProjectSandboxOperations;
  private danglingDeletions = new Map<string, Promise<void>>();
  private sessions = new Map<string, Session>();
  private active = new Map<string, ActiveExecution>();
  private subscribers = new Map<string, Set<Subscriber>>();
  private writer = new AtomicJsonWriter();
  private deleting = new Set<string>();
  private uploads = new Map<string, Set<Promise<string>>>();
  private closing = false;
  private historyReads = new Map<string, Promise<void>>();
  private historyErrors = new Map<string, string>();
  private billingReads = new Map<string, Promise<SessionCostBreakdown>>();

  constructor(
    private client: CodexClient,
    public readonly dataDirectory: string,
    public readonly defaults: Settings,
    private sandbox?: SandboxRuntime,
    private sandboxWorkingDirectory = '/home/user/workspace',
    private logger?: RuntimeLog,
    private state: WebStateStore = createWebStateStore(dataDirectory),
    private readonly imagesDirectory = join(dataDirectory, 'images'),
    lifecycleOptions: SandboxLifecycleOptions = {},
    notifications?: NotificationStore,
    private _archiveManager?: ArchiveService,
    backupIgnore: string[] = [],
  ) {
    this.notifications = notifications;
    this.projects = new ProjectService(state);
    if (sandbox) {
      this.sandboxOperations = new ProjectSandboxOperations({
        projects: this.projects, runtime: sandbox, archives: () => this._archiveManager,
        content: this._archiveManager,
        directory: join(dataDirectory, '..', 'sandbox-data-archives'),
        threadIds: id => [...this.sessions.values()].filter(session => session.projectId === id).flatMap(session => session.threadId ? [session.threadId] : []),
        saveSandbox: (id, value, restore) => this.updateSandbox(id, id, value, restore),
        logger: this.logger,
        backupIgnore,
        detached: async id => {
          for (const session of this.sessions.values()) {
            if (session.projectId !== id) continue;
            delete session.sandbox;
            await this.save(session);
            this.publish(session.id, { type: 'state', session: this.get(session.id) });
          }
        },
      });
      this.lifecycle = new SandboxLifecycleService({
        ...lifecycleOptions,
        listProjects: () => this.projects.list(),
        reclaim: id => this.archiveProjectNow(id).then(() => {}),
      });
    }
  }

  /** @internal 供归档路由使用 */
  get archiveManager(): ArchiveService | undefined { return this._archiveManager; }

  async init() {
    await this.state.init();
    await this.projects.init();
    // A process crash can interrupt a backup while Docker is paused. The
    // persisted operation phase survives the running -> failed reconciliation.
    for (const project of this.projects.list()) {
      if (project.sandbox && ['backup', 'switch'].includes(project.sandboxOperation?.kind ?? '')
        && ['暂停环境', '创建 Restic 快照', '创建增量快照'].includes(project.sandboxOperation?.phase ?? '')) {
        if (!this.sandbox?.resumeAfterBackup) throw new Error('Cannot reconcile an interrupted paused Sandbox backup');
        await this.sandbox.resumeAfterBackup(project.sandbox.id);
      }
      if (['migrate', 'switch'].includes(project.sandboxOperation?.kind ?? '')
        && ['创建首个 Restic 快照', '创建首个增量快照'].includes(project.sandboxOperation?.phase ?? '')) {
        if (!this.sandbox?.resumeAfterBackup) throw new Error('Cannot reconcile an interrupted migration snapshot');
        for (const candidate of project.pendingSandboxCleanup ?? []) await this.sandbox.resumeAfterBackup(candidate.id);
      }
      if (['migrate', 'switch'].includes(project.sandboxOperation?.kind ?? '') && project.sandboxOperation?.phase === '切换环境'
        && project.archiveKey && this._archiveManager) {
        const latest = await this._archiveManager.getLatest(project.archiveKey);
        const hostBacked = project.sandbox && await this.sandbox?.hostData?.({ id: project.id, projectId: project.id,
          settings: { workingDirectory: project.workingDirectory }, sandbox: project.sandbox, updatedAt: project.updatedAt });
        if (!hostBacked && latest?.metadata.verified === true && latest.metadata.sourceSandboxId !== project.sandbox?.id) {
          const reverted = await this._archiveManager.revertLatestVersion(project.archiveKey, latest.id);
          if (!reverted) throw new Error(`Cannot reconcile interrupted Sandbox migration for ${project.id}`);
          const previous = await this._archiveManager.getLatest(project.archiveKey);
          if (previous) {
            const details = this._archiveManager.describe(previous);
            await this.projects.updateLatestBackup(project.id, { createdAt: details.createdAt, sizeBytes: details.sizeBytes,
              ...(details.bytesAdded === undefined ? {} : { bytesAdded: details.bytesAdded }) });
          }
          if (project.sandbox) await this.sandbox?.startReplacement?.(project.sandbox).catch(() => {});
        } else if (hostBacked && project.sandbox && latest?.metadata.sourceSandboxId === project.sandbox.id) {
          // The old host-backed Sandbox was fenced before its replacement was persisted.
          await this.sandbox?.startReplacement?.(project.sandbox);
        }
      }
    }
    for (const session of await this.state.listSessions()) {
      // Invalid state is reported rather than silently overwriting someone's history.
      if (!session.id || !Array.isArray(session.turns) || !session.settings) {
        throw new Error(`Invalid session state: ${session.id}`);
      }
      let changed = false;
      // Session archives were introduced after the initial JSON format. Use the
      // original creation time for records that predate the explicit start time.
      if (!session.startedAt) {
        session.startedAt = session.createdAt;
        changed = true;
      }
      if (session.archivedAt === undefined) {
        session.archivedAt = null;
        changed = true;
      }
      if (!session.projectId && session.settings.executionMode === 'sandbox') {
        // Persist the project first. If interrupted, deterministic IDs make migration repeatable.
        if (!this.projects.find(session.id)) {
          const project: Project = { id: session.id, name: session.title, requirementUrl: null, executionMode: 'sandbox', workingDirectory: session.settings.workingDirectory, status: 'active', completedAt: null, archivedAt: null,
            sandbox: session.sandbox, createdAt: session.createdAt, updatedAt: session.updatedAt };
          await this.projects.import(project);
        }
        session.projectId = session.id;
        changed = true;
      }
      if (session.projectId) {
        const project = this.projects.find(session.projectId);
        if (!project) throw new Error(`Missing project for session: ${session.id}`);
        if (JSON.stringify(session.sandbox) !== JSON.stringify(project.sandbox)
          || session.settings.executionMode !== project.executionMode || session.settings.workingDirectory !== project.workingDirectory) changed = true;
        session.sandbox = structuredClone(project.sandbox);
        session.settings.executionMode = project.executionMode;
        session.settings.workingDirectory = project.workingDirectory;
      }
      const normalized = normalizeExecutionSettings(session.settings);
      if (normalized.sandboxMode !== session.settings.sandboxMode || normalized.networkAccessEnabled !== session.settings.networkAccessEnabled) {
        session.settings = normalized;
        changed = true;
      }
      for (const turn of session.turns) {
        if (turn.status === 'running' && !turn.execution && !this.canRecover(session, turn)) {
          turn.status = 'cancelled';
          turn.error = '服务重启时发现本轮没有可恢复的执行任务，已标记为已停止。';
          turn.completedAt = new Date().toISOString();
          changed = true;
        }
        if (!this.canRecover(session, turn) && cancelPersistedApprovals(turn)) changed = true;
        if (turn.retry !== undefined) {
          delete turn.retry;
          changed = true;
        }
        if (!this.canRecover(session, turn) && turn.status !== 'running' && turn.phase !== undefined) {
          delete turn.phase;
          changed = true;
        }
        // Older versions retained transient stream errors even after a successful turn.
        if (turn.status === 'completed' && turn.error !== undefined) {
          delete turn.error;
          changed = true;
        }
      }
      if (session.status === 'running' || session.turns.some(turn => turn.status === 'running' || this.canRecover(session, turn))) {
        changed = true;
        for (const turn of session.turns.filter(t => t.status === 'running' || this.canRecover(session, t))) {
          if (this.canRecover(session, turn)) {
            // Message bodies are reconstructed from the worker journal or an App Server turn snapshot.
            if (!turn.items.length && !turn.prompt && turn.execution) turn.execution.lastAppliedSeq = 0;
            turn.phase = 'recovering';
            continue;
          }
          turn.status = 'cancelled';
          if (turn.execution) turn.execution.state = 'terminal';
          delete turn.phase;
          turn.error = '服务已重启，本轮执行已中断。可以发送消息继续原会话。';
          turn.completedAt = new Date().toISOString();
        }
        session.status = session.turns.some(turn => turn.status === 'running' || this.canRecover(session, turn))
          ? 'running' : session.turns.at(-1)?.status ?? 'cancelled';
      }
      if (changed) await this.save(session);
      this.sessions.set(session.id, session);
    }
    // Restore idle tracking without connecting to or waking persisted sandboxes.
    // Projects remain owners even after their last conversation is deleted.
    for (const project of this.projects.list()) {
      if (project.executionMode !== 'sandbox' || !project.sandbox) continue;
      const siblings = [...this.sessions.values()].filter(session => session.projectId === project.id)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      const owner: WorkspaceTarget = siblings[0] ? structuredClone(this.hydrate(siblings[0])) : this.projectWorkspace(project);
      if (project.updatedAt > owner.updatedAt) owner.updatedAt = project.updatedAt;
      this.sandbox?.track?.(owner, sandbox => this.updateSandbox(project.id, owner.id, sandbox));
    }
    // Reconcile persisted project bindings with the current Docker daemon. A
    // container may have disappeared while its database reference remained.
    for (const project of this.projects.list()) {
      if (project.executionMode !== 'sandbox' || !project.sandbox || !this.sandbox?.inspect) continue;
      try { await this.sandbox.inspect(this.projectWorkspace(project)); }
      catch { /* inspect persists an unavailable state for missing containers */ }
    }
    for (const session of this.sessions.values()) {
      if (session.projectId || session.settings.executionMode !== 'sandbox' || !session.sandbox) continue;
      this.sandbox?.track?.(structuredClone(session), sandbox => this.updateSandbox(undefined, session.id, sandbox));
    }
    const recoverable = [...this.sessions.values()].flatMap(session => {
      const turn = session.turns.find(turn => this.canRecover(session, turn));
      return turn ? [{ session, turn }] : [];
    });
    // Register remote use before connection/recovery yields to lifecycle scans.
    for (const { session, turn } of recoverable) this.sandbox?.trackExecution?.(session, turn);
    for (const { session, turn } of recoverable) this.executeTurn(session, turn, this.reserveTurn(session), true);
    for (const session of this.sessions.values()) {
      if (session.turns.some(turn => turn.userInputRequests?.some(request => request.status === 'queued')) && !this.active.has(session.id)) {
        void this.startQueuedUserInput(session.id).catch(error => console.error('Queued user answer recovery failed:', error instanceof Error ? error.message : 'unknown error'));
      }
    }
    this.lifecycle?.start();
  }

  private canRecover(session: Session, turn: Turn): boolean {
    if (!this.sandbox || session.settings.executionMode !== 'sandbox' || !session.sandbox) return false;
    if (!turn.execution) return turn.status === 'running' && turn.codexAccepted === true
      && Boolean(session.threadId && turn.nativeTurnId);
    return turn.execution.kind === 'sandbox-worker' && turn.execution.protocolVersion === 1 && turn.execution.state !== 'terminal'
      && (!turn.execution.sandboxId || turn.execution.sandboxId === session.sandbox.id);
  }

  private reserveTurn(session: Session): ActiveExecution {
    const releaseProject = this.projects.startSession(session.projectId, session.id);
    let resolveDone!: () => void;
    const execution: ActiveExecution = {
      controller: new AbortController(), done: new Promise<void>(resolve => { resolveDone = resolve; }),
      finish: () => {
        if (this.active.get(session.id) === execution) this.active.delete(session.id);
        releaseProject();
        resolveDone();
      },
    };
    this.active.set(session.id, execution);
    return execution;
  }

  private executeTurn(session: Session, turn: Turn, execution: ActiveExecution, recovering = false) {
    const id = session.id;
    execution.turnId = turn.id;
    const approvals = new ApprovalRequests(turn, execution.controller.signal, async () => {
      session.updatedAt = new Date().toISOString();
      await this.save(session);
      this.publish(id, { type: 'state', session: this.get(id) });
    });
    execution.approvals = approvals;
    const running = runTurn(session, turn, execution.controller, {
      client: this.client, sandbox: this.sandbox, logger: this.logger, recovering,
      save: () => this.save(session), publish: message => this.publish(id, message), snapshot: () => this.get(id),
      updateSandbox: sandbox => this.updateSandbox(session.projectId, id, sandbox),
      requestApproval: approvals.request, closeApprovals: () => approvals.close(), detachApprovals: () => approvals.detach(),
    }).finally(async () => {
      if (session.settings.executionMode === 'sandbox' && session.status !== 'running'
        && !(session.turnCount ?? 0) && !session.turns.some(candidate => candidate.codexAccepted)) {
        try {
          await this.writer.wait(id);
          await this.state.deleteSession(id);
        } catch (error) {
          console.error('Unaccepted session cleanup failed:', error instanceof Error ? error.message : 'unknown error');
        }
      }
      execution.finish();
      void this.startQueuedUserInput(id).catch(error => console.error('Queued user answer failed:', error instanceof Error ? error.message : 'unknown error'));
      if (this.notifications && turn.status !== 'running') {
        const type = turn.status === 'completed' ? 'turn_completed'
          : turn.status === 'cancelled' ? 'turn_cancelled' : 'turn_failed';
        const label = type === 'turn_completed' ? '执行完成' : type === 'turn_cancelled' ? '已停止' : '执行失败';
        const projectName = session.projectId ? this.projects.get(session.projectId)?.name : undefined;
        this.notifications.add({
          type, title: `【${projectName ?? '无项目'}】${label}: ${session.title}`,
          body: turn.prompt.slice(0, 100),
          sessionId: session.id, sessionTitle: session.title, projectName, turnId: turn.id,
        });
      }
    });
    void running.catch(error => console.error('Session persistence failed:', error instanceof Error ? error.message : 'unknown error'));
  }

  list(): SessionSummary[] {
    return [...this.sessions.values()].map(session => this.hydrate(session)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map(({ turns, ...session }) => structuredClone({ ...session, turnCount: session.settings.executionMode === 'sandbox'
        ? Math.max(session.turnCount ?? 0, turns.filter(turn => turn.codexAccepted).length) : turns.length }));
  }

  get(id: string): Session {
    const session = this.lookup(id);
    const turns = session.settings.executionMode === 'sandbox' ? session.turns.slice(-1) : session.turns;
    return structuredClone({ ...session, turns, historyError: this.historyErrors.get(id) });
  }
  async read(id: string): Promise<Session> {
    const session = this.lookup(id);
    if (session.settings.executionMode === 'sandbox') {
      const snapshot = this.get(id);
      if (!session.threadId) {
        this.historyErrors.delete(id);
        return { ...snapshot, turns: session.turns.filter(turn => turn.status === 'running'), historyNextCursor: null,
          historyError: undefined };
      }
      if (session.projectId && (this.projects.isMaintaining(session.projectId) || !this.projects.get(session.projectId).sandbox)) {
        const historyError = '项目 Sandbox 尚未恢复，暂时无法加载历史消息。';
        this.historyErrors.set(id, historyError);
        return { ...snapshot, turns: session.turns.filter(turn => turn.status === 'running'), historyNextCursor: null,
          historyError };
      }
      try {
        const page = await this.readSandboxHistory(session, { limit: 20 });
        this.historyErrors.delete(id);
        const live = session.turns.filter(turn => turn.status === 'running');
        const turns = page.turns.map(native => {
          const current = live.find(turn => turn.nativeTurnId === native.id || turn.id === native.id);
          return current ? { ...native, ...current, nativeTurnId: native.id,
            prompt: current.prompt || native.prompt, items: current.items.length ? current.items : native.items } : native;
        });
        for (const turn of live) if (!turns.some(candidate => candidate.id === turn.id)) turns.push(turn);
        turns.sort((left, right) => left.startedAt.localeCompare(right.startedAt));
        return { ...snapshot, turns, historyNextCursor: page.nextCursor ?? null, historyError: undefined };
      } catch (error) {
        console.error('Native history read failed:', error instanceof Error ? error.message : 'unknown error');
        const historyError = '历史消息暂时无法从 Sandbox 加载，请确认项目 Sandbox 可用后刷新重试。';
        this.historyErrors.set(id, historyError);
        return { ...snapshot, turns: session.turns.filter(turn => turn.status === 'running'), historyNextCursor: null, historyError };
      }
    }
    await this.refreshNativeHistory(id);
    return this.get(id);
  }

  async olderTurns(id: string, cursor: string): Promise<SessionTurnPage> {
    const session = this.lookup(id);
    if (session.settings.executionMode !== 'sandbox' || !session.threadId) throw new HttpError(400, '此会话没有可分页的 Sandbox 历史');
    if (session.projectId && this.projects.isMaintaining(session.projectId)) throw new HttpError(409, '项目正在维护，请稍后重试');
    const page = await this.readSandboxHistory(session, { cursor, limit: 20 });
    return { turns: page.turns.sort((left, right) => left.startedAt.localeCompare(right.startedAt)), nextCursor: page.nextCursor ?? null };
  }

  async subagents(id: string): Promise<SubagentConversation[]> {
    const session = this.lookup(id);
    if (!session.threadId) return [];
    if (session.settings.executionMode === 'sandbox') {
      if (!session.sandbox || (session.projectId && this.projects.isMaintaining(session.projectId))) return [];
      if (!this.sandbox?.subagents) return [];
      const release = this.projects.acquire(session.projectId);
      try { return await this.sandbox.subagents(session); }
      finally { release(); }
    }
    return readSubagentConversations(session.threadId, process.env.CODEX_HOME || join(homedir(), '.codex'));
  }

  private refreshNativeHistory(id: string): Promise<void> {
    const session = this.sessions.get(id);
    const projectId = session?.projectId;
    if (projectId && this.projects.isMaintaining(projectId)) return Promise.resolve();
    if (session?.settings.executionMode === 'sandbox' && projectId && !this.projects.get(projectId).sandbox) {
      if (session.threadId) this.historyErrors.set(id, '项目 Sandbox 尚未恢复，暂时无法补全历史消息。当前显示已保存的内容。');
      return Promise.resolve();
    }
    let pending = this.historyReads.get(id);
    if (!pending) {
      pending = this.loadNativeHistory(id)
        .then(() => {
          this.historyErrors.delete(id);
          if (this.sessions.has(id) && !this.deleting.has(id)) this.publish(id, { type: 'state', session: this.get(id) });
        })
        .catch(error => {
          // Local Codex history can be retried on a later page visit.
          console.error('Native history refresh failed:', error instanceof Error ? error.message : 'unknown error');
          if (this.sessions.has(id) && !this.deleting.has(id)) {
            this.historyErrors.set(id, session?.settings.executionMode === 'sandbox'
              ? '历史消息暂时无法加载，当前显示已保存的内容。请确认项目 Sandbox 可用后刷新重试。'
              : '历史消息暂时无法加载，当前显示已保存的内容。请稍后刷新重试。');
            this.publish(id, { type: 'state', session: this.get(id) });
          }
        })
        .finally(() => { this.historyReads.delete(id); });
      this.historyReads.set(id, pending);
    }
    return pending;
  }

  async billing(id: string): Promise<SessionCostBreakdown> {
    const pending = this.billingReads.get(id);
    if (pending) return pending;
    const operation = this.calculateBilling(id).finally(() => { this.billingReads.delete(id); });
    this.billingReads.set(id, operation);
    return operation;
  }

  /**
   * 使用简化的预估计费模型计算会话费用。
   * 不依赖 provider 报告的真实 token 数，基于文本 token 估算。
   * 假设始终使用提示缓存，历史上下文按缓存费率计费。
   */
  private async calculateBilling(id: string): Promise<SessionCostBreakdown> {
    const session = this.get(id);
    let turns = session.turns;
    if (session.settings.executionMode === 'sandbox' && session.threadId) {
      turns = [];
      let cursor: string | null = null;
      do {
        const page = await this.readSandboxHistory(session, { ...(cursor ? { cursor } : {}), limit: 50 });
        turns.push(...page.turns);
        cursor = page.nextCursor ?? null;
      } while (cursor);
      turns.sort((left, right) => left.startedAt.localeCompare(right.startedAt));
    }
    const model = session.settings.model;
    const rates = MODEL_TOKEN_RATES[model];
    if (!rates || !turns.length) {
      return { turns: [], totalCost: 0, totalHistoryCost: 0, totalNewInputCost: 0,
        totalOutputCost: 0, model, totalTokens: 0 };
    }
    return estimateSessionCosts(turns, model, rates);
  }

  private async readSandboxHistory(session: Session, options: { cursor?: string; limit?: number } = {}) {
    const release = this.projects.acquire(session.projectId);
    try { return await this.sandbox!.history(session, options); }
    finally { release(); }
  }

  private async loadNativeHistory(id: string) {
    const session = this.lookup(id);
    const native = !session.threadId ? { turns: [] }
      : await readNativeHistory(session.threadId, undefined, false, session.startedAt, session.nativeHistoryPath);
    if (native.path && native.path !== session.nativeHistoryPath) session.nativeHistoryPath = native.path;
    const previous = session.turns;
    // A partial or empty rollout response must never erase the durable UI
    // snapshot. This can happen while Codex is compacting or Sandbox interrupts
    // inspection after the reader has opened the file.
    if (!native.turns.length && previous.length) {
      await this.save(session);
      return;
    }
    const liveId = this.active.get(id)?.turnId;
    // A failed native turn is historical execution state, not a chat message.
    // The browser separately shows a submission failure from its current page
    // when it cannot connect before Codex accepts the turn.
    // App Server's thread/turns/list currently returns most-recent first,
    // while the durable UI transcript is chronological. Keep this boundary
    // explicit so a native-history refresh cannot reverse the conversation.
    const mapped = native.turns.map(turn => {
      const stored = previous.find(old => old.id === turn.id || old.nativeTurnId === turn.id || (Date.parse(turn.startedAt) >= Date.parse(old.startedAt)
        && Date.parse(turn.startedAt) <= Date.parse(old.completedAt ?? new Date().toISOString())));
      if (!stored) return turn;
      // Do not let a stale/incomplete remote history resurrect a turn that
      // Web has already durably finalized (for example after manual recovery
      // of an orphaned execution).
      if (stored.status !== 'running' && turn.status === 'running') {
        return { ...stored, nativeTurnId: turn.id };
      }
      if (stored.id === liveId) { stored.nativeTurnId = turn.id; if (!stored.prompt) stored.prompt = turn.prompt; return stored; }
      // `thread/turns/list` can omit items that were emitted just before an
      // interrupted turn terminated. Keep those already-persisted stream
      // items until the native history contains a newer item with the same ID.
      // Otherwise the post-stop history refresh makes the conversation appear
      // to lose the Agent's visible output.
      const storedOnlyItems = stored.items.filter(item => !turn.items.some(native => native.id === item.id));
      return { ...turn, id: stored.id, nativeTurnId: turn.id, sdkUsage: stored.sdkUsage,
        userInputRequests: stored.userInputRequests,
        prompt: turn.prompt || stored.prompt,
        images: turn.images.length ? turn.images : stored.images,
        items: [...turn.items, ...storedOnlyItems],
        itemTimestamps: { ...stored.itemTimestamps, ...turn.itemTimestamps },
        contextUsage: turn.contextUsage?.map(call => {
          const old = stored.contextUsage?.find(value => call.responseId && value.responseId === call.responseId);
          return old ? { ...old, ...call } : call;
        }) };
    }).sort((left, right) => left.startedAt.localeCompare(right.startedAt));
    const live = previous.find(turn => turn.id === liveId);
    // Restored backups can contain only a prefix of the native conversation.
    // Keep every saved turn absent from that snapshot, including its metadata.
    for (const stored of previous) {
      if (!mapped.some(turn => turn.id === stored.id)) mapped.push(stored);
    }
    mapped.sort((left, right) => left.startedAt.localeCompare(right.startedAt));
    // Failed native turns are deliberately not rendered as chat messages.
    // Do not let that presentation filter turn a non-empty native response
    // into an empty replacement for the durable transcript.
    if (!mapped.length && previous.length) {
      await this.save(session);
      return;
    }
    session.turns = mapped;
    session.status = live ? live.status : mapped.at(-1)?.status ?? 'idle';
    session.contextUsage = mapped.flatMap(turn => turn.contextUsage ?? []).at(-1);
    await this.save(session);
  }
  private lookup(id: string): Session {
    if (this.deleting.has(id)) throw new HttpError(409, '会话正在删除');
    const session = this.sessions.get(id);
    if (!session) throw new HttpError(404, '会话不存在');
    if (session.projectId) this.projects.get(session.projectId);
    return this.hydrate(session);
  }

  private hydrate(session: Session): Session {
    if (session.projectId) session.sandbox = structuredClone(this.projects.find(session.projectId)?.sandbox);
    return session;
  }

  listProjects(): ProjectSummary[] {
    return [...this.projects.list()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(project => this.projectSummary(project));
  }

  async listProjectsWithArchives(): Promise<ProjectSummary[]> {
    // Refresh provider observations without waking containers. Maintenance owns
    // the binding while backup/restore/archive is in progress.
    const candidates = this.projects.list().filter(project => project.sandbox && project.executionMode === 'sandbox'
      && !this.projects.isMaintaining(project.id) && !this.projects.activeSessionId(project.id));
    for (let offset = 0; offset < candidates.length; offset += 4) {
      await Promise.all(candidates.slice(offset, offset + 4).map(async project => {
        if (!this.sandbox?.inspect || this.projects.isMaintaining(project.id)) return;
        const release = this.projects.acquire(project.id);
        try {
          await this.sandbox.inspect(this.projectWorkspace(project));
          const current = this.projects.get(project.id);
          if (current.sandbox?.status === 'ready' && this.sandbox.verifySandbox
            && [...this.sessions.values()].some(session => session.projectId === project.id && this.historyErrors.has(session.id))) {
            await this.sandbox.verifySandbox(current.sandbox, 5_000);
          }
        } catch {
          const current = this.projects.find(project.id);
          if (current?.sandbox) await this.updateSandbox(project.id, project.id, { ...current.sandbox, status: 'unavailable' });
        } finally { release(); }
      }));
    }
    const summaries = this.listProjects();
    const archiveMgr = this._archiveManager;
    if (!archiveMgr) return summaries;
    return Promise.all(summaries.map(async s => {
      if (!s.archiveKey) return s;
      try {
        const v = await archiveMgr.getLatest(s.archiveKey);
        const latestDetails = v ? archiveMgr.describe(v) : undefined;
        s.latestBackup = latestDetails ? { createdAt: latestDetails.createdAt,
          sizeBytes: latestDetails.sizeBytes, bytesAdded: latestDetails.bytesAdded } : undefined;
        delete s.sandboxDataArchive;
        s.archiveVersions = (await archiveMgr.listVersions(s.archiveKey)).map(version => archiveMgr.describe(version));
      } catch { /* skip enrichment failure */ }
      return s;
    }));
  }

  private projectSummary(project: Project): ProjectSummary {
    return structuredClone({ ...project, status: project.status ?? (project.archivedAt ? 'archived' : 'active'), archivedAt: project.archivedAt ?? null, sessionCount: [...this.sessions.values()].filter(session => session.projectId === project.id).length,
      latestBackup: project.latestBackup ?? (project.sandboxDataArchive ? { createdAt: project.sandboxDataArchive.createdAt,
        sizeBytes: project.sandboxDataArchive.sizeBytes } : undefined),
      activeSessionId: this.projects.activeSessionId(project.id) });
  }

  getProject(id: string): ProjectSummary { return this.projectSummary(this.projects.get(id)); }

  async createProject(input: ProjectInput, settings?: Settings): Promise<ProjectSummary> {
    if (this.closing) throw new HttpError(503, '服务正在关闭');
    const valid = await this.validateSettings(settings ?? { ...this.defaults, executionMode: 'sandbox', workingDirectory: this.defaults.executionMode === 'sandbox' ? this.defaults.workingDirectory : this.sandboxWorkingDirectory });
    const project = await this.projects.create(input, valid);
    return this.projectSummary(project);
  }

  async updateProject(id: string, input: ProjectUpdate): Promise<ProjectSummary> {
    return this.projectSummary(await this.projects.update(id, input));
  }

  async rebuildProjectSandbox(id: string): Promise<ProjectSummary> {
    await this.runProjectSandboxOperation(id, 'restore');
    return this.getProject(id);
  }

  async backupProjectNow(id: string): Promise<ProjectSummary> {
    await this.runProjectSandboxOperation(id, 'backup');
    return this.getProject(id);
  }

  async migrateProjectSandbox(id: string): Promise<ProjectSummary> {
    await this.runProjectSandboxOperation(id, 'migrate');
    return this.getProject(id);
  }

  async switchProjectSandboxVersion(id: string, targetImageId: string): Promise<ProjectSummary> {
    await this.runProjectSandboxOperation(id, 'switch', { targetImageId });
    return this.getProject(id);
  }

  async refreshProjectSandboxRuntime(id: string): Promise<ProjectSummary> {
    await this.runProjectSandboxOperation(id, 'refresh');
    return this.getProject(id);
  }

  async archiveProjectNow(id: string, options: { useExistingBackup?: boolean } = {}): Promise<ProjectSummary> {
    await this.runProjectSandboxOperation(id, 'archive', options);
    return this.getProject(id);
  }

  private async runProjectSandboxOperation(id: string, kind: 'backup' | 'restore' | 'archive' | 'migrate' | 'switch' | 'refresh',
    options: { useExistingBackup?: boolean; targetImageId?: string } = {}) {
    if (this.closing) throw new HttpError(503, '服务正在关闭');
    if (!this.sandboxOperations) throw new HttpError(503, 'Sandbox 未配置');
    await this.sandboxOperations.run(id, kind, options);
  }

  async scheduledArchiveForProject(id: string) {
    const project = this.projects.get(id);
    if (!project.sandbox || project.status === 'archived' || project.sandbox.status !== 'ready') return;
    await this.backupProjectNow(id);
  }

  private lastScheduledArchive = new Map<string, number>();
  private readonly scheduledArchiveInterval =
    Number(process.env.SANDBOX_SCHEDULED_ARCHIVE_THRESHOLD_MS ?? 30 * 60 * 1000);

  async scheduledArchive() {
    if (this.closing) return;
    const now = Date.now();
    for (const project of this.projects.list()) {
      if (project.pendingSandboxCleanup?.length) await this.sandboxOperations?.retryCleanup(project.id).catch(() => {});
      if (!project.sandbox || project.status === 'archived') continue;
      const last = this.lastScheduledArchive.get(project.id) ?? 0;
      if (now - last >= this.scheduledArchiveInterval) {
        this.lastScheduledArchive.set(project.id, now);
        await this.scheduledArchiveForProject(project.id).catch(() => {});
      }
    }
  }

  /** 对所有已归档项目清理旧归档（新方案走 ArchiveManager，旧方案走 state） */
  async pruneArchivedProjectArchives(): Promise<number> {
    if (this._archiveManager) {
      let retired = 0;
      for (const project of this.projects.list().filter(p => p.status === 'archived' && p.archiveKey)) {
        retired += await this._archiveManager.retain(project.archiveKey!, project.backupRetentionCount ?? 2);
      }
      await this._archiveManager.sweepManagedVersions();
      await this._archiveManager.sweep();
      return retired;
    }
    const archivesDir = join(this.dataDirectory, '..', 'sandbox-data-archives');
    const archivedProjects = this.projects.list().filter(p => p.status === 'archived');
    let totalDeleted = 0;
    for (const project of archivedProjects) {
      const archives = await this.state.listProjectArchives(project.id);
      if (archives.length <= 1) continue;
      const toDelete = archives.slice(1);
      for (const archive of toDelete) {
        try {
          await this.state.deleteArchiveRecord(archive.key);
          await rm(join(archivesDir, archive.key), { force: true });
          totalDeleted++;
        } catch { /* 跳过单个失败 */ }
      }
    }
    return totalDeleted;
  }

  private isSandboxReferenced(sandboxId: string): boolean {
    return this.projects.list().some(project => project.sandbox?.id === sandboxId
      || (this.projects.isMaintaining(project.id) && project.pendingSandboxCleanup?.some(sandbox => sandbox.id === sandboxId)))
      || [...this.sessions.values()].some(session =>
        (!session.projectId && session.sandbox?.id === sandboxId)
        || session.turns.some(turn => turn.execution?.sandboxId === sandboxId && turn.execution.state !== 'terminal'));
  }

  async sweepSandboxLifecycle() {
    await this.lifecycle?.sweep();
  }

  private async ensureProjectSandbox(id: string): Promise<void> {
    const project = this.projects.get(id);
    if (this.projects.isMaintaining(id)) throw new HttpError(409, '项目环境正在维护，请稍后重试');
    if (project.status === 'archived') {
      throw new HttpError(409, '项目已归档，请先点击“恢复项目”');
    }
    if (!project.sandbox && (project.archiveKey || project.sandboxDataArchive)) {
      throw new HttpError(409, '项目环境尚未恢复，请先点击“恢复环境”；不会创建空环境');
    }
  }

  async deleteDanglingSandbox(sandboxId: string): Promise<void> {
    if (this.closing) throw new HttpError(503, '服务正在关闭');
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(sandboxId)) throw new HttpError(400, '沙箱 ID 无效');
    if (!this.sandbox?.deleteDanglingSandbox) throw new HttpError(503, 'Sandbox 未配置');
    if (this.danglingDeletions.has(sandboxId)) throw new HttpError(409, '此沙箱正在删除');
    if (this.isSandboxReferenced(sandboxId)) {
      throw new HttpError(409, '该沙箱仍被项目、会话或复原操作使用，不能删除');
    }
    // New bindings only use freshly created IDs. With no await before this
    // reservation, a detached old environment cannot become a restore target.
    const operation = this.sandbox.deleteDanglingSandbox(sandboxId);
    this.danglingDeletions.set(sandboxId, operation);
    try { await operation; }
    finally { this.danglingDeletions.delete(sandboxId); }
  }

  async deleteProject(id: string) {
    await this.projects.delete(id, async project => {
      const sessions = [...this.sessions.values()].filter(session => session.projectId === id);
      for (const session of sessions) await Promise.allSettled([...(this.uploads.get(session.id) ?? [])]);
      if (project.executionMode === 'sandbox' && project.sandbox) {
        if (!this.sandbox) throw new HttpError(503, 'Sandbox 未配置，无法删除项目沙箱；项目记录已保留');
        await this.sandbox.delete(this.projectWorkspace(project));
      }
      for (const pending of project.pendingSandboxCleanup ?? []) {
        if (pending.id === project.sandbox?.id) continue;
        if (!this.sandbox?.deleteDanglingSandbox) throw new HttpError(503, '仍有环境待清理，项目记录已保留');
        await this.sandbox.deleteDanglingSandbox(pending.id);
      }
      for (const session of sessions) await this.removeSession(session.id);
    });
  }

  private async removeSession(id: string) {
    await this.writer.wait(id);
    await this.state.deleteSession(id);
    await Promise.all([...new Set([join(this.imagesDirectory, id), join(this.dataDirectory, 'images', id)])]
      .map(directory => rm(directory, { recursive: true, force: true })));
    this.sessions.delete(id);
    this.historyErrors.delete(id);
    this.subscribers.delete(id);
    this.writer.forget(id);
  }

  private async updateSandbox(projectId: string | undefined, sessionId: string, sandbox: NonNullable<Session['sandbox']>, restoreProject = false) {
    if (projectId) {
      const replacing = this.projects.find(projectId)?.sandbox?.id !== sandbox.id;
      if (!await this.projects.updateSandbox(projectId, sandbox, restoreProject)) return;
      for (const sibling of this.sessions.values()) {
        if (sibling.projectId !== projectId || this.deleting.has(sibling.id)) continue;
        sibling.sandbox = structuredClone(sandbox);
        try { await this.save(sibling); }
        catch (error) {
          if (!replacing) throw error;
          // The authoritative project cutover is already durable. Hydration and
          // startup repair session snapshots; don't roll the runtime binding back.
          console.error('Session sandbox snapshot save failed after upgrade:', sibling.id);
        }
        if (!this.projects.isDeleting(projectId) && !this.deleting.has(sibling.id)) this.publish(sibling.id, { type: 'state', session: this.get(sibling.id) });
      }
    } else {
      const session = this.sessions.get(sessionId);
      if (!session || this.deleting.has(sessionId)) return;
      session.sandbox = sandbox;
      await this.save(session);
      this.publish(sessionId, { type: 'state', session: this.get(sessionId) });
    }
  }

  private async validateSettings(settings: Settings): Promise<Settings> {
    if (settings.executionMode === 'sandbox') {
      if (!this.sandbox) throw new HttpError(400, 'Sandbox 尚未配置，请检查服务端连接设置');
      if (!posix.isAbsolute(settings.workingDirectory) || settings.workingDirectory.includes('\0')) throw new HttpError(400, 'Sandbox 工作目录必须是沙箱内的绝对路径');
      const directory = posix.normalize(settings.workingDirectory);
      if (!directory.startsWith('/home/user/') || /^\/home\/user\/\.codex(?:-web)?(?:\/|$)/.test(directory)) throw new HttpError(400, 'Sandbox 工作目录须位于 /home/user 下，且不能使用 Codex 内部目录');
      return normalizeExecutionSettings({ ...settings, workingDirectory: directory });
    }
    let directory: string;
    try {
      directory = await realpath(resolve(settings.workingDirectory));
      if (!(await stat(directory)).isDirectory()) throw new Error('not a directory');
    } catch { throw new HttpError(400, '工作目录不存在或无法访问'); }
    return { ...settings, workingDirectory: directory };
  }

  async create(input: { projectId?: string; settings?: Partial<Settings>; threadId?: string; title?: string } = {}): Promise<Session> {
    if (this.closing) throw new HttpError(503, '服务正在关闭');
    let project = input.projectId ? this.projects.get(input.projectId) : undefined;
    let release = this.projects.acquire(project?.id);
    try {
      if (project && ((input.settings?.executionMode && input.settings.executionMode !== project.executionMode)
        || (input.settings?.workingDirectory && posix.normalize(input.settings.workingDirectory) !== project.workingDirectory))) throw new HttpError(400, '会话必须使用项目的执行环境和工作目录');
      const executionMode = project?.executionMode ?? input.settings?.executionMode ?? this.defaults.executionMode;
      if (input.threadId && executionMode === 'sandbox') throw new HttpError(400, 'Sandbox 项目不能导入本机 thread，请在已有 Sandbox 会话中继续');
      const settings = await this.validateSettings({ ...this.defaults,
        ...(executionMode !== this.defaults.executionMode ? { networkAccessEnabled: executionMode === 'sandbox' } : {}), ...input.settings,
        ...(project ? { executionMode: project.executionMode, workingDirectory: project.workingDirectory } : {}), });
      if (!project && settings.executionMode === 'sandbox') {
        project = await this.createProject({ name: input.title ?? '新项目' }, settings);
        release = this.projects.acquire(project.id);
      }
      const now = new Date().toISOString();
      const session: Session = { id: randomUUID(), ...(project ? { projectId: project.id, ...(project.sandbox ? { sandbox: structuredClone(project.sandbox) } : {}) } : {}), threadId: input.threadId ?? null, title: input.title ?? '新任务', settings, status: 'idle', startedAt: now, archivedAt: null, createdAt: now, updatedAt: now, turns: [] };
      await this.save(session);
      this.sessions.set(session.id, session);
      return this.get(session.id);
    } finally { release(); }
  }

  async update(id: string, input: { title?: string; settings?: Partial<Settings>; archived?: boolean }): Promise<Session> {
    const session = this.lookup(id);
    if (this.active.has(id)) throw new HttpError(409, '请先停止当前任务再修改会话');
    if (input.archived && (session.status === 'running' || session.turns.some(turn => turn.status === 'running'))) {
      throw new HttpError(409, '请先停止当前任务再归档会话');
    }
    if (input.settings?.executionMode && input.settings.executionMode !== (session.settings.executionMode || 'local')) throw new HttpError(400, '已有会话不能切换执行环境，请新建任务');
    if (session.projectId && input.settings?.workingDirectory && posix.normalize(input.settings.workingDirectory) !== session.settings.workingDirectory) throw new HttpError(400, '项目会话不能修改工作目录');
    const settings = input.settings ? await this.validateSettings({ ...session.settings, ...input.settings }) : normalizeExecutionSettings(session.settings);
    this.lookup(id);
    // Re-check after filesystem validation so a concurrent turn cannot change settings mid-run.
    if (this.active.has(id)) throw new HttpError(409, '任务正在执行');
    session.settings = settings;
    if (input.title !== undefined) session.title = input.title;
    if (input.archived !== undefined) session.archivedAt = input.archived ? session.archivedAt ?? new Date().toISOString() : null;
    session.updatedAt = new Date().toISOString();
    await this.save(session);
    this.publish(id, { type: 'state', session: this.get(id) });
    return this.get(id);
  }

  async delete(id: string) {
    const session = this.lookup(id);
    if (this.active.has(id)) throw new HttpError(409, '请先停止当前任务');
    const release = this.projects.acquire(session.projectId);
    this.deleting.add(id);
    try {
      await Promise.allSettled([...(this.uploads.get(id) ?? [])]);
      await this.writer.wait(id);
      if (!session.projectId && session.settings.executionMode === 'sandbox' && session.sandbox) {
        if (!this.sandbox) throw new HttpError(503, 'Sandbox 未配置，无法删除沙箱；会话记录已保留');
        await this.sandbox.delete(session);
      }
      await this.removeSession(id);
    } finally { this.deleting.delete(id); release(); }
  }

  subscribe(id: string, callback: Subscriber): () => void {
    this.lookup(id);
    const subscribers = this.subscribers.get(id) ?? new Set<Subscriber>();
    this.subscribers.set(id, subscribers);
    subscribers.add(callback);
    callback({ type: 'snapshot', session: this.get(id) });
    return () => {
      subscribers.delete(callback);
      if (!subscribers.size) this.subscribers.delete(id);
    };
  }

  private publish(id: string, message: StreamMessage) {
    for (const callback of this.subscribers.get(id) ?? []) {
      try { callback(structuredClone(message)); } catch { /* A disconnected viewer must not interrupt the agent. */ }
    }
  }

  private save(session: Session): Promise<void> {
    // Keep the visible transcript available independently of Sandbox. Native
    // history can enrich it later, but an unavailable or archived Sandbox must
    // not make completed messages disappear after a Web restart.
    const turns = session.turns.map(turn => ({
      id: turn.id, nativeTurnId: turn.nativeTurnId, startedAt: turn.startedAt, completedAt: turn.completedAt, status: turn.status,
      execution: turn.execution, codexAccepted: turn.codexAccepted, error: turn.error,
      approvals: turn.status === 'running' || (turn.execution && turn.execution.state !== 'terminal') ? turn.approvals : undefined,
      userInputRequests: turn.userInputRequests,
      prompt: turn.prompt,
      images: turn.images,
      items: turn.items,
      itemTimestamps: turn.itemTimestamps,
      usage: turn.usage, sdkUsage: turn.sdkUsage,
      contextUsage: turn.contextUsage?.map(({ blockEstimates, blockTokenizer, blockTexts, ...call }) => call),
    }));
    const contextUsage = session.contextUsage && (() => {
      const { blockEstimates, blockTokenizer, blockTexts, ...value } = session.contextUsage;
      return value;
    })();
    return this.writer.run(session.id, () => this.state.saveSession({ ...session, contextUsage: contextUsage || undefined, turns }));
  }

  async uploadImage(id: string, content: Uint8Array, extension: string): Promise<string> {
    this.lookup(id);
    const uploads = this.uploads.get(id) ?? new Set<Promise<string>>();
    this.uploads.set(id, uploads);
    const operation = (async () => {
      const directory = resolve(this.imagesDirectory, id);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const path = join(directory, `${randomUUID()}.${extension}`);
      await writeFile(path, content, { mode: 0o600 });
      return path;
    })();
    uploads.add(operation);
    try { return await operation; } finally {
      uploads.delete(operation);
      if (!uploads.size) this.uploads.delete(id);
    }
  }

  async startTurn(id: string, prompt: string, images: string[] = []): Promise<string> {
    if (this.closing) throw new HttpError(503, '服务正在关闭');
    let session = this.lookup(id);
    if (session.projectId && this.projects.get(session.projectId).status !== 'active') {
      throw new HttpError(409, this.projects.get(session.projectId).status === 'completed'
        ? '项目已完成，请先恢复为使用中再继续对话' : '项目已归档，请先恢复项目后再继续对话');
    }
    if (session.projectId && !this.projects.get(session.projectId).sandbox) {
      await this.ensureProjectSandbox(session.projectId);
      if (this.closing) throw new HttpError(503, '服务正在关闭');
      session = this.lookup(id);
    }
    if (session.archivedAt) throw new HttpError(409, '会话已归档，请先恢复后再发送消息');
    if (this.active.has(id) || session.turns.some(turn => turn.status === 'running')) throw new HttpError(409, '当前会话已有任务正在执行');
    const previous = structuredClone(session);
    // Reserve the session synchronously, before validating attachments or saving state.
    const execution = this.reserveTurn(session);
    try {
      session.settings = normalizeExecutionSettings(session.settings);
      // Older uploads may still be queued in a browser when storage is moved.
      const imageRoots = [resolve(this.imagesDirectory, id) + sep, resolve(this.dataDirectory, 'images', id) + sep];
      for (const image of images) {
        let path: string;
        try { path = await realpath(image); } catch { throw new HttpError(400, '图片附件不存在，请重新上传'); }
        if (!imageRoots.some(root => path.startsWith(root))) throw new HttpError(400, '只能使用此会话上传的图片');
      }
      const turn: Turn = { id: randomUUID(), prompt, images, codexAccepted: false, status: 'running', phase: 'starting', items: [], itemTimestamps: {}, startedAt: new Date().toISOString() };
      // The Sandbox owns a long-lived App Server. Web holds the live RPC
      // connection, so there is no per-turn worker process to persist.
      execution.turnId = turn.id;
      session.turns.push(turn);
      session.status = 'running';
      session.updatedAt = turn.startedAt;
      if (session.title === '新任务') session.title = prompt.slice(0, 60);
      await this.save(session);
      this.publish(id, { type: 'state', session: this.get(id) });
      this.executeTurn(session, turn, execution);
      return turn.id;
    } catch (error) {
      await execution.approvals?.close().catch(() => {});
      this.sessions.set(id, previous);
      execution.finish();
      this.publish(id, { type: 'state', session: this.get(id) });
      throw error;
    }
  }

  async resolveApproval(id: string, turnId: string, approvalId: string, input: unknown): Promise<Session> {
    const decision = approvalDecisionSchema.parse(input);
    const session = this.lookup(id);
    const turn = session.turns.find(item => item.id === turnId);
    const approval = turn?.approvals?.find(item => item.id === approvalId);
    if (!turn || !approval) throw new HttpError(404, '确认请求不存在');
    const execution = this.active.get(id);
    if (execution?.turnId === turnId && execution.approvals) {
      await execution.approvals.decide(approvalId, decision);
    } else if (approval.status !== decision.decision) {
      throw new HttpError(409, '本轮执行已结束，确认请求已失效');
    }
    return this.get(id);
  }

  async requestApproval(id: string, turnId: string, projectId: string | null, requestId: string, input: unknown, signal: AbortSignal) {
    const session = this.lookup(id);
    if ((session.projectId ?? null) !== projectId) throw new HttpError(403, '审批 capability 与项目不匹配');
    const execution = this.active.get(id);
    if (execution?.turnId !== turnId || !execution.approvals) throw new HttpError(409, '来源任务已结束，不能请求确认');
    const body = (input as { title?: string; target?: string }) ?? {};
    this.notifications?.add({
      type: 'approval_pending',
      title: `【${session.projectId ? this.projects.get(session.projectId)?.name ?? '' : '无项目'}】审批: ${body.title ?? requestId}`,
      body: (body.target ?? '').slice(0, 100),
      sessionId: session.id, sessionTitle: session.title, projectName: session.projectId ? this.projects.get(session.projectId)?.name : undefined, turnId,
    });
    return execution.approvals.request(requestId, input, signal);
  }

  async requestUserInput(id: string, turnId: string, projectId: string | null, requestId: string,
    questions: UserInputQuestion[]): Promise<UserInputRequest> {
    const session = this.lookup(id);
    if ((session.projectId ?? null) !== projectId) throw new HttpError(403, '提问来源项目不匹配');
    const turn = session.turns.find(item => item.id === turnId);
    if (!turn || this.active.get(id)?.turnId !== turnId || turn.status !== 'running') {
      throw new HttpError(409, '来源任务已结束，不能发送问题');
    }
    const existing = turn.userInputRequests?.find(item => item.id === requestId);
    if (existing) {
      if (JSON.stringify(existing.questions) !== JSON.stringify(questions)) throw new HttpError(409, '提问 ID 已用于其他内容');
      return structuredClone(existing);
    }
    if ((turn.userInputRequests?.length ?? 0) >= 20) throw new HttpError(409, '本轮提问过多');
    const question: UserInputRequest = { id: requestId, questions, status: 'pending', createdAt: new Date().toISOString() };
    (turn.userInputRequests ??= []).push(question);
    session.updatedAt = question.createdAt;
    await this.save(session);
    this.publish(id, { type: 'state', session: this.get(id) });
    return structuredClone(question);
  }

  async answerUserInput(id: string, turnId: string, requestId: string, answer: string): Promise<Session> {
    const session = this.lookup(id);
    const request = session.turns.find(turn => turn.id === turnId)?.userInputRequests?.find(item => item.id === requestId);
    if (!request) throw new HttpError(404, '问题不存在');
    if (request.status !== 'pending') throw new HttpError(409, '问题已经回答');
    request.status = 'queued';
    request.answer = answer;
    request.answeredAt = new Date().toISOString();
    session.updatedAt = request.answeredAt;
    await this.save(session);
    this.publish(id, { type: 'state', session: this.get(id) });
    if (!this.active.has(id)) await this.startQueuedUserInput(id);
    return this.get(id);
  }

  private async startQueuedUserInput(id: string): Promise<void> {
    if (this.active.has(id)) return;
    const session = this.lookup(id);
    for (const [index, source] of session.turns.entries()) {
      for (const request of source.userInputRequests ?? []) {
        if (request.status !== 'queued' || !request.answer) continue;
        const prompt = request.questions.length === 1 ? request.answer : `对之前问题的回答：\n${request.answer}`;
        // A crash after startTurn saved the new turn but before this receipt
        // was saved must not submit the same answer a second time.
        const existing = session.turns.slice(index + 1).find(turn => turn.prompt === prompt
          && Date.parse(turn.startedAt) >= Date.parse(request.answeredAt ?? request.createdAt));
        const answerTurnId = existing?.id ?? await this.startTurn(id, prompt);
        request.status = 'answered';
        request.answerTurnId = answerTurnId;
        session.updatedAt = new Date().toISOString();
        await this.save(session);
        this.publish(id, { type: 'state', session: this.get(id) });
        if (!existing) return;
      }
    }
  }

  /** Resolve Web session/turn context from a Codex App-Server thread ID. */
  findSessionByThreadId(threadId: string): { sessionId: string; turnId: string; projectId: string | null } | null {
    for (const session of this.sessions.values()) {
      if (session.threadId !== threadId) continue;
      const execution = this.active.get(session.id);
      if (!execution?.turnId) continue;
      return { sessionId: session.id, turnId: execution.turnId, projectId: session.projectId ?? null };
    }
    return null;
  }

  async stop(id: string) {
    const current = this.lookup(id);
    const execution = this.active.get(id);
    if (execution) {
      const turn = current.turns.find(turn => turn.id === execution.turnId);
      if (turn?.execution) {
        turn.execution.stopRequested = true;
        await this.save(current);
      }
      execution.controller.abort();
      await execution.done;
      return;
    }

    const pending = current.turns.slice().reverse().find(turn => this.canRecover(current, turn));
    if (pending?.execution) {
      const recovery = this.reserveTurn(current);
      recovery.turnId = pending.id;
      try {
        pending.execution.stopRequested = true;
        await this.save(current);
        recovery.controller.abort();
        this.executeTurn(current, pending, recovery, true);
        await recovery.done;
      } catch (error) { recovery.finish(); throw error; }
      return;
    }

    // A Web restart or an unexpected worker exit can leave a persisted
    // `running` turn without an in-memory execution to abort.  Refresh the
    // SDK/Sandbox history first; if no durable execution remains, converge this
    // orphaned turn to cancelled so the session can be used again.
    await this.read(id);
    if (this.active.has(id)) {
      const recovered = this.active.get(id)!;
      recovered.controller.abort();
      await recovered.done;
      return;
    }
    const session = this.sessions.get(id);
    const turn = session?.turns.slice().reverse().find(item => item.status === 'running');
    if (!session || !turn) return;
    turn.status = 'cancelled';
    turn.error = '本轮执行已结束，但 Web 未收到终止事件，已将残留状态标记为已停止。';
    turn.completedAt = new Date().toISOString();
    session.status = 'cancelled';
    session.updatedAt = turn.completedAt;
    await this.save(session);
    this.publish(id, { type: 'state', session: this.get(id) });
  }

  async waitForIdle(id: string) { await this.active.get(id)?.done; }

  private projectWorkspace(project: Project): WorkspaceTarget {
    return { id: project.id, projectId: project.id, settings: { workingDirectory: project.workingDirectory },
      sandbox: structuredClone(project.sandbox), updatedAt: project.updatedAt };
  }

  async preview(projectId: string, href: string) {
    if (this.closing) throw new HttpError(503, '服务正在关闭');
    let url: URL;
    try { url = new URL(href); } catch { throw new HttpError(400, '预览链接无效'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
      || !['localhost', '127.0.0.1', '0.0.0.0', '[::1]', '[::]'].includes(url.hostname.toLowerCase())) {
      throw new HttpError(400, '仅支持沙箱内 localhost 服务的 HTTP/HTTPS 链接');
    }
    const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new HttpError(400, '服务端口无效');
    await this.ensureProjectSandbox(projectId);
    const project = this.projects.get(projectId);
    if (project.executionMode !== 'sandbox' || !this.sandbox) throw new HttpError(400, '此项目不使用 Sandbox 沙箱');
    if (!project.sandbox) throw new HttpError(409, '项目沙箱尚未创建，请先启动服务');
    const release = this.projects.acquire(project.id);
    const owner = this.projectWorkspace(project);
    try {
      const origin = await this.sandbox.preview(owner, port);
      const target = new URL(origin);
      target.pathname = url.pathname; target.search = url.search; target.hash = url.hash;
      return target.href;
    } finally { release(); }
  }

  /** Returns the Docker container name for server-side proxy to sandbox services. */
  async sandboxProxyHost(projectId: string): Promise<string> {
    if (this.closing) throw new HttpError(503, '服务正在关闭');
    await this.ensureProjectSandbox(projectId);
    const project = this.projects.get(projectId);
    if (project.executionMode !== 'sandbox' || !this.sandbox) throw new HttpError(400, '此项目不使用 Sandbox 沙箱');
    if (!project.sandbox) throw new HttpError(409, '项目沙箱尚未创建，请先启动服务');
    const release = this.projects.acquire(project.id);
    try {
      return await this.sandbox.proxyHost(this.projectWorkspace(project));
    } finally { release(); }
  }

  async projectFile(projectId: string, path: string, options?: WorkspaceFileReadOptions) {
    if (this.closing) throw new HttpError(503, '服务正在关闭');
    await this.ensureProjectSandbox(projectId);
    const project = this.projects.get(projectId);
    if (project.executionMode !== 'sandbox' || !this.sandbox) throw new HttpError(400, '此项目不使用 Sandbox 沙箱');
    if (!project.sandbox) throw new HttpError(409, '项目沙箱尚未创建，请先发送一条消息');
    const release = this.projects.acquire(project.id);
    try { return await this.sandbox.file(this.projectWorkspace(project), path, options); }
    finally { release(); }
  }

  async close() {
    this.closing = true;
    await this.lifecycle?.close();
    await this.sandboxOperations?.close();
    await Promise.allSettled(this.danglingDeletions.values());
    const detachments: Promise<void>[] = [];
    for (const [id, execution] of this.active) {
      const session = this.sessions.get(id);
      const turn = session?.turns.find(turn => turn.id === execution.turnId);
      if (session?.settings.executionMode === 'sandbox' && turn && this.sandbox) {
        this.sandbox.detach(turn);
        if (execution.approvals) detachments.push(execution.approvals.detach());
      } else execution.controller.abort();
    }
    await Promise.allSettled(detachments);
    await Promise.allSettled([...this.active.values()].map(execution => execution.done));
    try {
      await this.sandbox?.close();
      await Promise.all([this.writer.drain(), this.projects.close()]);
      await this.state.close();
    } finally { await this.logger?.flush(); }
  }
}
