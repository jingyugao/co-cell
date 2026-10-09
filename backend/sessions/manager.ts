import { traced, traceEvent } from '@co-cell/sandbox';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { mkdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve, sep, posix } from 'node:path';
import { PROJECT_OPERATION_WAIT_MS, type ProjectReadOptions, type Project, type ProjectSummary, type Session, type SessionSummary, type SessionTurnPage, type Settings, type StreamMessage, type SubagentConversation, type Turn } from '../../protocol/types.js';
import type { SandboxRuntime } from '../execution/container-runtime.js';
import { SandboxLifecycleService } from '../projects/sandbox-lifecycle.js';
import { ProjectSandboxOperations } from '../projects/sandbox-operations.js';
import type { RuntimeLog } from '../infra/diagnostics/runtime-log.js';
import { pruneRemoteArchives } from '../archives/retention.js';

import { HttpError } from '../../util/errors.js';
import { holdResponse } from '../../util/http-stream.js';
import { ProjectService, type ProjectInput, type ProjectUpdate } from '../projects/service.js';
import { RecordWriteQueue } from '../infra/storage/record-write-queue.js';
import type { WebStateStore } from '../infra/storage/web-state.js';
import { runTurn, type CodexClient } from '../execution/runner.js';
import type { WorkspaceTarget } from '../sandboxes/types.js';
import { readNativeHistory, readSubagentConversations } from '../execution/native-history.mjs';
import type { NotificationStore } from '../notifications/store.js';
import { estimateSessionCosts, type SessionCostBreakdown } from '../../util/billing.js';
import { MODEL_TOKEN_RATES } from '../../util/model-costs.js';
import type { ImageCatalog } from '../images/service.js';
import type { ProjectImageSelection } from '../../protocol/image-types.js';
import { querySandbox } from '../sandboxes/status.js';
import { collectNativeUserInputAnswers, withNativeUserInput, type NativeUserInputAnswers } from '../../util/user-input.js';
import type { SharedCoordinator, SharedLease } from '../infra/storage/coordination.js';
import { applyTurnEvent } from '../../util/session-events.js';

export type { CodexClient } from '../execution/runner.js';
type Subscriber = (message: StreamMessage) => void;
type ActiveExecution = {
  controller: AbortController;
  done: Promise<void>;
  turnId?: string;
  steer?(text: string): Promise<boolean>;
  lease?: SharedLease;
  finish(): Promise<void>;
};
class NativeTurnAcceptancePending extends Error {}
type SubscriptionWatch = {
  timer: ReturnType<typeof setInterval>;
  pending?: Promise<void>;
  last?: string;
  completedKey?: string;
  observation?: { key: string; controller: AbortController; done: Promise<void> };
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
  autoCheckpointAfterMs?: number;
  scanIntervalMs?: number;
  now?: () => number;
}
export class SessionManager {
  private lifecycle?: SandboxLifecycleService;
  private notifications?: NotificationStore;
  private projects: ProjectService;
  private sandboxOperations?: ProjectSandboxOperations;
  private projectEntries = new Map<string, Promise<ProjectSummary>>();
  private imageCatalog?: ImageCatalog;
  private danglingDeletions = new Map<string, Promise<void>>();
  private sessions = new Map<string, Session>();
  private active = new Map<string, ActiveExecution>();
  private subscribers = new Map<string, Set<Subscriber>>();
  private writer = new RecordWriteQueue();
  private deleting = new Set<string>();
  private uploads = new Map<string, Set<Promise<string>>>();
  private closing = false;
  private historyReads = new Map<string, Promise<void>>();
  private userInputAnswers = new Map<string, { threadId: Session['threadId']; answers: NativeUserInputAnswers }>();
  private userInputDeliveries = new Map<string, Promise<void>>();
  private historyErrors = new Map<string, string>();
  private billingReads = new Map<string, Promise<SessionCostBreakdown>>();
  private savedSessions = new Map<string, Session>();
  private refreshing?: Promise<void>;
  private recoveryTimer?: ReturnType<typeof setInterval>;
  private reconciling?: Promise<void>;
  private projectLeases = new Map<string, SharedLease>();
  private autoCheckpointAfterMs: number;
  private mutations = new Map<string, number>();
  private subscriptionPolls = new Map<string, SubscriptionWatch>();

  constructor(
    private client: CodexClient,
    public readonly dataDirectory: string,
    public readonly defaults: Settings,
    private state: WebStateStore,
    private sandbox?: SandboxRuntime,
    private sandboxWorkingDirectory = '/home/agent/workspace',
    private logger?: RuntimeLog,
    private readonly imagesDirectory = join(dataDirectory, 'images'),
    lifecycleOptions: SandboxLifecycleOptions = {},
    notifications?: NotificationStore,
    private coordinator?: SharedCoordinator,
  ) {
    this.autoCheckpointAfterMs = lifecycleOptions.autoCheckpointAfterMs ?? 60 * 60 * 1000;
    this.notifications = notifications;
    this.projects = new ProjectService(state, undefined, undefined, Boolean(coordinator));
    if (sandbox) {
      this.sandboxOperations = new ProjectSandboxOperations({
        projects: this.projects, runtime: sandbox,
        assertHeld: id => this.projectLeases.get(id)?.assertHeld(),
        threadIds: id => [...this.sessions.values()].filter(session => session.projectId === id).flatMap(session => session.threadId ? [session.threadId] : []),
        saveSandbox: (id, value, restore, image) => this.updateSandbox(id, id, value, restore, image),
        selectRestoreImage: async (project, versionId) => this.imageCatalog
          ? this.imageCatalog.acquireRestoreSelection(project, versionId)
          : { selection: project.imageSelection, release() {} },
        logger: this.logger,
        detached: async id => {
          for (const session of this.sessions.values()) {
            if (session.projectId !== id) continue;
            await Promise.allSettled([...(this.uploads.get(session.id) ?? [])]);
            await Promise.all([...new Set([join(this.imagesDirectory, session.id), join(this.dataDirectory, 'images', session.id)])]
              .map(directory => rm(directory, { recursive: true, force: true })));
            delete session.sandbox;
            session.turns = [];
            delete session.contextUsage;
            this.historyErrors.delete(session.id);
            this.userInputAnswers.delete(session.id);
            await this.save(session);
            this.publish(session.id, { type: 'state', session: this.get(session.id) });
          }
          this.lastScheduledArchive.delete(id);
        },
      });
      this.lifecycle = new SandboxLifecycleService({
        ...lifecycleOptions,
        listProjects: () => this.listProjectsWithArchives(),
        reclaim: (id, options) => this.archiveProjectNow(id, options).then(() => {}),
      });
    }
  }

	get remoteArchives() { return this.sandbox?.remoteArchives; }
  setImageCatalog(catalog: ImageCatalog) { this.imageCatalog = catalog; }

  get sharedStateEnabled() { return Boolean(this.coordinator); }

  async refreshSharedState(): Promise<void> {
    if (!this.coordinator || this.closing) return;
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      await this.projects.refresh(new Set(this.mutations.keys()));
      const baselines = new Map(this.savedSessions);
      const sessions = await this.state.listSessions();
      const stored = new Map(sessions.map(session => [session.id, session]));
      const ids = new Set([...sessions.map(session => session.id), ...this.sessions.keys()]);
      await Promise.all([...ids].map(id => this.writer.run(id, async () => {
        if (this.active.has(id)) {
          // Keep the live observer's turn objects, but fan out answers accepted
          // by another API to viewers connected to this executing instance too.
          const local = this.sessions.get(id);
          let changed = false;
          for (const remoteTurn of stored.get(id)?.turns ?? []) {
            const localTurn = local?.turns.find(turn => turn.id === remoteTurn.id);
            if (localTurn && (remoteTurn.additionalUserInputs?.length ?? 0) > (localTurn.additionalUserInputs?.length ?? 0)) {
              localTurn.additionalUserInputs = [...remoteTurn.additionalUserInputs!]; changed = true;
            }
            for (const reply of remoteTurn.userInputRequests ?? []) {
              if (reply.status !== 'answered') continue;
              const request = localTurn?.userInputRequests?.find(request => request.id === reply.id);
              if (request && request.status !== 'answered') { Object.assign(request, reply); changed = true; }
            }
          }
          if (changed) this.publish(id, { type: 'state', session: this.get(id) });
          return;
        }
        const protectedScope = () => this.active.has(id) || this.deleting.has(id)
          || this.mutations.has(this.sessions.get(id)?.projectId ?? `session:${id}`);
        if (protectedScope()) return;
        const session = baselines.get(id) === this.savedSessions.get(id)
          ? stored.get(id) : await this.state.getSession(id);
        if (protectedScope()) return;
        if (!session) { this.sessions.delete(id); this.savedSessions.delete(id); return; }
        const local = this.sessions.get(id);
        this.savedSessions.set(id, structuredClone(session));
        session.turns = session.turns.map(turn => {
          const old = local?.turns.find(value => value.id === turn.id);
          return old ? { ...old, ...turn, items: turn.items.length ? turn.items : old.items } : turn;
        });
        this.sessions.set(id, session);
      })));
    })();
    try { await this.refreshing; } finally { this.refreshing = undefined; }
  }

  private async projectMutation<T>(id: string, action: () => Promise<T>): Promise<T> {
    if (!this.coordinator) return action();
    return this.coordinator.run(`project-control:${id}`, async () => {
      await this.refreshSharedState();
      this.mutations.set(id, (this.mutations.get(id) ?? 0) + 1);
      try { return await action(); }
      finally {
        const count = this.mutations.get(id)! - 1;
        if (count) this.mutations.set(id, count); else this.mutations.delete(id);
      }
    });
  }

  private async sessionMutation<T>(id: string, action: () => Promise<T>): Promise<T> {
    if (!this.coordinator) return action();
    const session = await this.state.getSession(id);
    if (!session) throw new HttpError(404, '会话不存在');
    return this.projectMutation(session.projectId ?? `session:${id}`, action);
  }

  private async recoverSharedExecutions() {
    if (!this.coordinator || this.closing || this.reconciling) return;
    this.reconciling = (async () => {
      await this.refreshSharedState();
      for (const candidate of [...this.sessions.values()]) {
        if (this.closing || this.active.has(candidate.id)) continue;
        if (!candidate.turns.some(turn => turn.status === 'running' || turn.userInputRequests?.some(request => request.status === 'queued'))) continue;
        await this.sessionMutation(candidate.id, async () => {
          if (this.closing || this.active.has(candidate.id)) return;
          let session = this.lookup(candidate.id);
          let turn = session.turns.find(turn => turn.status === 'running');
          if (!turn) { await this.startQueuedUserInput(session.id); return; }
          const lease = await this.coordinator!.tryAcquire(`session-execution:${session.id}`);
          if (!lease) return;
          try {
            lease.assertHeld();
            const fresh = await this.state.getSession(session.id);
            const freshTurn = fresh?.turns.find(value => value.id === turn!.id && value.status === 'running');
            if (!fresh || !freshTurn) { await lease.release(); return; }
            session = fresh; turn = freshTurn;
            this.savedSessions.set(session.id, structuredClone(session));
            this.sessions.set(session.id, session);
            if (!this.canRecover(session, turn)) {
              if (session.threadId && session.settings.executionMode === 'sandbox' && this.sandbox) {
                const history = await this.sandbox.history(session, { limit: 5 });
                const knownNativeTurnIds = new Set(session.turns.filter(candidate => candidate.id !== turn!.id && candidate.nativeTurnId)
                  .map(candidate => candidate.nativeTurnId!));
                const native = history.turns.find(candidate => candidate.status === 'running'
                  && !knownNativeTurnIds.has(candidate.id) && candidate.prompt === turn!.prompt
                  && Date.parse(candidate.startedAt) >= Date.parse(turn!.startedAt) - 1000);
                if (native) Object.assign(turn, native, { id: turn.id, nativeTurnId: native.id });
              }
              if (!this.canRecover(session, turn)) {
                if (turn.status === 'running') {
                  turn.status = 'cancelled'; turn.completedAt = new Date().toISOString();
                  turn.error = '执行实例已离线，未确认的请求不会自动重发。';
                }
                session.status = turn.status;
                lease.assertHeld();
                await this.save(session); await lease.release(); return;
              }
            }
            this.sandbox?.trackExecution?.(session, turn);
            this.executeTurn(session, turn, this.reserveTurn(session, lease), true);
          } catch (error) { await lease.release(); throw error; }
        });
      }
      for (const project of this.projects.list()) {
        if (this.closing || project.sandboxOperation?.status !== 'running' || this.projectLeases.has(project.id)) continue;
        await this.projectMutation(project.id, async () => {
          const lease = await this.coordinator!.tryAcquire(`project-maintenance:${project.id}`);
          if (!lease) return;
          try {
            // The cached ProjectService record can still say "running" if the
            // previous owner completed after this reconciler refreshed state
            // but before its maintenance lease became available. Re-read under
            // the lease and only fail the exact operation we originally saw.
            const latest = await this.state.getProject(project.id);
            const observed = project.sandboxOperation;
            if (latest?.sandboxOperation?.status === 'running'
              && latest.sandboxOperation.id === observed?.id) {
              lease.assertHeld();
              await this.projects.updateSandboxOperation(project.id, { ...latest.sandboxOperation,
                status: 'failed', error: '原执行实例已离线，请重试操作。', updatedAt: new Date().toISOString() });
            }
          } finally { await lease.release(); }
        });
      }
    })();
    try { await this.reconciling; } finally { this.reconciling = undefined; }
  }

  async init() {
    await this.state.init();
    await this.projects.init();
    for (const session of await this.state.listSessions()) {
      this.savedSessions.set(session.id, structuredClone(session));
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
        if (!this.coordinator && turn.status === 'running' && !this.canRecover(session, turn)) {
          turn.status = 'cancelled';
          turn.error = '服务重启时发现本轮没有可恢复的执行任务，已标记为已停止。';
          turn.completedAt = new Date().toISOString();
          changed = true;
        }
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
      if (!this.coordinator && (session.status === 'running' || session.turns.some(turn => turn.status === 'running' || this.canRecover(session, turn)))) {
        changed = true;
        for (const turn of session.turns.filter(t => t.status === 'running' || this.canRecover(session, t))) {
          if (this.canRecover(session, turn)) {
            // Message bodies are reconstructed from the App Server turn snapshot.
            turn.phase = 'recovering';
            continue;
          }
          turn.status = 'cancelled';
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
    // Initialize the lifecycle controller's in-memory observations. Project
    // records retain references only; API responses always query Cellbox.
    for (const project of this.projects.list()) {
      if (project.executionMode !== 'sandbox' || !project.sandbox || !this.sandbox?.inspect) continue;
      if (project.sandboxOperation?.status === 'failed' && ['create', 'resume', 'rebuild'].includes(project.sandboxOperation.kind)) continue;
      try { await this.sandbox.inspect(this.projectWorkspace(project)); }
      catch { /* A later query or lifecycle pass can retry provider inspection. */ }
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
    if (!this.coordinator) for (const { session, turn } of recoverable) this.sandbox?.trackExecution?.(session, turn);
    if (!this.coordinator) for (const { session, turn } of recoverable) this.executeTurn(session, turn, this.reserveTurn(session), true);
    for (const session of this.sessions.values()) {
      if (!this.coordinator && session.turns.some(turn => turn.userInputRequests?.some(request => request.status === 'queued')) && !this.active.has(session.id)) void this.startQueuedUserInput(session.id);
    }
    this.lifecycle?.start();
    if (this.coordinator) {
      await this.recoverSharedExecutions();
      this.recoveryTimer = setInterval(() => {
        void this.recoverSharedExecutions().catch(error => console.error('Shared execution recovery failed:', error.message));
      }, 1000);
      this.recoveryTimer.unref();
    }
  }

  private canRecover(session: Session, turn: Turn): boolean {
    if (!this.sandbox || session.settings.executionMode !== 'sandbox' || !session.sandbox) return false;
    return turn.status === 'running' && turn.codexAccepted === true
      && Boolean(session.threadId && turn.nativeTurnId);
  }

  private reserveTurn(session: Session, lease?: SharedLease): ActiveExecution {
    const releaseProject = this.projects.startSession(session.projectId, session.id);
    let resolveDone!: () => void;
    const execution: ActiveExecution = {
      controller: new AbortController(), lease, done: new Promise<void>(resolve => { resolveDone = resolve; }),
      finish: async () => {
        if (this.active.get(session.id) === execution) this.active.delete(session.id);
        releaseProject();
        await lease?.release();
        resolveDone();
      },
    };
    this.active.set(session.id, execution);
    lease?.signal.addEventListener('abort', () => {
      const turn = session.turns.find(turn => turn.id === execution.turnId);
      if (turn && session.settings.executionMode === 'sandbox') this.sandbox?.detach(turn);
      else execution.controller.abort();
    }, { once: true });
    return execution;
  }

  private executeTurn(session: Session, turn: Turn, execution: ActiveExecution, recovering = false) {
    const id = session.id;
    execution.turnId = turn.id;
    const running = runTurn(session, turn, execution.controller, {
      client: this.client, sandbox: this.sandbox, logger: this.logger, recovering,
      save: () => this.save(session), publish: message => this.publish(id, message), snapshot: () => this.get(id),
      updateSandbox: sandbox => this.updateSandbox(session.projectId, id, sandbox),
      onSteer: steer => { execution.steer = steer; },
      canPersist: () => !execution.lease?.signal.aborted,
    }).finally(async () => {
      if (execution.lease?.signal.aborted) { await execution.finish(); return; }
      if (session.settings.executionMode === 'sandbox' && session.status !== 'running'
        && !(session.turnCount ?? 0) && !session.turns.some(candidate => candidate.codexAccepted)) {
        try {
          await this.writer.wait(id);
          await this.state.deleteSession(id);
        } catch (error) {
          console.error('Unaccepted session cleanup failed:', error instanceof Error ? error.message : 'unknown error');
        }
      }
      await execution.finish();
      if (!this.closing) void this.startQueuedUserInput(id).catch(error => console.error('Queued user input failed:', error));
      if (this.notifications && turn.status !== 'running') {
        const type = turn.status === 'completed' ? 'turn_completed'
          : turn.status === 'cancelled' ? 'turn_cancelled' : 'turn_failed';
        const label = type === 'turn_completed' ? '执行完成' : type === 'turn_cancelled' ? '已停止' : '执行失败';
        const projectName = session.projectId ? this.projects.get(session.projectId)?.name : undefined;
        await this.notifications.add({
          type, title: `【${projectName ?? '无项目'}】${label}: ${session.title}`,
          body: turn.prompt.slice(0, 100),
          sessionId: session.id, sessionTitle: session.title, projectName, turnId: turn.id,
        });
      }
    });
    void running.catch(error => console.error('Session persistence failed:', error instanceof Error ? error.message : 'unknown error'));
  }

  async answerUserInput(id: string, turnId: string, requestId: string, answer: string, answers?: string[]): Promise<Session> {
    return this.sessionMutation(id, () => this.answerUserInputLocal(id, turnId, requestId, answer, answers));
  }

  private async answerUserInputLocal(id: string, turnId: string, requestId: string, answer: string, answers?: string[]): Promise<Session> {
    const history = await this.read(id);
    const session = this.lookup(id);
    const matches = (turn: Turn) => turn.id === turnId || turn.nativeTurnId === turnId || turn.userInputRequests?.some(request => request.id === requestId);
    let source = history.turns.find(matches);
    let cursor = history.historyNextCursor;
    const seen = new Set<string>();
    while (!source && cursor && !seen.has(cursor)) {
      seen.add(cursor);
      const page = await this.olderTurns(id, cursor);
      source = page.turns.find(matches);
      cursor = page.nextCursor;
    }
    if (source) {
      const index = session.turns.findIndex(turn => turn.id === source.id || turn.nativeTurnId === source.id);
      if (index >= 0) {
        const current = session.turns[index];
        const requests = source.userInputRequests?.map(request => request.status === 'answered' ? request
          : current.userInputRequests?.find(old => old.id === request.id) ?? request);
        current.userInputRequests = requests;
      } else session.turns.push(source);
    }
    const questionTurn = session.turns.find(matches);
    const request = questionTurn?.userInputRequests?.find(item => item.id === requestId);
    if (!questionTurn || !request) throw new HttpError(404, '问题不存在');
    if (this.coordinator) {
      const persisted = await this.state.getSession(id);
      const savedRequest = persisted?.turns.flatMap(turn => turn.userInputRequests ?? []).find(item => item.id === requestId);
      if (savedRequest && savedRequest.status !== 'pending') throw new HttpError(409, '问题已经回答');
    }
    if (request.status !== 'pending') throw new HttpError(409, '问题已经回答');
    if (answers && answers.length !== request.questions.length) throw new HttpError(400, '请回答所有问题');
    if (!answers && request.questions.length > 1) throw new HttpError(400, '请分别回答所有问题');
    request.answers = answers ?? [answer];
    request.status = 'queued'; request.answer = answer; request.answeredAt = new Date().toISOString(); session.updatedAt = request.answeredAt;
    await this.save(session); this.publish(id, { type: 'state', session: this.get(id) });
    await this.startQueuedUserInput(id);
    const snapshot = this.get(id);
    // Starting the reply makes it the latest turn. Return the updated question
    // too, so clients can replace the form they just submitted.
    if (!snapshot.turns.some(turn => turn.id === questionTurn.id)) snapshot.turns.unshift(structuredClone(questionTurn));
    return snapshot;
  }

  private async startQueuedUserInput(id: string): Promise<void> {
    if (this.closing) return;
    return this.sessionMutation(id, () => this.startQueuedUserInputLocal(id));
  }

  private async startQueuedUserInputLocal(id: string): Promise<void> {
    const pending = this.userInputDeliveries.get(id);
    if (pending) {
      await pending;
      return this.startQueuedUserInputLocal(id);
    }
    const delivery = this.deliverQueuedUserInput(id);
    this.userInputDeliveries.set(id, delivery);
    try { await delivery; }
    finally { if (this.userInputDeliveries.get(id) === delivery) this.userInputDeliveries.delete(id); }
  }

  private async deliverQueuedUserInput(id: string) {
    const session = this.lookup(id);
    for (const [index, source] of session.turns.entries()) for (const request of source.userInputRequests ?? []) {
      if (request.status !== 'queued' || !request.answer) continue;
      const prompt = `<send_user_message_question_reply>\n${JSON.stringify(request.questions.map((question, index) => ({
        answer: request.answers?.[index] ?? request.answer,
        question: question.title,
        questionItemId: JSON.stringify(['request_user_input_async', request.id, index]),
      })))}\n</send_user_message_question_reply>`;
      if (this.coordinator && session.threadId && session.settings.executionMode === 'sandbox' && this.sandbox) {
        // A successful native send may precede a failed metadata save. Confirm
        // native receipt before replaying a durable queue entry after takeover.
        const history = await this.sandbox.history(session, { limit: 20 });
        const received = history.turns.find(turn => turn.prompt === prompt || turn.additionalUserInputs?.includes(prompt));
        if (received) {
          request.status = 'answered'; request.answerTurnId = received.id;
          await this.save(session); continue;
        }
      }
      const execution = this.active.get(id);
      const remote = !execution && this.coordinator && session.settings.executionMode === 'sandbox'
        ? session.turns.find(turn => turn.status === 'running' && turn.nativeTurnId) : undefined;
      if (remote && this.sandbox?.steer) {
        let accepted: boolean;
        try { accepted = await this.sandbox.steer(session, remote, prompt); }
        catch (error) {
          request.status = 'pending'; delete request.answer; delete request.answers; delete request.answeredAt;
          await this.save(session); throw error;
        }
        if (accepted) {
          request.status = 'answered'; request.answerTurnId = remote.id;
          await this.save(session); this.publish(id, { type: 'state', session: this.get(id) });
          continue;
        }
        // Another observer owns finalization. Leave the durable reply queued;
        // shared recovery drains it once the native terminal state is saved.
        return;
      }
      if (execution) {
        const target = session.turns.find(turn => turn.id === execution.turnId);
        if (!target?.nativeTurnId || !execution.steer) return;
        let accepted: boolean;
        try { accepted = await execution.steer(prompt); }
        catch (error) {
          // Do not replay an RPC with an unknown delivery outcome at turn end.
          request.status = 'pending';
          delete request.answer; delete request.answers; delete request.answeredAt;
          await this.save(session); this.publish(id, { type: 'state', session: this.get(id) });
          throw error;
        }
        if (accepted) {
          request.status = 'answered'; request.answerTurnId = target.id;
          session.updatedAt = new Date().toISOString();
          await this.save(session); this.publish(id, { type: 'state', session: this.get(id) });
          continue;
        }
        // The native turn can finish before our observer sees completion.
        // Its finalizer drains this queue after releasing the active execution.
        if (this.active.has(id)) return;
      }
      const existing = session.turns.slice(index + 1).find(turn => turn.prompt === prompt && Date.parse(turn.startedAt) >= Date.parse(request.answeredAt ?? request.createdAt));
      const answerTurnId = existing?.id ?? await this.startTurn(id, prompt);
      request.status = 'answered'; request.answerTurnId = answerTurnId; session.updatedAt = new Date().toISOString();
      await this.save(session); this.publish(id, { type: 'state', session: this.get(id) });
      if (!existing) return;
    }
  }

  list(): SessionSummary[] {
    return [...this.sessions.values()].map(session => this.hydrate(session)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map(({ turns, ...session }) => structuredClone({ ...session, turnCount: session.settings.executionMode === 'sandbox'
        ? Math.max(session.turnCount ?? 0, turns.filter(turn => turn.codexAccepted).length) : turns.length }));
  }

  private async liveProject(project: Project, allowUnknown = false): Promise<Project> {
    if (project.sandbox) project.sandbox = await querySandbox(this.sandbox, project.sandbox, allowUnknown);
    return project;
  }

  async readProject(id: string, options: ProjectReadOptions = {}, signal?: AbortSignal): Promise<ProjectSummary> {
    await this.refreshSharedState();
    return traced('project.read', { 'project.id': id, 'operation.id': options.waitForOperation }, async () => {
      this.projects.get(id);
      if (options.waitForOperation) {
        await traced('project.wait', { 'operation.id': options.waitForOperation }, async () => {
          await this.sandboxOperations?.wait(id, options.waitForOperation!, options.waitMs ?? PROJECT_OPERATION_WAIT_MS, signal);
        });
        traceEvent('project.wait.finished');
      }
      signal?.throwIfAborted();
      return traced('project.live_view', { 'project.id': id }, async () =>
        this.projectSummary(await this.liveProject(this.projects.get(id), true)));
    });
  }

  async snapshot(id: string): Promise<Session> {
    const session = this.get(id);
    if (session.sandbox) session.sandbox = await querySandbox(this.sandbox, session.sandbox, true);
    return session;
  }

  get(id: string): Session {
    const session = this.lookup(id);
    const turns = session.settings.executionMode === 'sandbox' ? session.turns.slice(-1) : session.turns;
    return structuredClone({ ...session, turns, historyError: this.historyErrors.get(id) });
  }
  async read(id: string): Promise<Session> {
    await this.refreshSharedState();
    const session = this.lookup(id);
    if (session.settings.executionMode === 'sandbox') {
      const snapshot = await this.snapshot(id);
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
        const turns = page.turns.map(native => {
          const current = session.turns.find(turn => turn.nativeTurnId === native.id || turn.id === native.id);
          return withNativeUserInput(current ? { ...native, ...current, nativeTurnId: native.id,
            additionalUserInputs: native.additionalUserInputs ?? current.additionalUserInputs,
            prompt: current.prompt || native.prompt, items: native.items.map(item => ({ ...current.items.find(old => old.id === item.id), ...item })).concat(current.items.filter(item => !native.items.some(other => other.id === item.id))),
            ...(current.userInputRequests ? { userInputRequests: current.userInputRequests } : {}) } : native);
        });
        const live = session.turns.filter(turn => turn.status === 'running');
        for (const turn of live) if (!turns.some(candidate => candidate.id === turn.id)) turns.push(turn);
        turns.sort((left, right) => left.startedAt.localeCompare(right.startedAt));
        return { ...snapshot, turns: this.withUserInputHistory(session, turns), historyNextCursor: page.nextCursor ?? null, historyError: undefined };
      } catch (error) {
        if (error instanceof HttpError && error.status === 409) throw error;
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
    return { turns: this.withUserInputHistory(session, page.turns.map(turn => withNativeUserInput({ ...turn,
      userInputRequests: session.turns.find(old => old.id === turn.id || old.nativeTurnId === turn.id)?.userInputRequests ?? turn.userInputRequests,
    })).sort((left, right) => left.startedAt.localeCompare(right.startedAt))), nextCursor: page.nextCursor ?? null };
  }

  private withUserInputHistory(session: Session, turns: Turn[]): Turn[] {
    let cached = this.userInputAnswers.get(session.id);
    if (!cached || cached.threadId !== session.threadId) {
      cached = { threadId: session.threadId, answers: new Map() };
      this.userInputAnswers.set(session.id, cached);
    }
    // Newest-first pagination sees replies before older questions. Retain only
    // this derived index in memory; App Server history owns the durable state.
    collectNativeUserInputAnswers(turns, cached.answers);
    return turns.map(turn => withNativeUserInput(turn, cached.answers));
  }

  async subagents(id: string): Promise<SubagentConversation[]> {
    const session = this.lookup(id);
    if (!session.threadId) return [];
    if (session.settings.executionMode === 'sandbox') {
      if (!session.sandbox || (session.projectId && this.projects.isMaintaining(session.projectId))) return [];
      if (!this.sandbox?.subagents) return [];
      const read = this.projects.beginRead(session.projectId);
      try {
        const result = await this.sandbox.subagents(structuredClone(session), read.signal);
        read.signal.throwIfAborted();
        return result;
      }
      catch (error) {
        read.signal.throwIfAborted();
        if (error && typeof error === 'object' && 'code' in error && error.code === 'BUSY') {
          throw new HttpError(503, 'Sandbox 正忙，请稍后重试');
        }
        throw error;
      }
      finally { read.release(); }
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
    const read = this.projects.beginRead(session.projectId);
    try {
      if (session.projectId && this.projects.get(session.projectId).sandbox?.id !== session.sandbox?.id) {
        throw new HttpError(409, '项目环境已切换，请刷新重试');
      }
      const result = await this.sandbox!.history(structuredClone(session), { ...options, signal: read.signal });
      read.signal.throwIfAborted();
      return result;
    } catch (error) {
      read.signal.throwIfAborted();
      throw error;
    } finally { read.release(); }
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
        prompt: turn.prompt || stored.prompt,
        images: turn.images.length ? turn.images : stored.images,
        items: [...turn.items, ...storedOnlyItems],
        userInputRequests: stored.userInputRequests,
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
    session.turns = this.withUserInputHistory(session, mapped);
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
    if (session.projectId) {
      const project = this.projects.find(session.projectId);
      session.sandbox = structuredClone(project?.sandbox);
      session.imageSelection = structuredClone(project?.imageSelection);
    }
    return session;
  }

  listProjects(): ProjectSummary[] {
    return [...this.projects.list()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(project => this.projectSummary(project));
  }

  async listProjectsWithArchives(): Promise<ProjectSummary[]> {
    const summaries = this.listProjects();
    const sandboxes = summaries.flatMap(project => project.sandbox ? [project.sandbox] : []);
    if (sandboxes.length) {
      let observations: Map<string, NonNullable<Project['sandbox']>>;
      try {
        if (!this.sandbox?.querySandboxes) throw new Error('Sandbox batch query unavailable');
        observations = new Map((await this.sandbox.querySandboxes(sandboxes)).map(sandbox => [sandbox.id, sandbox]));
      } catch {
        observations = new Map();
      }
      for (const project of summaries) if (project.sandbox)
        project.sandbox = observations.get(project.sandbox.id) ?? { ...project.sandbox, status: 'unknown' };
    }
    return summaries.map(project => ({ ...project, archiveVersions: project.remoteArchives?.map((archive, index, all) => ({
      id: archive.id, version: all.length - index, createdAt: archive.createdAt,
      sizeBytes: archive.sizeBytes, label: `版本 ${all.length - index}`,
    })) }));
  }

  private projectSummary(project: Project): ProjectSummary {
    return structuredClone({ ...project, status: project.status ?? (project.archivedAt ? 'archived' : 'active'), archivedAt: project.archivedAt ?? null, sessionCount: [...this.sessions.values()].filter(session => session.projectId === project.id).length,
      latestBackup: project.latestBackup,
      activeSessionId: this.projects.activeSessionId(project.id)
        ?? [...this.sessions.values()].find(session => session.projectId === project.id && session.status === 'running')?.id ?? null });
  }

  getProject(id: string): ProjectSummary { return this.projectSummary(this.projects.get(id)); }

  async createProject(input: ProjectInput, settings?: Settings): Promise<ProjectSummary> {
    return this.projectMutation('project-create', () => this.createProjectLocal(input, settings));
  }

  private async createProjectLocal(input: ProjectInput, settings?: Settings): Promise<ProjectSummary> {
    if (this.closing) throw new HttpError(503, '服务正在关闭');
    const valid = await this.validateSettings(settings ?? { ...this.defaults, executionMode: 'sandbox', workingDirectory: this.defaults.executionMode === 'sandbox' ? this.defaults.workingDirectory : this.sandboxWorkingDirectory });
    const project = await this.projects.create(input, valid);
    if (project.executionMode === 'sandbox') await this.submitProjectSandboxOperation(project.id, 'create');
    return this.readProject(project.id);
  }

  async updateProject(id: string, input: ProjectUpdate): Promise<ProjectSummary> {
    return this.projectMutation(id, () => this.updateProjectLocal(id, input));
  }

  private async updateProjectLocal(id: string, input: ProjectUpdate): Promise<ProjectSummary> {
    await this.projects.update(id, input);
    return this.readProject(id);
  }

  async rebuildProjectSandbox(id: string, imageVersionId?: string): Promise<ProjectSummary> {
    const project = await this.liveProject(this.projects.get(id));
    if (project.sandbox?.status === 'paused') throw new HttpError(409, 'Sandbox 已暂停，请恢复运行');
    if (project.sandbox?.status === 'starting') throw new HttpError(409, 'Sandbox 正在切换状态，请稍后重试');
    if (project.sandbox?.status === 'ready' && !(project.sandboxOperation?.status === 'failed' && ['create', 'resume', 'rebuild'].includes(project.sandboxOperation.kind))) {
      throw new HttpError(409, 'Sandbox 已就绪，无需重建');
    }
    if (project.status !== 'archived' && !project.sandbox && project.remoteArchives?.length) throw new HttpError(409, '没有可沿用的 Sandbox 挂载目录，重建已停止');
    const kind = project.status === 'archived' ? 'restore'
      : !project.sandbox ? 'create'
      : project.sandbox.status === 'ready' && project.sandboxOperation?.kind === 'create' ? 'create'
      : project.sandbox.status === 'ready' && project.sandboxOperation?.kind === 'resume' ? 'resume' : 'rebuild';
    await this.submitProjectSandboxOperation(id, kind, { imageVersionId });
    return this.readProject(id);
  }

  async backupProjectNow(id: string): Promise<ProjectSummary> {
    await this.runProjectSandboxOperation(id, 'backup');
    return this.readProject(id);
  }

  async resumeProjectSandbox(id: string): Promise<ProjectSummary> {
    await this.submitProjectSandboxOperation(id, 'resume');
    return this.readProject(id);
  }

  /** Opening is idempotent: join preparation, or start one resume of the existing box. */
  async enterProject(id: string): Promise<ProjectSummary> {
    return this.projectMutation(id, () => this.enterProjectLocal(id));
  }

  private async enterProjectLocal(id: string): Promise<ProjectSummary> {
    const pending = this.projectEntries.get(id);
    if (pending) return pending;
    const request = Promise.resolve().then(async () => {
      if (this.closing) throw new HttpError(503, '服务正在关闭');
      let project = this.projects.get(id);
      if (project.status !== 'active') throw new HttpError(409, '项目未处于使用中状态，请先恢复项目');
      if (project.executionMode !== 'sandbox' || this.projects.isMaintaining(id)) return this.readProject(id);
      const revision = project.updatedAt;
      const operationId = project.sandboxOperation?.id;
      const observed = await this.liveProject(project);
      // Another lifecycle action may have started while the provider was read.
      project = this.projects.get(id);
      if (this.closing) throw new HttpError(503, '服务正在关闭');
      if (project.status !== 'active') throw new HttpError(409, '项目未处于使用中状态，请先恢复项目');
      if (this.projects.isMaintaining(id) || project.updatedAt !== revision || project.sandboxOperation?.id !== operationId
        || project.sandbox?.id !== observed.sandbox?.id) return this.readProject(id);
      if (observed.sandbox?.status === 'paused') await this.submitProjectSandboxOperation(id, 'resume');
      return this.readProject(id);
    });
    this.projectEntries.set(id, request);
    try { return await request; }
    finally { if (this.projectEntries.get(id) === request) this.projectEntries.delete(id); }
  }

  async checkpointProjectSandbox(id: string): Promise<ProjectSummary> {
    await this.submitProjectSandboxOperation(id, 'checkpoint');
    return this.readProject(id);
  }

  private async submitProjectSandboxOperation(id: string, kind: NonNullable<Project['sandboxOperation']>['kind'], options: { imageVersionId?: string } = {}) {
    if (this.closing) throw new HttpError(503, '服务正在关闭');
    if (!this.sandboxOperations) throw new HttpError(503, 'Sandbox 未配置');
    await this.startProjectOperation(id, () => this.sandboxOperations!.start(id, kind, options));
  }

  async refreshProjectSandboxRuntime(id: string): Promise<ProjectSummary> {
    await this.runProjectSandboxOperation(id, 'refresh');
    return this.readProject(id);
  }

  async archiveProjectNow(id: string, options: { useExistingBackup?: boolean } = {}): Promise<ProjectSummary> {
    await this.runProjectSandboxOperation(id, 'archive', options);
    return this.readProject(id);
  }

  private async runProjectSandboxOperation(id: string, kind: NonNullable<Project['sandboxOperation']>['kind'],
    options: { useExistingBackup?: boolean } = {}) {
    if (this.closing) throw new HttpError(503, '服务正在关闭');
    if (!this.sandboxOperations) throw new HttpError(503, 'Sandbox 未配置');
    const { done } = await this.startProjectOperation(id, () => this.sandboxOperations!.start(id, kind, options));
    await done;
  }

  private async startProjectOperation(id: string, action: () => Promise<{ done: Promise<void> }>) {
    return this.projectMutation(id, async () => {
      if (!this.coordinator) return action();
      const lease = await this.coordinator.tryAcquire(`project-maintenance:${id}`);
      if (!lease) throw new HttpError(409, '项目正在其他实例执行维护，请稍后重试');
      this.projectLeases.set(id, lease);
      try {
        for (const session of await this.state.listSessions()) if (session.projectId === id
          && (session.status === 'running' || session.turns.some(turn => turn.status === 'running'))) {
          throw new HttpError(409, '项目正在使用，请等待任务结束后重试');
        }
        // A running marker whose owning connection disappeared is an orphan,
        // not evidence that every other API's work should fail on startup.
        const project = this.projects.get(id);
        if (project.sandboxOperation?.status === 'running') await this.projects.updateSandboxOperation(id,
          { ...project.sandboxOperation, status: 'failed', error: '原执行实例已离线，请重试操作。', updatedAt: new Date().toISOString() });
        lease.assertHeld();
        const { done } = await action();
        const guarded = done.finally(async () => {
          this.projectLeases.delete(id);
          await lease.release();
        });
        void guarded.catch(() => {});
        return { done: guarded };
      } catch (error) {
        this.projectLeases.delete(id); await lease.release(); throw error;
      }
    });
  }

  async scheduledArchiveForProject(id: string) {
    const project = await this.liveProject(this.projects.get(id));
    if (!project.sandbox || project.status === 'archived' || project.sandbox.status !== 'ready') return;
    await this.backupProjectNow(id);
  }

  private lastScheduledArchive = new Map<string, number>();
  private readonly scheduledArchiveInterval =
    Number(process.env.SANDBOX_SCHEDULED_ARCHIVE_THRESHOLD_MS ?? 30 * 60 * 1000);

  async scheduledArchive() {
    if (!this.coordinator) return this.scheduledArchiveLocal();
    const lease = await this.coordinator.tryAcquire('sandbox-lifecycle-scheduler');
    if (!lease) return;
    try { await this.scheduledArchiveLocal(); }
    finally { await lease.release(); }
  }

  private async scheduledArchiveLocal() {
    if (this.closing) return;
    await this.refreshSharedState();
    const now = Date.now();
    for (const project of this.projects.list()) {
      if (this.coordinator && project.status === 'active' && project.sandbox) {
        const sessions = [...this.sessions.values()].filter(session => session.projectId === project.id);
        const lastActivity = Math.max(Date.parse(project.sandbox.lastActiveAt ?? project.createdAt),
          ...sessions.map(session => Date.parse(session.updatedAt)));
        if (!sessions.some(session => session.status === 'running') && now - lastActivity >= this.autoCheckpointAfterMs) {
          const observed = await this.liveProject(project, true);
          if (observed.sandbox?.status === 'ready') {
            await this.checkpointProjectSandbox(project.id).catch(() => {});
            continue;
          }
        }
      }
      if (project.status === 'archived' && !project.sandboxArtifactsCleanedAt) {
        await this.archiveProjectNow(project.id).catch(() => {});
        continue;
      }
      if (project.archiveCleanupSourceId) {
        await this.archiveProjectNow(project.id).catch(() => {});
        continue;
      }
      if (project.pendingSandboxCleanup?.length) await this.projectMutation(project.id, async () => {
        const { done } = await this.startProjectOperation(project.id, async () => ({ done: this.sandboxOperations!.retryCleanup(project.id) }));
        await done;
      }).catch(() => {});
      if (!project.sandbox || project.status === 'archived') continue;
      const last = Math.max(this.lastScheduledArchive.get(project.id) ?? (Date.parse(project.createdAt) || 0),
        ...((project.remoteArchives ?? []).map(archive => Date.parse(archive.createdAt) || 0)));
      if (now - last >= this.scheduledArchiveInterval) {
        this.lastScheduledArchive.set(project.id, now);
        await this.scheduledArchiveForProject(project.id).catch(() => {});
      }
    }
  }

  async pruneArchivedProjectArchives(): Promise<number> {
    const remote = this.remoteArchives;
    if (!remote) return 0;
    let removed = 0;
    for (const project of this.projects.list().filter(p => p.status === 'archived')) {
      removed += await this.projectMutation(project.id, async () => {
        const current = this.projects.get(project.id);
        if (current.status !== 'archived' || this.projects.isMaintaining(project.id)) return 0;
        return pruneRemoteArchives(current.remoteArchives ?? [], current.backupRetentionCount ?? 2,
          remote, id => this.projects.removeRemoteArchive(project.id, id));
      });
    }
    return removed;
  }

  private isSandboxReferenced(sandboxId: string): boolean {
    return this.projects.list().some(project => project.sandbox?.id === sandboxId
      || (this.projects.isMaintaining(project.id) && project.pendingSandboxCleanup?.some(sandbox => sandbox.id === sandboxId)))
      || [...this.sessions.values()].some(session => !session.projectId && session.sandbox?.id === sandboxId);
  }

  async sweepSandboxLifecycle() {
    await this.lifecycle?.sweep();
  }

  private async ensureProjectSandbox(id: string): Promise<void> {
    await this.refreshSharedState();
    if (this.projects.isMaintaining(id)) throw new HttpError(409, '项目环境正在维护，请稍后重试');
    const project = await this.liveProject(this.projects.get(id));
    if (project.status === 'archived') {
      throw new HttpError(409, '项目已归档，请先点击“恢复项目”');
    }
    if (project.sandbox?.status !== 'ready' || (project.sandboxOperation?.status === 'failed'
      && ['create', 'resume', 'rebuild'].includes(project.sandboxOperation.kind))) {
      throw new HttpError(409, project.sandbox?.status === 'paused' ? 'Sandbox 已暂停，请先恢复运行' : 'Sandbox 尚未就绪，请先在项目管理中创建或恢复环境');
    }
    if (!project.sandbox && (project.remoteArchives?.length)) {
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
    return this.projectMutation(id, async () => {
      if (!this.coordinator) return this.deleteProjectLocal(id);
      const lease = await this.coordinator.tryAcquire(`project-maintenance:${id}`);
      if (!lease) throw new HttpError(409, '项目正在维护，请稍后重试');
      try {
        if ((await this.state.listSessions()).some(session => session.projectId === id && session.status === 'running'))
          throw new HttpError(409, '请先停止项目中的任务');
        lease.assertHeld();
        await this.deleteProjectLocal(id);
      } finally { await lease.release(); }
    });
  }

  private async deleteProjectLocal(id: string) {
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
    this.userInputAnswers.delete(id);
    this.subscribers.delete(id);
    clearInterval(this.subscriptionPolls.get(id)?.timer);
    this.subscriptionPolls.delete(id);
    this.writer.forget(id);
  }

  private async updateSandbox(projectId: string | undefined, sessionId: string, sandbox: NonNullable<Session['sandbox']>, restoreProject = false, restoreImage?: ProjectImageSelection) {
    if (projectId) {
      const project = this.projects.find(projectId);
      const replacing = project?.sandbox?.id !== sandbox.id;
      const freshEnvironment = replacing && project?.sandboxOperation?.kind === 'create';
      if (!await this.projects.updateSandbox(projectId, sandbox, restoreProject, restoreImage)) return;
      for (const sibling of this.sessions.values()) {
        if (sibling.projectId !== projectId || this.deleting.has(sibling.id)) continue;
        sibling.sandbox = structuredClone(sandbox);
        if (freshEnvironment) { sibling.threadId = null; delete sibling.contextUsage; }
        sibling.settings.workingDirectory = sandbox.workingDirectory;
        if (replacing || freshEnvironment) {
          try { await this.save(sibling); }
          catch (error) {
            if (!replacing) throw error;
            // The authoritative project cutover is already durable. Hydration and
            // startup repair session snapshots; don't roll the runtime binding back.
            console.error('Session sandbox snapshot save failed after upgrade:', sibling.id);
          }
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
      if ((directory !== '/home/agent/workspace' && !directory.startsWith('/home/agent/workspace/'))
        || /^\/home\/agent\/workspace\/\.cocell(?:\/|$)/.test(directory)) {
        throw new HttpError(400, 'Sandbox 工作目录须位于 /home/agent/workspace 下，且不能使用 Codex 内部目录');
      }
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
    return this.projectMutation(input.projectId ?? 'project-create', () => this.createLocal(input));
  }

  private async createLocal(input: { projectId?: string; settings?: Partial<Settings>; threadId?: string; title?: string }): Promise<Session> {
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
        project = await this.projects.create({ name: input.title ?? '新项目' }, settings);
        // A caller creating a session without a project waits for its implicit
        // project's environment; explicit project creation returns for polling.
        await this.runProjectSandboxOperation(project.id, 'create');
        project = this.projects.get(project.id);
        release = this.projects.acquire(project.id);
      }
      const now = new Date().toISOString();
      const session: Session = { id: randomUUID(), ...(project ? { projectId: project.id, ...(project.sandbox ? { sandbox: structuredClone(project.sandbox) } : {}) } : {}), threadId: input.threadId ?? null, title: input.title ?? '新任务', settings, status: 'idle', startedAt: now, archivedAt: null, createdAt: now, updatedAt: now, turns: [] };
      await this.save(session);
      this.sessions.set(session.id, session);
      return this.snapshot(session.id);
    } finally { release(); }
  }

  async update(id: string, input: { title?: string; settings?: Partial<Settings>; archived?: boolean }): Promise<Session> {
    return this.sessionMutation(id, () => this.updateLocal(id, input));
  }

  private async updateLocal(id: string, input: { title?: string; settings?: Partial<Settings>; archived?: boolean }): Promise<Session> {
    const session = this.lookup(id);
    if (this.active.has(id) || session.status === 'running') throw new HttpError(409, '请先停止当前任务再修改会话');
    if (input.archived && session.turns.some(turn => turn.status === 'running')) {
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
    return this.snapshot(id);
  }

  async delete(id: string) {
    return this.sessionMutation(id, () => this.deleteLocal(id));
  }

  private async deleteLocal(id: string) {
    const session = this.lookup(id);
    if (this.active.has(id) || session.status === 'running') throw new HttpError(409, '请先停止当前任务');
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
    if (this.coordinator && !this.subscriptionPolls.has(id)) {
      const poll: SubscriptionWatch = {
        timer: setInterval(() => {
          if (this.closing || poll.pending) return;
          poll.pending = this.syncSubscriber(id, poll).catch(error => {
            void this.logger?.write({ event: 'session.observation_failed', sessionId: id,
              message: error instanceof Error ? error.message : String(error) });
          }).finally(() => { poll.pending = undefined; });
        }, 1000),
      };
      poll.timer.unref();
      this.subscriptionPolls.set(id, poll);
      poll.pending = this.syncSubscriber(id, poll).catch(() => {}).finally(() => { poll.pending = undefined; });
    }
    return () => {
      subscribers.delete(callback);
      if (!subscribers.size) {
        this.subscribers.delete(id);
        clearInterval(this.subscriptionPolls.get(id)?.timer);
        this.subscriptionPolls.get(id)?.observation?.controller.abort();
        this.subscriptionPolls.delete(id);
      }
    };
  }

  /** Poll only control metadata. Conversation bodies arrive over the native connection. */
  private async syncSubscriber(id: string, watch: SubscriptionWatch) {
    if (this.active.has(id)) { watch.observation?.controller.abort(); return; }
    const stored = await this.state.getSession(id);
    if (!stored || this.closing || !this.subscribers.has(id) || this.active.has(id)) return;
    const previous = this.sessions.get(id);
    const session = { ...stored, turns: stored.turns.map(turn => {
      const old = previous?.threadId === stored.threadId && previous?.sandbox?.id === stored.sandbox?.id
        ? previous.turns.find(value => value.id === turn.id) : undefined;
      return old ? { ...old, ...turn, items: old.items, itemTimestamps: old.itemTimestamps,
        // A native terminal event may beat the owner's control-state commit.
        ...(old.status !== 'running' && turn.status === 'running' && old.codexAccepted
          ? { status: old.status, completedAt: old.completedAt } : {}) } : turn;
    }) };
    this.sessions.set(id, session);
    const serialized = JSON.stringify(stored);
    if (serialized !== watch.last) {
      watch.last = serialized;
      this.publish(id, { type: 'state', session: this.get(id) });
    }
    const current = this.lookup(id);
    const turn = stored.turns.find(value => value.status === 'running' && value.codexAccepted && value.nativeTurnId);
    // Runtime status is intentionally absent from durable project metadata.
    // A confirmed running turn is enough to attempt a non-waking connection.
    const available = !!current.sandbox
      && (!current.projectId || !this.projects.isMaintaining(current.projectId));
    const key = turn && current.threadId && available
      ? `${current.sandbox!.id}:${current.threadId}:${turn.nativeTurnId}` : undefined;
    if (watch.observation?.key !== key || watch.observation?.controller.signal.aborted) {
      watch.observation?.controller.abort();
      await watch.observation?.done;
      watch.observation = undefined;
    }
    if (!key || !turn || !this.sandbox?.observe || watch.observation || watch.completedKey === key
      || this.closing || !this.subscribers.has(id)) return;
    const controller = new AbortController();
    const observation = { key, controller, done: Promise.resolve() };
    watch.observation = observation;
    observation.done = (async () => {
      const read = this.projects.beginRead(current.projectId);
      const signal = AbortSignal.any([controller.signal, read.signal]);
      try {
        for await (const value of this.sandbox!.observe!(structuredClone(current), structuredClone(turn), signal)) {
          if (signal.aborted || this.active.has(id) || !this.subscribers.has(id)) { controller.abort(); break; }
          const live = this.lookup(id);
          if (live.threadId !== current.threadId || live.sandbox?.id !== current.sandbox?.id) { controller.abort(); break; }
          const target = live.turns.find(candidate => candidate.id === turn.id);
          if (!target) break;
          if (value.type === 'snapshot') {
            Object.assign(target, withNativeUserInput({ ...target, ...value.turn, id: target.id,
              nativeTurnId: value.turn.id, prompt: target.prompt || value.turn.prompt,
              userInputRequests: target.userInputRequests }));
            live.status = target.status;
            this.publish(id, { type: 'state', session: this.get(id) });
          } else {
            Object.assign(target, applyTurnEvent(target, value.event));
            live.status = target.status;
            this.publish(id, { type: 'sdk', turnId: target.id, event: value.event });
          }
          if (target.status !== 'running') watch.completedKey = key;
        }
      } finally { read.release(); }
    })().catch(error => {
      if (!controller.signal.aborted) void this.logger?.write({ event: 'session.native_observation_failed', sessionId: id,
        message: error instanceof Error ? error.message : String(error) });
    }).finally(() => { if (watch.observation === observation) watch.observation = undefined; });
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
      codexAccepted: turn.codexAccepted, error: turn.error,
      prompt: turn.prompt,
      additionalUserInputs: turn.additionalUserInputs,
      images: turn.images,
      items: turn.items,
      userInputRequests: turn.userInputRequests,
      itemTimestamps: turn.itemTimestamps,
      usage: turn.usage, sdkUsage: turn.sdkUsage,
      contextUsage: turn.contextUsage?.map(({ blockEstimates, blockTokenizer, blockTexts, ...call }) => call),
    }));
    const contextUsage = session.contextUsage && (() => {
      const { blockEstimates, blockTokenizer, blockTexts, ...value } = session.contextUsage;
      return value;
    })();
    const next = structuredClone({ ...session, contextUsage: contextUsage || undefined, turns });
    return this.writer.run(session.id, async () => {
      await this.state.saveSession(next, this.coordinator ? this.savedSessions.get(session.id) : undefined);
      this.savedSessions.set(session.id, structuredClone(next));
    });
  }

  async uploadImage(id: string, content: Uint8Array, extension: string): Promise<string> {
    return this.sessionMutation(id, () => this.uploadImageLocal(id, content, extension));
  }

  private async uploadImageLocal(id: string, content: Uint8Array, extension: string): Promise<string> {
    const session = this.lookup(id);
    if (session.projectId && this.projects.get(session.projectId).status === 'archived') throw new HttpError(409, '项目已归档，请先恢复项目');
    const release = this.projects.acquire(session.projectId);
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
      release();
      uploads.delete(operation);
      if (!uploads.size) this.uploads.delete(id);
    }
  }

  async startTurn(id: string, prompt: string, images: string[] = []): Promise<string> {
    const deadline = Date.now() + 10_000;
    while (true) {
      if (!images.length) await this.waitForNativeTurnAcceptance(id, deadline);
      try {
        return await this.sessionMutation(id, () => this.startTurnLocal(id, prompt, images));
      } catch (error) {
        if (!(error instanceof NativeTurnAcceptancePending)) throw error;
        if (Date.now() >= deadline) throw new HttpError(409, '当前任务尚未连接到 Codex，请稍后再发送');
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
  }

  private async waitForNativeTurnAcceptance(id: string, deadline: number) {
    let observed = this.coordinator ? await this.state.getSession(id) : this.lookup(id);
    let turn = observed?.turns.find(candidate => candidate.status === 'running');
    while (turn && !turn.nativeTurnId && Date.now() < deadline) {
      const execution = this.active.get(id);
      if (execution) {
        await Promise.race([execution.done, new Promise(resolve => setTimeout(resolve, 50))]);
        observed = this.lookup(id);
      } else {
        observed = this.coordinator ? await this.state.getSession(id) : this.lookup(id);
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      turn = observed?.turns.find(candidate => candidate.status === 'running');
    }
  }

  private async startTurnLocal(id: string, prompt: string, images: string[] = []): Promise<string> {
    if (this.closing) throw new HttpError(503, '服务正在关闭');
    let session = this.lookup(id);
    if (session.projectId && this.projects.get(session.projectId).status !== 'active') {
      throw new HttpError(409, this.projects.get(session.projectId).status === 'completed'
        ? '项目已完成，请先恢复为使用中再继续对话' : '项目已归档，请先恢复项目后再继续对话');
    }
    if (session.archivedAt) throw new HttpError(409, '会话已归档，请先恢复后再发送消息');
    const running = () => session.turns.find(turn => turn.status === 'running');
    let current = running();
    if (current || this.active.has(id)) {
      if (images.length) throw new HttpError(409, '任务执行中只能追加文字消息');
      const execution = this.active.get(id);
      current = running();
      if (!current && !this.active.has(id)) {
        // The previous turn completed while this submission waited for
        // acceptance. Continue below and start it as a regular next turn.
      } else {
        if (!current?.nativeTurnId) throw new NativeTurnAcceptancePending();
        let accepted = false;
        try {
          if (execution && this.active.get(id) === execution && execution.steer) {
            accepted = await execution.steer(prompt);
          } else if (this.coordinator && session.settings.executionMode === 'sandbox' && this.sandbox?.steer) {
            accepted = await this.sandbox.steer(session, current, prompt);
          }
        } catch {
          // A failed steer RPC can have an unknown delivery outcome. Never
          // retry it automatically or start a separate turn on this request.
          throw new HttpError(502, '追加消息的接收状态不确定，请检查会话后再继续');
        }
        if (!accepted) throw new HttpError(409, 'Codex 已不再接收当前任务的追加消息，请刷新会话后重试');
        current.additionalUserInputs = [...(current.additionalUserInputs ?? []), prompt];
        session.updatedAt = new Date().toISOString();
        await this.save(session);
        this.publish(id, { type: 'state', session: this.get(id) });
        return current.id;
      }
    }
    if (this.active.has(id) || running()) throw new HttpError(409, '当前会话已有任务正在执行');
    if (session.projectId && session.settings.executionMode === 'sandbox') {
      await this.ensureProjectSandbox(session.projectId);
      if (this.closing) throw new HttpError(503, '服务正在关闭');
      session = this.lookup(id);
    }
    const previous = structuredClone(session);
    // Reserve the session synchronously, before validating attachments or saving state.
    const lease = await this.coordinator?.tryAcquire(`session-execution:${id}`);
    if (lease === null) throw new HttpError(409, '当前会话已有任务正在执行');
    let execution: ActiveExecution;
    try { execution = this.reserveTurn(session, lease); }
    catch (error) { await lease?.release(); throw error; }
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
      this.sessions.set(id, previous);
      await execution.finish();
      this.publish(id, { type: 'state', session: this.get(id) });
      throw error;
    }
  }

  async stop(id: string) {
    return this.sessionMutation(id, () => this.stopLocal(id));
  }

  private async stopLocal(id: string) {
    const current = this.lookup(id);
    const execution = this.active.get(id);
    if (execution) {
      execution.controller.abort();
      await execution.done;
      return;
    }

    const pending = current.turns.slice().reverse().find(turn => this.canRecover(current, turn));
    if (pending) {
      if (this.coordinator && this.sandbox?.interrupt) {
        await this.sandbox.interrupt(current, pending);
        return;
      }
      const recovery = this.reserveTurn(current);
      recovery.turnId = pending.id;
      try {
        recovery.controller.abort();
        this.executeTurn(current, pending, recovery, true);
        await recovery.done;
      } catch (error) { await recovery.finish(); throw error; }
      return;
    }

    if (this.coordinator && current.turns.some(turn => turn.status === 'running')) {
      throw new HttpError(409, '任务正在提交，请稍后重试停止');
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
      imageSelection: structuredClone(project.imageSelection), sandbox: structuredClone(project.sandbox), updatedAt: project.updatedAt };
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
    return `/api/projects/${encodeURIComponent(projectId)}/service/${port}${url.pathname}${url.search}${url.hash}`;
  }

  async projectService(projectId: string, port: number, path: string, request: Request): Promise<Response> {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new HttpError(400, '服务端口无效');
    await this.ensureProjectSandbox(projectId);
    const project = this.projects.get(projectId);
    if (!project.sandbox || !this.sandbox?.service) throw new HttpError(503, 'Sandbox 服务代理未配置');
    const read = ['GET', 'HEAD'].includes(request.method) ? this.projects.beginRead(project.id) : undefined;
    const release = read?.release ?? this.projects.acquire(project.id);
    const signal = read ? AbortSignal.any([request.signal, read.signal]) : request.signal;
    try {
      const response = await this.sandbox.service(this.projectWorkspace(project), port, path, new Request(request, { signal }));
      signal.throwIfAborted();
      return holdResponse(response, release, signal);
    } catch (error) { release(); read?.signal.throwIfAborted(); throw error; }
  }

  async projectFileResponse(projectId: string, path: string, request: Request): Promise<Response> {
    if (this.closing) throw new HttpError(503, '服务正在关闭');
    await this.ensureProjectSandbox(projectId);
    const project = this.projects.get(projectId);
    if (!project.sandbox || !this.sandbox?.fileResponse) throw new HttpError(503, 'Sandbox 文件流接口未配置');
    const read = this.projects.beginRead(project.id);
    const signal = AbortSignal.any([request.signal, read.signal]);
    try {
      const response = await this.sandbox.fileResponse(this.projectWorkspace(project), path, new Request(request, { signal }));
      signal.throwIfAborted();
      return holdResponse(response, read.release, signal);
    } catch (error) { read.release(); read.signal.throwIfAborted(); throw error; }
  }

  async projectFile(projectId: string, path: string) {
    if (this.closing) throw new HttpError(503, '服务正在关闭');
    await this.ensureProjectSandbox(projectId);
    const project = this.projects.get(projectId);
    if (project.executionMode !== 'sandbox' || !this.sandbox) throw new HttpError(400, '此项目不使用 Sandbox 沙箱');
    if (!project.sandbox) throw new HttpError(409, '项目沙箱尚未创建，请先发送一条消息');
    const read = this.projects.beginRead(project.id);
    try {
      const result = await this.sandbox.file(this.projectWorkspace(project), path, read.signal);
      read.signal.throwIfAborted();
      return result;
    } catch (error) {
      read.signal.throwIfAborted();
      throw error;
    } finally { read.release(); }
  }

  async close() {
    this.closing = true;
    clearInterval(this.recoveryTimer);
    for (const poll of this.subscriptionPolls.values()) { clearInterval(poll.timer); poll.observation?.controller.abort(); }
    await Promise.allSettled([...this.subscriptionPolls.values()].map(poll => poll.pending));
    await Promise.allSettled([...this.subscriptionPolls.values()].map(poll => poll.observation?.done));
    this.subscriptionPolls.clear();
    await this.reconciling;
    await this.lifecycle?.close();
    await this.sandboxOperations?.close();
    await Promise.allSettled(this.danglingDeletions.values());
    const detachments: Promise<void>[] = [];
    for (const [id, execution] of this.active) {
      const session = this.sessions.get(id);
      const turn = session?.turns.find(turn => turn.id === execution.turnId);
      if (session?.settings.executionMode === 'sandbox' && turn && this.sandbox) {
        this.sandbox.detach(turn);
      } else execution.controller.abort();
    }
    await Promise.allSettled(detachments);
    await Promise.allSettled([...this.active.values()].map(execution => execution.done));
    try {
      await this.sandbox?.close();
      await Promise.all([this.writer.drain(), this.projects.close()]);
      await this.notifications?.close();
      await this.state.close();
    } finally { await this.logger?.flush(); }
  }
}
