import type { ModelService } from '../models/service.js';
import { traced, traceEvent } from '@co-cell/sandbox';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { mkdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve, sep, posix } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { PROJECT_OPERATION_WAIT_MS, type ProjectReadOptions, type Project, type ProjectSummary, type Session, type SessionSummary, type SessionTurnPage, type Settings, type StreamMessage, type SubagentConversation, type Turn } from '../../protocol/types.js';
import { CLAUDE_HOST_PORT, type ClaudeBoxClient } from '../execution/claude-box.js';
import type { SandboxRuntime, ServiceProxyAccess } from '../execution/container-runtime.js';
import { SandboxLifecycleService } from '../projects/sandbox-lifecycle.js';
import { ProjectSandboxOperations } from '../projects/sandbox-operations.js';
import { canAutoResumeProject } from '../../util/project-sandbox.js';
import type { ProjectResumeObserver } from '../../protocol/resume-types.js';
import type { RuntimeLog } from '../infra/diagnostics/runtime-log.js';

import { HttpError, redactCredentials } from '../../util/errors.js';
import { workspaceFileResult } from '../workspaces/files.js';
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
import { sandboxMounts } from '../../util/sandbox-mounts.js';
import { projectWeekOf } from '../../util/project-types.js';
import { appendAdditionalUserInput, collectNativeUserInputAnswers, withNativeUserInput, type NativeUserInputAnswers } from '../../util/user-input.js';
import type { SharedCoordinator, SharedLease } from '../infra/storage/coordination.js';
import { applyTurnEvent } from '../../util/session-events.js';
import type { InputRequestRecord, InputRequestType } from '../../protocol/input-request-types.js';
import type { InputRequestHook } from '../../packages/agentcore/src/index.mjs';
import { AppServerRpcError } from '../../packages/agentcore/src/index.mjs';
import type { NativeSessionConnection } from '../../protocol/native-app-server.js';
import type { NativeRelayEvent } from '../execution/native-relay.js';
import { sessionMetadata } from '../../util/session-metadata.js';
import type { CompactionContent, CompactionSelector } from '../../protocol/types.js';

export type { CodexClient } from '../execution/runner.js';
type Subscriber = (message: StreamMessage) => void;
type ActiveExecution = {
  controller: AbortController;
  done: Promise<void>;
  turnId?: string;
  steer?(text: string, onInputRequest?: InputRequestHook): Promise<boolean>;
  lease?: SharedLease;
  finish(): Promise<void>;
};
class NativeTurnAcceptancePending extends Error {}
class NativeTurnNotReceiving extends HttpError {
  constructor() { super(409, 'Codex 已不再接收当前任务的追加消息，请刷新会话后重试'); }
}
type SubscriptionWatch = {
  timer: ReturnType<typeof setInterval>;
  pending?: Promise<void>;
  last?: string;
  completedKey?: string;
  etag?: string;
  box?: string;
  snapshot?: Session;
  observation?: { key: string; controller: AbortController; done: Promise<void> };
};

function normalizeExecutionSettings(settings: Settings, owner?: Session['managedBy']): Settings {
  if (owner) return { ...settings, sandboxMode: owner.writable ? 'workspace-write' : 'read-only',
    networkAccessEnabled: false, webSearchMode: 'disabled' };
  // Sandbox is the isolation boundary; Codex inside it uses guidance rather than
  // another filesystem/network sandbox (toolchain caches live outside cwd).
  return settings.executionMode === 'sandbox'
    ? { ...settings, sandboxMode: 'danger-full-access', networkAccessEnabled: true }
    : settings;
}

export interface SandboxLifecycleOptions {
  onProjectCreate?: (projectId: string) => Promise<void>;
  requirementInfo?: (url: string) => Promise<{ name: string; status: string | null }>;
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
  private claudeReplyRecoveries = new Set<string>();
  private nativeReplyRecoveries = new Map<string, Promise<void>>();
  private inputTasks = new Set<Promise<void>>();
  private historyErrors = new Map<string, string>();
  private billingReads = new Map<string, Promise<SessionCostBreakdown>>();
  private savedSessions = new Map<string, Session>();
  private refreshing?: Promise<void>;
  private recoveryTimer?: ReturnType<typeof setInterval>;
  private reconciling?: Promise<void>;
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
    this.projects = new ProjectService(state, lifecycleOptions.requirementInfo, undefined, Boolean(coordinator), lifecycleOptions.onProjectCreate);
    if (sandbox) {
      this.sandboxOperations = new ProjectSandboxOperations({
        projects: this.projects, runtime: sandbox,
        captureHistoryIndex: id => this.projectHistoryIndex(id),
        assertClaudeIdle: project => this.assertClaudeProjectIdle(project),
        verifyClaude: async (box, handles) => {
          if (!this.claude) throw new HttpError(503, '无法验证 Claude 会话');
          for (const id of handles) await this.claude.verify(box, id);
        },
        saveSandbox: (id, value, restore, image, expectedId) => this.updateSandbox(id, id, value, restore, image, expectedId),
        selectRestoreImage: async (project, versionId) => this.imageCatalog
          ? this.imageCatalog.acquireRestoreSelection(project, versionId)
          : { selection: project.imageSelection, release() {} },
        logger: this.logger,
        released: async id => {
          for (const session of this.sessions.values()) {
            if (session.projectId !== id) continue;
            delete session.sandbox;
            await this.save(session);
            this.publish(session.id, { type: 'state', session: this.get(session.id) });
          }
        },
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
        },
      });
      this.lifecycle = new SandboxLifecycleService({
        ...lifecycleOptions,
        listProjects: () => this.listProjectsWithArchives(),
        reclaim: id => this.archiveCompletedProject(id),
      });
    }
  }

	get remoteArchives() { return this.sandbox?.remoteArchives; }
  private claude?: ClaudeBoxClient;
  setClaudeRuntime(client: ClaudeBoxClient) { this.claude = client; }
  private models?: ModelService;
  setModelService(models: ModelService) { this.models = models; }
  private projectFileReader?: import('../workspaces/project-file-reader.js').ProjectFileReader;
  setProjectFileReader(reader: import('../workspaces/project-file-reader.js').ProjectFileReader) { this.projectFileReader = reader; }
  setImageCatalog(catalog: ImageCatalog) { this.imageCatalog = catalog; }

  get sharedStateEnabled() { return Boolean(this.coordinator); }
  get nativeWebSocketEnabled() { return Boolean(this.sandbox?.prepareNativeSession && this.sandbox.openNativeConnection); }
  private isNativeSession(session: Session) { return session.agentKind !== 'claude-code' && this.nativeWebSocketEnabled && session.settings.executionMode === 'sandbox'; }

  private externalSession(session: Session) { return session.agentKind === 'claude-code' || this.isNativeSession(session); }

  async refreshSharedState(): Promise<void> {
    if (!this.coordinator || this.closing) return;
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      await this.projects.refresh(new Set(this.mutations.keys()));
      const baselines = new Map(this.savedSessions);
      const sessions = (await this.state.listSessions()).map(session => this.externalSession(session) ? sessionMetadata(session) : session);
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
          if (local?.turns.some(turn => turn.userInputRequests?.length)) {
            const before = JSON.stringify(local.turns.map(turn => turn.userInputRequests));
            await this.applyRecordedReplies(local);
            changed ||= before !== JSON.stringify(local.turns.map(turn => turn.userInputRequests));
          }
          if (changed) this.publish(id, { type: 'state', session: this.get(id) });
          return;
        }
        const protectedScope = () => this.active.has(id) || this.deleting.has(id)
          || this.mutations.has(`session:${id}`)
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

  private async sessionMutation<T>(id: string, action: () => Promise<T>, projectAdmission = true): Promise<T> {
    if (this.nativeWebSocketEnabled && !this.coordinator) await this.readMetadata(id);
    if (projectAdmission) {
      const session = this.sessions.get(id) ?? await this.state.getSession(id);
      if (session?.projectId) {
        await this.projects.refreshOne(session.projectId);
        this.projects.assertAvailable(session.projectId);
      }
    }
    if (!this.coordinator) return action();
    const session = await this.state.getSession(id);
    if (!session) throw new HttpError(404, '会话不存在');
    const mutate = () => this.coordinator!.run(`session-control:${id}`, async () => {
      if (!this.active.has(id)) await this.writer.run(id, async () => {
        const latest = await this.state.getSession(id);
        if (!latest) throw new HttpError(404, '会话不存在');
        if (this.active.has(id)) return;
        const local = this.sessions.get(id);
        this.savedSessions.set(id, structuredClone(latest));
        latest.turns = latest.turns.map(turn => {
          const old = local?.turns.find(value => value.id === turn.id);
          return old ? { ...old, ...turn, items: turn.items.length ? turn.items : old.items } : turn;
        });
        this.sessions.set(id, latest);
      });
      const scope = `session:${id}`;
      this.mutations.set(scope, (this.mutations.get(scope) ?? 0) + 1);
      try { return await action(); }
      finally {
        const count = this.mutations.get(scope)! - 1;
        if (count) this.mutations.set(scope, count); else this.mutations.delete(scope);
      }
    });
    return mutate();
  }

  private async recoverSharedExecutions() {
    if (!this.coordinator || this.nativeWebSocketEnabled || this.closing || this.reconciling) return;
    this.reconciling = (async () => {
      await this.refreshSharedState();
      for (const candidate of [...this.sessions.values()]) {
        if (this.closing || this.active.has(candidate.id)) continue;
        if (this.externalSession(candidate)) continue;
        const queued = (await this.state.listInputRequests?.(candidate.id) ?? [])
          .some(input => input.type === 'question_reply' && input.status === 'queued');
        if (!queued && !candidate.turns.some(turn => turn.status === 'running')) continue;
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
            await this.refreshSessionSandbox(session);
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
            this.executeTurn(session, turn, this.reserveTurn(session, lease), true);
          } catch (error) { await lease.release(); throw error; }
        });
      }
    })();
    try { await this.reconciling; } finally { this.reconciling = undefined; }
  }

  async init() {
    await this.state.init();
    await this.projects.init();
    for (const stored of await this.state.listSessions()) {
      const session = this.externalSession(stored) ? sessionMetadata(stored) : stored;
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
      const normalized = normalizeExecutionSettings(session.settings, session.managedBy);
      if (normalized.sandboxMode !== session.settings.sandboxMode || normalized.networkAccessEnabled !== session.settings.networkAccessEnabled) {
        session.settings = normalized;
        changed = true;
      }
      for (const turn of session.turns) {
        if (this.isNativeSession(session) && turn.status === 'running' && !turn.codexAccepted && !turn.nativeTurnId) {
          turn.status = 'cancelled';
          turn.error = '旧提交未确认，执行状态以 App Server 为准；未自动重发。';
          turn.completedAt = new Date().toISOString();
          changed = true;
        }
        if (!this.coordinator && !this.externalSession(session) && turn.status === 'running' && !this.canRecover(session, turn)) {
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
      if (!this.coordinator && !this.externalSession(session) && (session.status === 'running' || session.turns.some(turn => turn.status === 'running' || this.canRecover(session, turn)))) {
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
    const recoverable = [...this.sessions.values()].flatMap(session => {
      if (this.externalSession(session)) return [];
      const turn = session.turns.find(turn => this.canRecover(session, turn));
      return turn ? [{ session, turn }] : [];
    });
    if (!this.coordinator) for (const { session, turn } of recoverable) this.executeTurn(session, turn, this.reserveTurn(session), true);
    for (const session of this.sessions.values()) {
      if (!this.coordinator && !this.externalSession(session) && !this.active.has(session.id)
        && (await this.state.listInputRequests?.(session.id) ?? []).some(input => input.type === 'question_reply' && input.status === 'queued'))
        void this.startQueuedUserInput(session.id).catch(error => console.error('Queued input recovery failed:', error));
    }
    this.lifecycle?.start();
    if (this.coordinator && !this.nativeWebSocketEnabled) {
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

  /** Serialize bootstrap/binding metadata, never the lifetime of a native turn. */
  private async nativeControl<T>(id: string, action: () => Promise<T>, projectAdmission = true): Promise<T> {
    let result!: T;
    await this.writer.run(`native-control:${id}`, async () => { result = await this.sessionMutation(id, action, projectAdmission); });
    return result;
  }

  async nativeConnection(id: string, signal = new AbortController().signal): Promise<NativeSessionConnection> {
    return this.nativeControl(id, async () => {
      if (this.closing) throw new HttpError(503, '服务正在关闭');
      let session = await this.refreshSessionSandbox(await this.readMetadata(id));
      if (!this.isNativeSession(session)) throw new HttpError(409, '此会话不支持原生 WebSocket');
      if (session.archivedAt || (session.projectId && this.projects.get(session.projectId).status !== 'active'))
        throw new HttpError(409, '请先恢复项目和会话再继续对话');
      if (session.projectId && this.projects.get(session.projectId).sandboxOperation?.status === 'running')
        throw new HttpError(409, '项目环境操作进行中，请稍后再连接');
      if (session.projectId) await this.ensureProjectSandbox(session.projectId);
      session = this.lookup(id);
      const prepared = await this.sandbox!.prepareNativeSession!(structuredClone(session), signal,
        value => this.updateSandbox(session.projectId, id, value));
      session.threadId = prepared.threadId;
      await this.save(session);
      return { session: await this.readMetadata(id), threadId: prepared.threadId, threadOptions: prepared.threadOptions, turnOptions: prepared.turnOptions,
        websocketPath: `/api/sessions/${encodeURIComponent(id)}/app-server` };
    });
  }

  async openNativeConnection(id: string, signal: AbortSignal) {
    const session = await this.refreshSessionSandbox(await this.readMetadata(id));
    if (this.closing || !this.isNativeSession(session))
      throw new HttpError(409, '请先连接原生会话');
    if (session.archivedAt || (session.projectId && this.projects.get(session.projectId).status !== 'active'))
      throw new HttpError(409, '项目或会话已归档');
    if (session.projectId && this.projects.get(session.projectId).sandboxOperation?.status === 'running')
      throw new HttpError(409, '项目环境操作进行中，请稍后再连接');
    return { ...await this.sandbox!.openNativeConnection!(structuredClone(session), signal), sandboxId: session.sandbox?.id, managed: Boolean(session.managedBy), threadId: session.threadId };
  }

  /** Read the shared authority, including changes made through another API instance. */
  async canRenewNativeConnection(id: string, sandboxId: string | undefined): Promise<boolean> {
    if (this.closing || !sandboxId) return false;
    const session = await this.state.getSession(id);
    if (!session || session.archivedAt || !this.isNativeSession(session)) return false;
    if (!session.projectId) return session.sandbox?.id === sandboxId;
    const project = await this.state.getProject(session.projectId);
    return Boolean(project && project.status === 'active' && !project.removedAt
      && project.sandbox?.id === sandboxId && project.sandboxOperation?.status !== 'running');
  }

  async bindNativeThread(id: string, threadId: string): Promise<Session> {
    return this.nativeControl(id, async () => {
      const session = await this.refreshSessionSandbox(await this.readMetadata(id));
      if (this.closing || !this.isNativeSession(session) || session.archivedAt
        || (session.projectId && this.projects.get(session.projectId).status !== 'active'))
        throw new HttpError(409, '当前会话不可连接');
      if (session.threadId && session.threadId !== threadId)
        throw new HttpError(409, '会话已有原生对话，请刷新后继续');
      const metadata = await this.sandbox!.nativeRequest!(session, 'thread/read', { threadId, includeTurns: false });
      if (metadata.thread?.id !== threadId) throw new HttpError(409, '原生会话不存在');
      session.threadId = threadId;
      await this.save(session);
      return this.readMetadata(id);
    });
  }

  /** Observe activity and generate a title after Codex accepts a user message. */
  async observeNativeMessage(event: NativeRelayEvent): Promise<void> {
    if (event.direction !== 'server') return;
    const { method, params } = event.message;
    if (method === 'item/completed' && params?.item?.type === 'userMessage' && typeof params.threadId === 'string') {
      this.generateNativeTitle(event.sessionId, params.threadId);
      return;
    }
    if (!['turn/started', 'turn/completed'].includes(method ?? '')) return;
    await this.writer.run(event.sessionId, async () => {
      const session = await this.state.getSession(event.sessionId);
      if (!session || !this.isNativeSession(session) || session.threadId !== event.message.params?.threadId) return;
      if (event.receivedAt <= Date.parse(session.updatedAt)) return;
      const metadata = sessionMetadata(session);
      metadata.updatedAt = new Date(event.receivedAt).toISOString();
      await this.state.saveSession(metadata, sessionMetadata(session), true);
    });
  }

  private generateNativeTitle(id: string, threadId: string) {
    if (!this.state.replaceSessionTitle || !this.sandbox?.nativeRequest || this.closing) return;
    void this.updateNativeTitle(id, threadId).catch(() => {
      void this.logger?.write({ event: 'session.title_generation_failed', sessionId: id });
    });
  }

  private async updateNativeTitle(id: string, threadId: string) {
    const session = await this.state.getSession(id);
    if (!session || session.archivedAt || session.title !== '新任务' || session.threadId !== threadId) return;
    const { thread } = await this.sandbox!.nativeRequest!(session, 'thread/read', { threadId, includeTurns: false });
    const prompt = typeof thread?.preview === 'string' ? thread.preview.trim() : '';
    if (!prompt) return;
    const fallback = Array.from(prompt.slice(0, 4000).replace(/\s+/g, ' ')).slice(0, 60).join('').trimEnd();
    const initialTitle = fallback === session.title ? `「${fallback}」` : fallback;
    if (!await this.state.replaceSessionTitle!(id, threadId, session.title, initialTitle)) return;
    const title = await this.models?.generateSessionTitle(session.settings, prompt);
    if (title && title !== initialTitle && title !== session.title && !this.closing)
      await this.state.replaceSessionTitle!(id, threadId, initialTitle, title);
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

  private inputHook(input: InputRequestRecord): InputRequestHook {
    return async event => {
      input.method = event.method;
      input.params = structuredClone(event.params);
      if (event.threadRequest) input.threadRequest = structuredClone(event.threadRequest);
      input.status = event.phase;
      if (event.phase === 'sending') input.sentAt = new Date().toISOString();
      if (event.nativeTurnId) input.nativeTurnId = event.nativeTurnId;
      if (event.phase === 'accepted') input.acceptedAt = new Date().toISOString();
      if (event.error) input.error = event.error;
      await this.state.saveInputRequest?.(input);
    };
  }

  private async applyRecordedReplies(session: Pick<Session, 'id' | 'turns'>, preserveNativeAnswers = false): Promise<InputRequestRecord[]> {
    const inputs = await this.state.listInputRequests?.(session.id) ?? [];
    const replies: NativeUserInputAnswers = new Map();
    for (const input of inputs) {
      if (input.type !== 'question_reply' || input.status === 'failed') continue;
      collectNativeUserInputAnswers([{ id: input.turnId, prompt: input.input, images: [], items: [],
        status: 'completed', codexAccepted: true, startedAt: input.acceptedAt ?? input.createdAt }], replies);
    }
    for (const turn of session.turns) {
      const derived = withNativeUserInput(turn, replies);
      if (derived.userInputRequests) turn.userInputRequests = derived.userInputRequests.map(request => {
        const native = preserveNativeAnswers && turn.userInputRequests?.find(item => item.id === request.id && item.status === 'answered');
        if (native) return native;
        const matches = inputs.filter(input => input.type === 'question_reply' && input.requestId === request.id && input.status !== 'failed');
        const input = matches.find(input => input.status === 'accepted') ?? matches.at(-1);
        return input ? { ...request, status: input.status === 'accepted' ? 'answered' : 'queued', deliveryStatus: input.status } : request;
      });
    }
    return inputs;
  }

  private async queueInput(sessionId: string, turnId: string, input: string, type: InputRequestType,
    options: { id?: string; images?: string[]; requestId?: string } = {}): Promise<InputRequestRecord> {
    const request: InputRequestRecord = { id: options.id ?? randomUUID(), sessionId, turnId, type,
      input, images: options.images, requestId: options.requestId, status: 'queued', createdAt: new Date().toISOString() };
    await this.state.saveInputRequest?.(request);
    return request;
  }

  private async submitSteer(session: Session, turn: Turn, prompt: string,
    execution: ActiveExecution | undefined, input?: InputRequestRecord): Promise<boolean> {
    const request = input ?? await this.queueInput(session.id, turn.id, prompt, 'steer');
    request.turnId = turn.id;
    const hook = this.inputHook(request);
    try {
      const accepted = execution?.steer ? await execution.steer(prompt, hook)
        : this.sandbox?.steer ? await this.sandbox.steer(session, turn, prompt, hook) : false;
      // Runtimes implementing the generic SandboxRuntime interface can confirm
      // receipt without exposing a native RPC hook.
      if (accepted && request.status !== 'accepted') {
        request.status = 'accepted'; request.acceptedAt = new Date().toISOString(); request.nativeTurnId = turn.nativeTurnId;
        await this.state.saveInputRequest?.(request);
      } else if (!accepted && request.status === 'queued') {
        request.status = 'failed'; request.error = '当前轮次不再接收追加输入';
        await this.state.saveInputRequest?.(request);
      }
      return accepted;
    } catch (error) {
      if (request.status !== 'accepted' && request.status !== 'failed') {
        request.status = 'unknown'; request.error = error instanceof Error ? error.message : String(error);
        await this.state.saveInputRequest?.(request);
      }
      throw error;
    }
  }

  private executeTurn(session: Session, turn: Turn, execution: ActiveExecution, recovering = false, input?: InputRequestRecord) {
    const id = session.id;
    execution.turnId = turn.id;
    const running = runTurn(session, turn, execution.controller, {
      client: this.client, sandbox: this.sandbox, logger: this.logger, recovering,
      save: async () => {
        if (input) {
          if (turn.codexAccepted && input.status !== 'accepted') {
            input.status = 'accepted'; input.nativeTurnId = turn.nativeTurnId;
            input.acceptedAt = new Date().toISOString();
            await this.state.saveInputRequest?.(input);
          } else if (turn.status !== 'running' && ['queued', 'sending'].includes(input.status)) {
            input.status = input.status === 'sending' ? 'unknown' : 'failed'; input.error = turn.error;
            await this.state.saveInputRequest?.(input);
          }
        }
        await this.save(session);
      }, publish: message => this.publish(id, message), snapshot: () => this.get(id),
      updateSandbox: sandbox => this.updateSandbox(session.projectId, id, sandbox),
      onSteer: steer => { execution.steer = steer; },
      onInputRequest: input ? this.inputHook(input) : undefined,
      canPersist: () => !execution.lease?.signal.aborted,
    }).finally(async () => {
      if (execution.lease?.signal.aborted) { await execution.finish(); return; }
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
    const metadata = await this.readMetadata(id);
    if (metadata.agentKind === 'claude-code') {
      await this.claudeControl(metadata, async (client, session, box) => {
        const selected = await this.boundClaudeModel(session);
        await client.answer(box, session, selected, turnId, requestId, answers ?? [answer]);
        session.updatedAt = new Date().toISOString();
        await this.save(session);
      });
      return this.read(id);
    }
    if (this.isNativeSession(metadata)) {
      let result!: Session;
      const submit = () => this.writer.run(`native-input:${id}`, async () => {
        result = await this.answerNativeUserInput(id, turnId, requestId, answer, answers);
      });
      if (this.coordinator) await this.coordinator.run(`session-input:${id}`, submit);
      else await submit();
      return result;
    }
    return this.sessionMutation(id, () => this.answerUserInputLocal(id, turnId, requestId, answer, answers));
  }

  private async answerNativeUserInput(id: string, turnId: string, requestId: string, answer: string, answers?: string[]): Promise<Session> {
    const session = await this.read(id);
    if (session.historyError || !session.threadId) throw new HttpError(409, '无法确认会话历史，请稍后重试');
    let request = session.turns.find(turn => turn.id === turnId || turn.nativeTurnId === turnId)
      ?.userInputRequests?.find(value => value.id === requestId);
    const answersFromHistory: NativeUserInputAnswers = new Map();
    collectNativeUserInputAnswers(session.turns, answersFromHistory);
    let cursor = session.historyNextCursor;
    const cursors = new Set<string>();
    while (!request && cursor) {
      if (cursors.has(cursor)) throw new HttpError(502, 'Codex 返回重复的历史游标');
      cursors.add(cursor);
      const page = await this.olderTurns(id, cursor);
      collectNativeUserInputAnswers(page.turns, answersFromHistory);
      request = page.turns.map(turn => withNativeUserInput(turn, answersFromHistory))
        .find(turn => turn.id === turnId || turn.nativeTurnId === turnId)?.userInputRequests?.find(value => value.id === requestId);
      cursor = page.nextCursor;
    }
    if (!request) throw new HttpError(404, '问题不存在');
    const values = answers ?? [answer];
    if (values.length !== request.questions.length) throw new HttpError(400, '请回答所有问题');
    const prompt = '<send_user_message_question_reply>\n' + JSON.stringify(request.questions.map((question, index) => ({
      answer: values[index], question: question.title, questionItemId: JSON.stringify(['request_user_input_async', request.id, index]),
    }))) + '\n</send_user_message_question_reply>';
    if (!this.state.saveInputRequest || !this.state.listInputRequests) throw new HttpError(503, '无法保存回答投递状态');
    const previous = (await this.state.listInputRequests(id)).find(input => input.type === 'question_reply'
      && input.requestId === requestId && input.status !== 'failed');
    if (previous) {
      if (previous.input !== prompt) throw new HttpError(409, '该问题已有待投递或结果未确认的回答');
      if (previous.status !== 'queued') {
        if (previous.status === 'accepted') return session;
        if (request.status === 'answered') {
          previous.status = 'accepted'; previous.acceptedAt = new Date().toISOString();
          await this.state.saveInputRequest(previous);
          return this.read(id);
        }
        if (await this.reconcileNativeQuestionReply(session, previous)) return this.read(id);
        throw new HttpError(409, '回答的接收状态尚未确认，请检查会话后再试');
      }
    } else if (request.status !== 'pending') throw new HttpError(409, '问题已经回答');

    const submission = previous ?? await this.queueInput(id, turnId, prompt, 'question_reply', { requestId });
    const latest = await this.sandbox!.history(structuredClone(session), { limit: 1 });
    const running = latest.turns.find(turn => turn.status === 'running');
    const sourceRunning = running && (running.id === turnId || running.nativeTurnId === turnId);
    await this.deliverNativeQuestionReply(session, submission, sourceRunning ? running.id : undefined);
    return this.read(id);
  }

  private async deliverNativeQuestionReply(session: Session, submission: InputRequestRecord, sourceTurnId?: string): Promise<void> {
    const input = [{ type: 'text', text: submission.input, text_elements: [] }];
    const method = sourceTurnId ? 'turn/steer' : 'thread/queue/add';
    const params = sourceTurnId
      ? { threadId: session.threadId, expectedTurnId: sourceTurnId, input }
      : { threadId: session.threadId, clientUserMessageId: submission.id, input };
    submission.method = method;
    submission.params = params;
    submission.status = 'sending';
    submission.sentAt = new Date().toISOString();
    await this.state.saveInputRequest!(submission);
    try {
      const result = await this.sandbox!.nativeRequest!(session, method, params);
      if (sourceTurnId ? result.turnId !== sourceTurnId
        : !result.queuedSubmission?.id || result.queuedSubmission.clientUserMessageId !== submission.id) {
        throw new Error('Codex 未返回匹配的回答接收标识');
      }
    } catch (error) {
      submission.status = error instanceof AppServerRpcError ? 'failed' : 'unknown';
      submission.error = error instanceof Error ? error.message : String(error);
      await this.state.saveInputRequest!(submission);
      if (sourceTurnId && error instanceof AppServerRpcError && /no active turn|expected.*turn|turn.*mismatch/i.test(error.rpc.message)) {
        const queued = await this.queueInput(session.id, submission.turnId, submission.input, 'question_reply', { requestId: submission.requestId });
        await this.deliverNativeQuestionReply(session, queued);
        return;
      }
      throw error;
    }
    submission.status = 'accepted';
    submission.acceptedAt = new Date().toISOString();
    if (sourceTurnId) submission.nativeTurnId = sourceTurnId;
    await this.state.saveInputRequest!(submission);
  }

  private async reconcileNativeQuestionReply(session: Session, input: InputRequestRecord): Promise<boolean> {
    const history = await this.sandbox!.history(structuredClone(session), { limit: 20 });
    let observed = history.turns.some(turn => turn.codexAccepted
      && (turn.prompt === input.input || turn.additionalUserInputs?.includes(input.input)));
    if (!observed && input.method === 'thread/queue/add') {
      let cursor: string | undefined;
      const cursors = new Set<string>();
      do {
        const queued = await this.sandbox!.nativeRequest!(session, 'thread/queue/list',
          { threadId: session.threadId, limit: 100, ...(cursor ? { cursor } : {}) });
        if (!Array.isArray(queued.data)) throw new HttpError(502, 'Codex 未返回排队中的消息');
        observed = queued.data.some((item: { clientUserMessageId?: string }) => item.clientUserMessageId === input.id);
        cursor = queued.nextCursor ?? undefined;
        if (cursor && cursors.has(cursor)) throw new HttpError(502, 'Codex 返回重复的队列游标');
        if (cursor) cursors.add(cursor);
      } while (!observed && cursor);
    }
    if (observed) {
      input.status = 'accepted'; input.acceptedAt = new Date().toISOString();
      await this.state.saveInputRequest!(input);
    }
    return observed;
  }

  /** Recover unsent replies and reconcile uncertain ones only when a session is read. */
  private recoverNativeQuestionReplies(id: string): void {
    if (this.closing || this.nativeReplyRecoveries.has(id)) return;
    const recover = () => this.writer.run(`native-input:${id}`, async () => {
      const session = await this.refreshSessionSandbox(await this.readMetadata(id));
      if (!this.isNativeSession(session) || !session.threadId || session.archivedAt || !session.sandbox) return;
      if (session.projectId) {
        const project = this.projects.get(session.projectId);
        if (project.status !== 'active' || project.removedAt) return;
      }
      const inputs = await this.state.listInputRequests?.(id) ?? [];
      for (const input of inputs) {
        if (this.closing || input.type !== 'question_reply') continue;
        if (input.status === 'sending' || input.status === 'unknown') {
          await this.reconcileNativeQuestionReply(session, input);
          continue;
        }
        if (input.status !== 'queued') continue;
        const history = await this.sandbox!.history(structuredClone(session), { limit: 1 });
        const running = history.turns.find(turn => turn.status === 'running');
        const sourceRunning = running && (running.id === input.turnId || running.nativeTurnId === input.turnId);
        await this.deliverNativeQuestionReply(session, input, sourceRunning ? running.id : undefined);
      }
    });
    const task = (this.coordinator ? this.coordinator.run(`session-input:${id}`, recover) : recover())
      .catch(error => { void this.logger?.write({ event: 'session.native_reply_recovery_failed', sessionId: id, error }); })
      .finally(() => { this.nativeReplyRecoveries.delete(id); });
    this.nativeReplyRecoveries.set(id, task);
    this.inputTasks.add(task);
    void task.finally(() => this.inputTasks.delete(task));
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
    const submissions = await this.state.listInputRequests?.(id) ?? [];
    if (submissions.some(input => input.requestId === requestId && ['queued', 'sending', 'accepted', 'unknown'].includes(input.status)))
      throw new HttpError(409, '问题已回答或答案接收状态待确认');
    if (request.status !== 'pending') throw new HttpError(409, '问题已经回答');
    if (answers && answers.length !== request.questions.length) throw new HttpError(400, '请回答所有问题');
    if (!answers && request.questions.length > 1) throw new HttpError(400, '请分别回答所有问题');
    const values = answers ?? [answer];
    const prompt = '<send_user_message_question_reply>\n' + JSON.stringify(request.questions.map((question, index) => ({
      answer: values[index], question: question.title,
      questionItemId: JSON.stringify(['request_user_input_async', request.id, index]),
    }))) + '\n</send_user_message_question_reply>';
    await this.queueInput(id, questionTurn.id, prompt, 'question_reply', { requestId });
    request.answers = values; request.answer = answer; request.status = 'queued';
    request.answeredAt = new Date().toISOString();
    this.publish(id, { type: 'state', session: this.get(id) });
    await this.startQueuedUserInputLocal(id);
    const snapshot = this.get(id);
    if (!snapshot.turns.some(turn => turn.id === questionTurn.id)) snapshot.turns.unshift(structuredClone(questionTurn));
    return snapshot;
  }

  private async startQueuedUserInput(id: string): Promise<void> {
    if (this.closing) return;
    const task = this.sessionMutation(id, () => this.startQueuedUserInputLocal(id));
    this.inputTasks.add(task);
    try { await task; } finally { this.inputTasks.delete(task); }
  }

  private async startQueuedUserInputLocal(id: string): Promise<void> {
    if (this.closing) return;
    const pending = this.userInputDeliveries.get(id);
    if (pending) { await pending; return; }
    const delivery = this.deliverQueuedUserInput(id);
    this.userInputDeliveries.set(id, delivery);
    try { await delivery; }
    finally { if (this.userInputDeliveries.get(id) === delivery) this.userInputDeliveries.delete(id); }
  }

  private async deliverQueuedUserInput(id: string) {
    const submissions = await this.state.listInputRequests?.(id) ?? [];
    for (const input of submissions) {
      if (input.type !== 'question_reply' || input.status !== 'queued' || this.closing) continue;
      if (this.active.get(id)?.turnId === input.id) continue;
      let turnId: string;
      try { turnId = await this.startTurnLocal(id, input.input, input.images ?? [], input); }
      catch (error) {
        if (error instanceof NativeTurnNotReceiving) {
          // A definitive rejection is a completed RPC attempt, not an unknown
          // delivery. Keep it and queue a new attempt for the owner's finalizer.
          await this.queueInput(id, input.turnId, input.input, 'question_reply', { requestId: input.requestId });
          if (!this.active.has(id) && !this.lookup(id).turns.some(turn => turn.status === 'running'))
            await this.deliverQueuedUserInput(id);
          return;
        }
        const failed = this.lookup(id).turns.flatMap(turn => turn.userInputRequests ?? [])
          .find(request => request.id === input.requestId);
        if (failed) { failed.status = 'pending'; delete failed.answer; delete failed.answers; delete failed.answeredAt; }
        throw error;
      }
      const session = this.lookup(id);
      const request = session.turns.flatMap(turn => turn.userInputRequests ?? []).find(request => request.id === input.requestId);
      if (request) { request.status = 'answered'; request.answerTurnId = turnId; }
      this.publish(id, { type: 'state', session: this.get(id) });
      // A newly started native turn has not been accepted yet. Its finalizer
      // will drain any further queued replies after releasing execution.
      if (this.active.get(id)?.turnId === input.id) return;
    }
  }

  async readMetadata(id: string): Promise<Session> {
    if (this.deleting.has(id)) throw new HttpError(409, '会话正在删除');
    let stored = await this.state.getSession(id);
    if (!stored) throw new HttpError(404, '会话不存在');
    if (this.externalSession(stored)) stored = sessionMetadata(stored);
    if (stored.projectId) await this.projects.refreshOne(stored.projectId);
    if (this.active.has(id) && !this.isNativeSession(stored)) return this.get(id);
    // Legacy synchronous helpers receive a request-local baseline, never an observer update.
    this.sessions.set(id, stored);
    this.savedSessions.set(id, structuredClone(stored));
    return structuredClone(stored);
  }

  async listStored(): Promise<SessionSummary[]> {
    const sessions = (await this.state.listSessions()).map(session => this.externalSession(session) ? sessionMetadata(session) : session);
    return sessions.map(stored => this.active.has(stored.id) && !this.isNativeSession(stored)
      ? this.get(stored.id) : stored)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map(({ turns, ...session }) => this.externalSession({ ...session, turns }) ? session
        : { ...session, turnCount: turns.length });
  }

  list(): SessionSummary[] {
    return [...this.sessions.values()].map(session => this.hydrate(session)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map(({ turns, ...session }) => structuredClone(this.externalSession({ ...session, turns }) ? session
        : { ...session, turnCount: turns.length }));
  }

  private async liveProject(project: Project, allowUnknown = false): Promise<Project> {
    if (project.sandbox) project.sandbox = await querySandbox(this.sandbox, project.sandbox, allowUnknown);
    return project;
  }

  async readProject(id: string, options: ProjectReadOptions = {}, signal?: AbortSignal): Promise<ProjectSummary> {
    signal?.throwIfAborted();
    const project = options.waitForOperation
      ? await traced('project.wait', { 'operation.id': options.waitForOperation },
        () => this.waitForProjectOperation(id, options.waitForOperation!, options.waitMs ?? PROJECT_OPERATION_WAIT_MS, signal))
      : await this.state.getProject(id);
    signal?.throwIfAborted();
    if (!project || project.removedAt) throw new HttpError(404, '项目不存在');
    if (options.waitForOperation) traceEvent('project.wait.finished');
    // Operation results and the current Cellbox observation are independent.
    return this.projectSummary(await this.liveProject(project, true));
  }

  private async waitForProjectOperation(id: string, operationId: string, waitMs: number,
    signal?: AbortSignal): Promise<Project | undefined> {
    const deadline = Date.now() + Math.max(0, waitMs);
    while (true) {
      signal?.throwIfAborted();
      if (this.closing) throw new HttpError(503, '服务正在关闭');
      const project = await this.state.getProject(id);
      if (!project || project.removedAt || project.sandboxOperation?.id !== operationId || project.sandboxOperation.status !== 'running') return project;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return project;

      await delay(Math.min(250, remaining), undefined, { signal }).catch(error => {
        signal?.throwIfAborted();
        throw error;
      });
    }
  }

  async snapshot(id: string): Promise<Session> {
    const session = await this.refreshSessionSandbox(await this.readMetadata(id));
    if (session.sandbox) session.sandbox = await querySandbox(this.sandbox, session.sandbox, true);
    return session;
  }

  get(id: string): Session {
    const session = this.lookup(id);
    const turns = session.settings.executionMode === 'sandbox' ? session.turns.slice(-1) : session.turns;
    return structuredClone({ ...session, turns, historyError: this.historyErrors.get(id) });
  }
  /** Browser and API connections own observations. Only the Box owns the ACP process. */
  private async claudeControl<T>(metadata: Session, action: (client: ClaudeBoxClient, session: Session, box: string) => Promise<T>): Promise<T> {
    if (!this.claude || !metadata.projectId) throw new HttpError(503, 'Claude Code 尚未配置');
    const client = this.claude;
    let result!: T;
    await this.withProjectOperation(metadata.projectId, async () => {
      await this.ensureProjectSandbox(metadata.projectId!);
      result = await this.nativeControl(metadata.id, async () => {
        const session = this.lookup(metadata.id);
        const project = this.projects.get(metadata.projectId!);
        if (this.closing || session.archivedAt || project.status !== 'active' || !project.sandbox || project.sandboxOperation?.status === 'running')
          throw new HttpError(409, '项目或会话当前不可执行');
        return action(client, session, project.sandbox.id);
      });
    });
    return result;
  }

  private get claudeModels(): ModelService {
    if (!this.models) throw new HttpError(503, '模型管理尚未初始化');
    return this.models;
  }

  private async boundClaudeModel(session: Session) {
    const selected = await this.claudeModels.claudeSelection(session.settings);
    // Pin a legacy name-only session once its channel can be identified unambiguously.
    if (!session.settings.modelEntryId) {
      session.settings.modelEntryId = selected.modelEntryId;
      await this.save(session);
    }
    return selected;
  }

  private recoverQueuedClaudeAnswers(session: Session) {
    if (this.closing || !this.claude || session.archivedAt || this.claudeReplyRecoveries.has(session.id)) return;
    this.claudeReplyRecoveries.add(session.id);
    const task = this.claudeControl(session, async (client, current, box) =>
      client.reconcile(box, current, await this.boundClaudeModel(current)))
      .catch(error => { void this.logger?.write({ event: 'session.claude_answer_recovery_failed', sessionId: session.id, error }); })
      .finally(() => this.claudeReplyRecoveries.delete(session.id));
    this.inputTasks.add(task);
    void task.finally(() => this.inputTasks.delete(task));
  }

  private async readClaudeSession(metadata: Session, watch?: SubscriptionWatch): Promise<Session> {
    const session = await this.refreshSessionSandbox(metadata);
    if (!session.threadId) return { ...session, turns: [], status: 'idle' };
    try {
      if (!session.sandbox || !this.claude) throw new Error('Sandbox 不可用');
      session.sandbox = await querySandbox(this.sandbox, session.sandbox, true);
      if (session.sandbox.status !== 'ready') throw new Error('请先恢复项目 Sandbox');
      const box = session.sandbox.id;
      const result = await this.claude.snapshot(box, session.id, watch?.box === box && watch.snapshot?.updatedAt === session.updatedAt ? watch.etag : undefined);
      if (!result && watch?.snapshot) return watch.snapshot;
      if (!result) throw new Error('缺少 Claude 会话快照');
      const turns = result.snapshot.turns;
      if (!turns.some(turn => turn.status === 'running') && turns.some(turn =>
        turn.userInputRequests?.some(request => request.deliveryStatus === 'queued'))) this.recoverQueuedClaudeAnswers(session);
      const view = { ...session, turns, turnCount: turns.length, historyNextCursor: null,
        status: turns.some(t => t.status === 'running') ? 'running' as const : turns.at(-1)?.status ?? 'idle' as const };
      if (watch) { watch.etag = result.etag; watch.box = box; watch.snapshot = view; }
      return view;
    } catch (error) {
      if (watch) watch.etag = undefined;
      const turns = watch?.box === session.sandbox?.id ? watch?.snapshot?.turns ?? [] : [];
      return { ...session, status: 'unknown', turns, historyError: error instanceof Error ? error.message : 'Claude 会话暂时不可用' };
    }
  }

  private async readNativeSession(metadata: Session): Promise<Session> {
    const session = await this.refreshSessionSandbox(metadata);
    if (!session.threadId) return { ...sessionMetadata(session), historyNextCursor: null };
    try {
      const page = await this.readSandboxHistory(session, { limit: 20 });
      const turns = page.turns.map(turn => withNativeUserInput(turn)).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
      const answers: NativeUserInputAnswers = new Map();
      collectNativeUserInputAnswers(turns, answers);
      const result = { ...sessionMetadata(session), turns: turns.map(turn => withNativeUserInput(turn, answers)),
        status: turns.some(turn => turn.status === 'running') ? 'running' : turns.at(-1)?.status ?? 'idle',
        historyNextCursor: page.nextCursor ?? null } as Session;
      const inputs = await this.applyRecordedReplies(result, true);
      if (inputs.some(input => input.type === 'question_reply' && ['queued', 'sending', 'unknown'].includes(input.status)))
        this.recoverNativeQuestionReplies(session.id);
      return result;
    } catch (error) {
      if (error instanceof HttpError && error.status === 409) throw error;
      void this.logger?.write({ event: 'session.native_history_failed', sessionId: session.id, error });
      return { ...sessionMetadata(session), historyNextCursor: null,
        historyError: '历史消息暂时无法从 Codex 加载，请确认项目 Sandbox 可用后刷新重试。' };
    }
  }

  async read(id: string): Promise<Session> {
    const session = await this.readMetadata(id);
    if (session.agentKind === 'claude-code') return this.readClaudeSession(session);
    if (this.isNativeSession(session)) return this.readNativeSession(session);
    if (session.settings.executionMode === 'sandbox') {
      const snapshot = await this.snapshot(id);
      if (!session.threadId) {
        this.historyErrors.delete(id);
        return { ...snapshot, turns: session.turns.filter(turn => turn.status === 'running' || turn.type), historyNextCursor: null,
          historyError: undefined };
      }
      if (session.projectId && (!this.projects.get(session.projectId).sandbox)) {
        const historyError = '项目 Sandbox 尚未恢复，暂时无法加载历史消息。';
        this.historyErrors.set(id, historyError);
        return { ...snapshot, turns: session.turns.filter(turn => turn.status === 'running'), historyNextCursor: null,
          historyError };
      }
      try {
        const page = await this.readSandboxHistory(session, { limit: 20 });
        this.historyErrors.delete(id);
        const nativeSession = this.isNativeSession(session);
        const turns = page.turns.map(native => {
          const current = session.turns.find(turn => turn.nativeTurnId === native.id || turn.id === native.id);
          return withNativeUserInput(current ? { ...native, ...current, nativeTurnId: native.id,
            ...(nativeSession ? { status: native.status, completedAt: native.completedAt, error: native.error, phase: undefined, retry: undefined } : {}),
            // Native history owns message order, including the absence of steers.
            // Accepted request rows can describe the prompt that started this turn.
            additionalUserInputs: nativeSession ? native.additionalUserInputs : native.additionalUserInputs ?? current.additionalUserInputs,
            additionalUserInputPositions: nativeSession || native.additionalUserInputs ? native.additionalUserInputPositions : current.additionalUserInputPositions,
            prompt: current.prompt || native.prompt, items: native.items.map(item => ({ ...current.items.find(old => old.id === item.id), ...item })).concat(current.items.filter(item => !native.items.some(other => other.id === item.id))),
            ...(current.userInputRequests ? { userInputRequests: current.userInputRequests } : {}) } : native);
        });
        const live = session.turns.filter(turn => turn.status === 'running');
        for (const turn of live) if (!turns.some(candidate => candidate.id === turn.id)) turns.push(turn);
        turns.sort((left, right) => left.startedAt.localeCompare(right.startedAt));
        const result = { ...snapshot,
          ...(this.isNativeSession(session) ? { status: turns.some(turn => turn.status === 'running') ? 'running' as const : turns.at(-1)?.status ?? 'idle' as const } : {}),
          turns: this.withUserInputHistory(session, turns), historyNextCursor: page.nextCursor ?? null, historyError: undefined };
        await this.applyRecordedReplies(result);
        return result;
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
    const session = await this.readMetadata(id);
    if (session.agentKind === 'claude-code' || session.settings.executionMode !== 'sandbox' || !session.threadId) throw new HttpError(400, '此会话没有可分页的 Sandbox 历史');
    const page = await this.readSandboxHistory(session, { cursor, limit: 20 });
    if (this.isNativeSession(session)) {
      const result = { turns: page.turns.map(turn => withNativeUserInput(turn)).sort((a, b) => a.startedAt.localeCompare(b.startedAt)), nextCursor: page.nextCursor ?? null };
      await this.applyRecordedReplies({ id, turns: result.turns }, true);
      return result;
    }
    const result = { turns: this.withUserInputHistory(session, page.turns.map(turn => withNativeUserInput({ ...turn,
      userInputRequests: session.turns.find(old => old.id === turn.id || old.nativeTurnId === turn.id)?.userInputRequests ?? turn.userInputRequests,
    })).sort((left, right) => left.startedAt.localeCompare(right.startedAt))), nextCursor: page.nextCursor ?? null };
    await this.applyRecordedReplies({ id, turns: result.turns });
    return result;
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

  async compaction(id: string, selector: CompactionSelector, threadId?: string, signal?: AbortSignal): Promise<CompactionContent> {
    const session = await this.refreshSessionSandbox(await this.readMetadata(id));
    if (session.agentKind === 'claude-code') throw new HttpError(404, 'Claude 会话暂不提供压缩详情');
    if (!session.threadId) throw new HttpError(404, '会话没有原生线程');
    const read = this.projects.beginRead(session.projectId);
    const waiting = signal ? AbortSignal.any([signal, read.signal]) : read.signal;
    try {
      let result: CompactionContent | undefined;
      if (session.settings.executionMode === 'sandbox') {
        if (!this.sandbox?.compaction) throw new HttpError(503, '当前运行环境不支持读取压缩内容');
        result = await this.sandbox.compaction(session, selector, threadId, waiting);
      } else {
        const childThread = threadId && threadId !== session.threadId;
        if (childThread) {
          const children = await readSubagentConversations(session.threadId, process.env.CODEX_HOME || join(homedir(), '.codex'));
          if (!children.some(child => child.threadId === threadId)) throw new HttpError(404, '此线程不属于当前会话');
        }
        result = (await readNativeHistory(threadId ?? session.threadId, undefined, false, childThread ? undefined : session.startedAt,
          childThread ? undefined : session.nativeHistoryPath, selector)).compaction;
      }
      waiting.throwIfAborted();
      if (!result) throw new HttpError(404, '压缩内容尚未保存或已不可用，请稍后重试');
      return result;
    } finally { read.release(); }
  }

  async subagents(id: string): Promise<SubagentConversation[]> {
    const session = await this.refreshSessionSandbox(await this.readMetadata(id));
    if (session.agentKind === 'claude-code' || !session.threadId) return [];
    if (session.settings.executionMode === 'sandbox') {
      if (!session.sandbox) return [];
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
    const session = await this.readMetadata(id);
    if (session.agentKind === 'claude-code') throw new HttpError(422, 'Claude 会话暂不提供费用估算');
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
      await this.refreshSessionSandbox(session);
      if (session.projectId && !session.sandbox) throw new HttpError(409, '项目环境已切换，请刷新重试');
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
      return { ...turn, id: stored.id, type: stored.type, nativeTurnId: turn.id, sdkUsage: stored.sdkUsage,
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

  private async refreshSessionSandbox(session: Session): Promise<Session> {
    if (session.projectId) await this.projects.refreshOne(session.projectId);
    return this.hydrate(session);
  }

  listProjects(): ProjectSummary[] {
    return [...this.projects.list()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(project => this.projectSummary(project));
  }

  async listProjectsWithArchives(): Promise<ProjectSummary[]> {
    const summaries = (await this.state.listProjects()).filter(project => !project.removedAt)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(project => this.projectSummary(project));
    let backupPolicy: ProjectSummary['backupPolicy'];
    let backupPolicyError: string | undefined;
    if (this.remoteArchives?.policy) {
      try { backupPolicy = await this.remoteArchives.policy(); }
      catch (error) { backupPolicyError = error instanceof Error ? error.message : 'Cellbox 备份策略暂不可用'; }
    }
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
    return summaries.map(project => ({ ...project, ...(backupPolicy ? { backupPolicy } : {}),
      ...(backupPolicyError ? { backupPolicyError } : {}) }));
  }

  /** The directory is a product index. Refresh native versions only for its selected project. */
  async listArchiveProjects(archiveKey?: string): Promise<ProjectSummary[]> {
    const projects = this.projects.list({ includeRemoved: true });
    if (!archiveKey) return projects.map(project => this.projectSummary(project));
    const project = projects.find(project => project.remoteArchives?.some(ref => ref.id === archiveKey));
    if (!project) return [];
    const references = this.remoteArchives?.list
      ? await this.remoteArchives.list(this.projectWorkspace(project), project.remoteArchives ?? [])
      : project.remoteArchives ?? [];
    return [this.projectSummary({ ...project, remoteArchives: references })];
  }

  private projectSummary(project: Project): ProjectSummary {
    return structuredClone({ ...project, status: project.status ?? (project.archivedAt ? 'archived' : 'active'), archivedAt: project.archivedAt ?? null, sessionCount: [...this.sessions.values()].filter(session => session.projectId === project.id).length,
      latestBackup: project.latestBackup,
      archiveVersions: project.remoteArchives?.map((archive, index, all) => ({
        id: archive.id, version: all.length - index, createdAt: archive.createdAt,
        ...(archive.sizeBytes === undefined ? {} : { sizeBytes: archive.sizeBytes }),
        ...(archive.storageType === 'cellbox-volume' && archive.addedBytes !== undefined ? { bytesAdded: archive.addedBytes } : {}),
        browsable: archive.storageType !== 'cellbox-volume', storageType: archive.storageType ?? 'cellbox', label: `版本 ${all.length - index}`,
      })),
      activeSessionId: this.projects.activeSessionId(project.id)
        ?? [...this.sessions.values()].find(session => session.projectId === project.id && session.status === 'running')?.id ?? null });
  }

  getProject(id: string): ProjectSummary {
    const project = this.projects.get(id);
    if (project.removedAt) throw new HttpError(404, '项目不存在');
    return this.projectSummary(project);
  }

  async createProject(input: ProjectInput, settings?: Settings): Promise<ProjectSummary> {
    return this.createProjectLocal(input, settings);
  }

  private async createProjectLocal(input: ProjectInput, settings?: Settings): Promise<ProjectSummary> {
    if (this.closing) throw new HttpError(503, '服务正在关闭');
    const valid = await this.validateSettings(settings ?? { ...this.defaults, executionMode: 'sandbox', workingDirectory: this.defaults.executionMode === 'sandbox' ? this.defaults.workingDirectory : this.sandboxWorkingDirectory });
    const project = await this.projects.create(input, valid);
    if (project.executionMode === 'sandbox') await this.submitProjectSandboxOperation(project.id, 'create');
    return this.readProject(project.id);
  }

  async updateProject(id: string, input: ProjectUpdate): Promise<ProjectSummary> {
    if (input.status !== undefined) {
      // A restore-to-active request must serialize with automatic archival,
      // including across API replicas. Ordinary metadata edits remain available.
      await this.withProjectOperation(id, async () => { await this.projects.update(id, input); });
      return this.readProject(id);
    }
    return this.updateProjectLocal(id, input);
  }

  private async updateProjectLocal(id: string, input: ProjectUpdate): Promise<ProjectSummary> {
    await this.projects.update(id, input);
    return this.readProject(id);
  }

  async rebuildProjectSandbox(id: string, imageVersionId?: string): Promise<ProjectSummary> {
    await this.projects.refreshOne(id);
    const project = await this.liveProject(this.projects.get(id));
    if (project.sandbox?.status === 'paused') throw new HttpError(409, 'Sandbox 已暂停，请恢复运行');
    if (project.sandbox?.status === 'starting' && !project.sandbox.creation) throw new HttpError(409, 'Sandbox 正在切换状态，请稍后重试');
    if (project.sandbox?.status === 'ready' && !project.sandbox.creation && !(project.sandboxOperation?.status === 'failed' && ['create', 'resume', 'rebuild'].includes(project.sandboxOperation.kind))) {
      throw new HttpError(409, 'Sandbox 已就绪，无需重建');
    }
    const kind = project.status === 'archived' ? 'restore' : !project.sandbox || project.sandbox.creation ? 'create' : 'rebuild';
    await this.submitProjectSandboxOperation(id, kind, { imageVersionId });
    return this.readProject(id);
  }

  async createProjectSandbox(id: string): Promise<ProjectSummary> {
    await this.projects.refreshOne(id);
    const project = this.projects.get(id);
    if (project.sandbox && !project.sandbox.creation) throw new HttpError(409, '项目已有 Sandbox，请查看当前资源状态。');
    await this.submitProjectSandboxOperation(id, 'create');
    return this.readProject(id);
  }

  async restoreProjectSandbox(id: string, imageVersionId?: string): Promise<ProjectSummary> {
    await this.submitProjectSandboxOperation(id, 'restore', { imageVersionId });
    return this.readProject(id);
  }

  async backupProjectNow(id: string): Promise<ProjectSummary> {
    await this.submitProjectSandboxOperation(id, 'backup');
    return this.readProject(id);
  }

  async resumeProjectSandbox(id: string, signal?: AbortSignal, onProgress?: ProjectResumeObserver): Promise<ProjectSummary> {
    signal?.throwIfAborted();
    await this.submitProjectSandboxOperation(id, 'resume', { onResumeProgress: onProgress });
    signal?.throwIfAborted();
    onProgress?.({ stage: 'syncing' });
    const project = await this.readProject(id);
    onProgress?.({ stage: 'completed' });
    return project;
  }

  async ensureProjectAwake(id: string, signal?: AbortSignal): Promise<ProjectSummary> {
    const read = async (expectedBox?: string) => {
      const project = await this.readProject(id, {}, signal);
      if (project.status !== 'active' || project.executionMode !== 'sandbox' || !project.sandbox || project.sandbox.creation)
        throw new HttpError(409, '项目没有可唤醒的运行环境');
      if (expectedBox && project.sandbox.id !== expectedBox) throw new HttpError(409, '项目运行环境已更换，请刷新后再操作');
      return { ...project, sandbox: project.sandbox };
    };
    const initial = await read();
    const boxId = initial.sandbox.id;
    const ready = (project: ProjectSummary) => {
      if (project.sandbox?.status !== 'ready') throw new HttpError(409, project.sandboxOperation?.error || 'Sandbox 尚未就绪，请查看项目状态');
      return project;
    };
    const join = async (operationId: string) => {
      await this.waitForProjectOperation(id, operationId, 120_000, signal);
      return ready(await read(boxId));
    };

    const pending = initial.sandboxOperation;
    if (pending?.kind === 'resume' && pending.status === 'running' && pending.id) return join(pending.id);
    if (initial.sandbox.status === 'ready') return initial;
    let acquired = false;
    try {
      await this.withProjectOperation(id, async () => {
        acquired = true;
        if (this.closing || !this.sandboxOperations) throw new HttpError(503, 'Sandbox 服务暂不可用');
        const project = await read(boxId);
        if (project.sandbox.status === 'ready') return;
        if (!canAutoResumeProject(project)) throw new HttpError(409, project.sandboxOperation?.error || '当前 Sandbox 状态不支持自动恢复，请查看项目状态');
        await this.projects.refreshOne(id);
        await this.sandboxOperations.run(id, 'resume');
      });
    } catch (error) {
      // Another replica can hold the lock past its acquisition timeout. Observe
      // its durable operation even if it had not yet been recorded on entry.
      if (acquired || signal?.aborted) throw error;
      const project = await read(boxId);
      const op = project.sandboxOperation;
      if (op?.kind === 'resume' && op.status === 'running' && op.id) return join(op.id);
      if (project.sandbox.status === 'ready') return project;
      throw error;
    }
    return ready(await read(boxId));
  }

  async releaseProjectSandbox(id: string): Promise<ProjectSummary> {
    await this.submitProjectSandboxOperation(id, 'release');
    return this.readProject(id);
  }

  /** Opening a project is a read; restoring it is an explicit user operation. */
  async enterProject(id: string, signal?: AbortSignal): Promise<ProjectSummary> {
    return this.readProject(id, {}, signal);
  }

  async checkpointProjectSandbox(id: string): Promise<ProjectSummary> {
    await this.submitProjectSandboxOperation(id, 'checkpoint');
    return this.readProject(id);
  }

  private async submitProjectSandboxOperation(id: string, kind: NonNullable<Project['sandboxOperation']>['kind'], options: { imageVersionId?: string; onResumeProgress?: ProjectResumeObserver } = {}) {
    if (this.closing) throw new HttpError(503, '服务正在关闭');
    if (!this.sandboxOperations) throw new HttpError(503, 'Sandbox 未配置');
    await this.withProjectOperation(id, async () => {
      options.onResumeProgress?.({ stage: 'preparing' });
      await this.projects.refreshOne(id);
      await traced('project.operation', { 'project.id': id, 'sandbox.operation.kind': kind }, async () => {
        await this.sandboxOperations!.run(id, kind, options);
      });
    });
  }

  async refreshProjectSandboxRuntime(id: string): Promise<ProjectSummary> {
    await this.runProjectSandboxOperation(id, 'refresh');
    return this.readProject(id);
  }

  async archiveProjectNow(id: string, options: { useExistingBackup?: boolean } = {}): Promise<ProjectSummary> {
    await this.runProjectSandboxOperation(id, 'archive', options);
    return this.readProject(id);
  }

  private async archiveCompletedProject(id: string): Promise<void> {
    if (this.closing || !this.sandboxOperations) return;
    await this.withProjectOperation(id, async () => {
      await this.projects.refreshOne(id);
      const project = await this.liveProject(this.projects.get(id), true);
      if (this.closing || !this.lifecycle?.isEligible(project)) return;
      const sessions = await this.state.listProjectSessions(id);
      if (sessions.some(session => session.status === 'running')) return;
      if (project.sandbox?.status === 'ready' && this.nativeWebSocketEnabled) {
        try {
          if (!this.sandbox?.hasActiveThreads || await this.sandbox.hasActiveThreads(project.sandbox)) return;
        } catch (error) {
          void this.logger?.write({ event: 'sandbox.auto_archive_observation_failed', projectId: id, error });
          return;
        }
      }
      await this.sandboxOperations!.run(id, 'archive', {
        automaticArchiveAttempt: (project.sandboxOperation?.automaticArchiveAttempt ?? 0) + 1,
        ...(project.sandbox?.generation && project.sandbox.phase ? { releaseObservation: {
          id: project.sandbox.id, generation: project.sandbox.generation, phase: project.sandbox.phase,
          ownerKey: project.sandbox.ownerKey, volumeId: project.sandboxMounts?.[0]?.volumeId,
        } } : {}),
      });
    });
  }

  private async runProjectSandboxOperation(id: string, kind: NonNullable<Project['sandboxOperation']>['kind'],
    options: { useExistingBackup?: boolean } = {}, eligible?: (project: Project) => boolean) {
    if (this.closing) throw new HttpError(503, '服务正在关闭');
    if (!this.sandboxOperations) throw new HttpError(503, 'Sandbox 未配置');
    await this.withProjectOperation(id, async () => {
      await this.projects.refreshOne(id);
      if (eligible && !eligible(this.projects.get(id))) return;
      await this.sandboxOperations!.run(id, kind, options);
    });
  }

  private async projectHistoryIndex(projectId: string) {
    const threadIds: string[] = [];
    const claudeSessionIds: string[] = [];
    for (const session of await this.state.listProjectSessions(projectId)) {
      if (!session.threadId) continue;
      if (session.agentKind === 'claude-code') claudeSessionIds.push(session.id);
      else threadIds.push(session.threadId);
    }
    return { threadIds, ...(claudeSessionIds.length ? { claudeSessionIds } : {}) };
  }

  private async assertClaudeProjectIdle(project: Project): Promise<void> {
    if (!project.sandbox || !(await this.projectHistoryIndex(project.id)).claudeSessionIds) return;
    // A confirmed missing Box has no worker. Transport failures must still block lifecycle actions.
    const box = await querySandbox(this.sandbox, { ...project.sandbox, phase: undefined, operationId: undefined });
    if (box.status === 'paused' || (box.status === 'unavailable' && !box.operationId && (!box.phase || box.phase === 'deleted'))) return;
    if (!this.claude || box.status !== 'ready') throw new HttpError(409, '无法确认 Claude 会话空闲');
    if ((await this.claude.health(box.id)).active) throw new HttpError(409, '项目中的 Claude 任务仍在运行');
  }

  private async withProjectOperation(id: string, action: () => Promise<void>): Promise<void> {
    // These queues only serialize live requests. Retrying after restart reads
    // the durable deletion intent and Cellbox resources from the beginning.
    await this.writer.run(`project-operation:${id}`, async () => {
      if (this.coordinator) await this.coordinator.run(`project-operation:${id}`, action);
      else await action();
    });
  }

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
    const currentWeek = projectWeekOf(new Date(now));
    const idle = (project: Project) => {
      if (project.name === 'system' || project.status !== 'active' || !project.sandbox) return false;
      if (project.type === 3 && project.weekOf === currentWeek) return false;
      const sessions = [...this.sessions.values()].filter(session => session.projectId === project.id);
      const lastActivity = Math.max(Date.parse(project.sandbox.lastActiveAt ?? project.createdAt),
        project.sandboxOperation?.kind === 'resume' && project.sandboxOperation.status === 'succeeded'
          ? Date.parse(project.sandboxOperation.updatedAt) : 0,
        ...sessions.map(session => Date.parse(session.updatedAt)));
      return !sessions.some(session => session.status === 'running') && now - lastActivity >= this.autoCheckpointAfterMs;
    };
    for (const project of this.projects.list()) {
      if (idle(project) && !['running', 'failed', 'unknown'].includes(project.sandboxOperation?.status ?? '')) {
        const observed = await this.liveProject(project, true);
        if (observed.sandbox?.status === 'ready') {
          // Observations are asynchronous and may be dropped under pressure.
          // Check the execution authority before an automatic lifecycle action.
          let nativeBusy = false;
          if (this.nativeWebSocketEnabled) {
            try {
              // An unavailable status query must never authorize automatic suspension.
              nativeBusy = !this.sandbox?.hasActiveThreads || await this.sandbox.hasActiveThreads(observed.sandbox);
            } catch (error) {
              nativeBusy = true;
              void this.logger?.write({ event: 'sandbox.auto_checkpoint_observation_failed', projectId: project.id, error });
            }
          }
          if (nativeBusy) continue;
          await this.runProjectSandboxOperation(project.id, 'checkpoint', {},
            current => current.sandbox?.id === project.sandbox?.id && idle(current)).catch(() => {});
          continue;
        }
      }
    }
  }

  private isSandboxReferenced(sandboxId: string): boolean {
    return this.projects.list().some(project => project.sandbox?.id === sandboxId)
      || [...this.sessions.values()].some(session => !session.projectId && session.sandbox?.id === sandboxId);
  }

  async sweepSandboxLifecycle() {
    await this.lifecycle?.sweep();
  }

  private async ensureProjectSandbox(id: string): Promise<void> {
    await this.projects.refreshOne(id);
    this.projects.assertAvailable(id);
    const project = await this.liveProject(this.projects.get(id));
    if (project.status === 'archived') {
      throw new HttpError(409, '项目已归档，请先点击“恢复项目”');
    }
    if (project.sandbox?.status !== 'ready') {
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
    if (this.closing) throw new HttpError(503, '服务正在关闭');
    await this.withProjectOperation(id, async () => {
      await this.projects.refreshOne(id);
      await this.deleteProjectLocal(id);
    });
  }

  private async deleteProjectLocal(id: string) {
    const current = this.projects.get(id);
    if (current.removedAt) return;
    if (current.executionMode === 'sandbox') {
      if (!this.sandboxOperations) throw new HttpError(503, 'Sandbox 未配置');
      // The operation checks the execution hosts before fencing new sessions in storage.
      await this.sandboxOperations.run(id, 'delete');
      const operation = this.projects.get(id).sandboxOperation!;
      try {
        await this.projects.updateSandboxOperation(id, { ...operation, status: 'running', phase: '清理会话', updatedAt: new Date().toISOString() }, operation.id);
        for (const session of await this.state.listProjectSessions(id)) {
          await Promise.allSettled([...(this.uploads.get(session.id) ?? [])]);
          await this.removeSession(session.id);
        }
        await this.projects.updateSandboxOperation(id, { ...operation, status: 'succeeded', phase: '完成', updatedAt: new Date().toISOString() }, operation.id);
        await this.projects.markRemoved(id);
      } catch (error) {
        await this.projects.updateSandboxOperation(id, { ...operation, status: 'failed', phase: '清理会话',
          error: redactCredentials(error instanceof Error ? error.message : '项目清理未完成'), updatedAt: new Date().toISOString() }, operation.id).catch(() => {});
        throw error;
      }
      return;
    }
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
    this.writer.forget(`native-input:${id}`);
    this.writer.forget(`native-control:${id}`);
  }

  private async updateSandbox(projectId: string | undefined, sessionId: string, sandbox: NonNullable<Session['sandbox']>, restoreProject = false, restoreImage?: ProjectImageSelection, expectedSandboxId?: string | null) {
    if (projectId) {
      const project = this.projects.find(projectId);
      const replacing = project?.sandbox?.id !== sandbox.id;
      const freshEnvironment = replacing && project?.sandboxOperation?.kind === 'create'
        && !(project.sandboxMounts ?? sandboxMounts(project.sandbox ?? {}))?.length;
      if (!await this.projects.updateSandbox(projectId, sandbox, restoreProject, restoreImage, expectedSandboxId)) {
        if (expectedSandboxId !== undefined || sandbox.creation) throw new HttpError(409, '项目 Sandbox 引用已变化，请检查新旧资源状态。');
        return;
      }
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
      if (!session || this.deleting.has(sessionId)) {
        if (sandbox.creation) throw new HttpError(409, '会话已删除，无法保存 Sandbox 创建请求');
        return;
      }
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

  async create(input: { projectId?: string; agentKind?: Session['agentKind']; settings?: Partial<Settings>; threadId?: string; title?: string } = {}): Promise<Session> {
    return this.createLocal(input);
  }

  async ensureWorkflowSession(id: string, owner: NonNullable<Session['managedBy']>, projectId: string, title: string, model: string, modelEntryId?: string) {
    const stored = await this.state.getSession(id);
    if (stored) {
      if (stored.projectId !== projectId || stored.managedBy?.runId !== owner.runId || stored.managedBy.taskId !== owner.taskId
        || stored.managedBy.writable !== owner.writable) throw new HttpError(409, '工作台会话归属冲突');
      return stored;
    }
    return this.createLocal({ projectId, title, settings: { executionMode: 'sandbox', model, modelEntryId } }, { id, owner });
  }

  async isWorkflowThread(threadId: string) {
    if (this.state.isWorkflowThread) return this.state.isWorkflowThread(threadId);
    return (await this.state.listSessions()).some(s => s.threadId === threadId && s.managedBy);
  }

  async prepareWorkflowThread(id: string) {
    const session = await this.readMetadata(id);
    if (!session.managedBy) throw new HttpError(409, '需要工作台受管会话');
    const prepared = await this.nativeConnection(id);
    if (session.threadId && prepared.threadId !== session.threadId) throw new HttpError(409, '工作台会话身份已改变');
    if (prepared.threadId) return prepared.threadId;
    const result = await this.sandbox!.nativeRequest!(session, 'thread/start', prepared.threadOptions);
    const expected = session.managedBy.writable ? 'workspaceWrite' : 'readOnly';
    if (result.sandbox?.type !== expected || result.sandbox.networkAccess || !result.thread?.id)
      throw new HttpError(409, 'App Server 未确认工作台所需沙箱策略');
    await this.bindNativeThread(id, result.thread.id);
    return String(result.thread.id);
  }

  async submitWorkflowTurn(id: string, threadId: string, prompt: string, outputSchema: unknown, guard: () => Promise<void>) {
    const session = await this.readMetadata(id);
    if (!session.managedBy || session.threadId !== threadId) throw new HttpError(409, '工作台线程身份已变化');
    const sandboxPolicy = { type: session.managedBy.writable ? 'workspaceWrite' : 'readOnly', networkAccess: false };
    const result = await this.sandbox!.nativeRequest!(session, 'turn/start', { threadId, sandboxPolicy, outputSchema,
      input: [{ type: 'text', text: prompt, text_elements: [] }], model: session.settings.model }, guard);
    if (!result.turn?.id) throw new HttpError(502, '工作台提交结果未知');
    return String(result.turn.id);
  }

  private async createLocal(input: { projectId?: string; agentKind?: Session['agentKind']; settings?: Partial<Settings>; threadId?: string; title?: string }, workflow?: { id: string; owner: NonNullable<Session['managedBy']> }): Promise<Session> {
    if (this.closing) throw new HttpError(503, '服务正在关闭');
    if (input.projectId) await this.projects.refreshOne(input.projectId);
    let project = input.projectId ? this.projects.get(input.projectId) : undefined;
    let release = this.projects.acquire(project?.id);
    try {
      if (project && ((input.settings?.executionMode && input.settings.executionMode !== project.executionMode)
        || (input.settings?.workingDirectory && posix.normalize(input.settings.workingDirectory) !== project.workingDirectory))) throw new HttpError(400, '会话必须使用项目的执行环境和工作目录');
      const executionMode = project?.executionMode ?? input.settings?.executionMode ?? this.defaults.executionMode;
      if (input.threadId && executionMode === 'sandbox') throw new HttpError(400, 'Sandbox 项目不能导入本机 thread，请在已有 Sandbox 会话中继续');
      const claude = input.agentKind === 'claude-code';
      if (claude && (!this.claude || executionMode !== 'sandbox'))
        throw new HttpError(409, 'Claude Code 需要支持 ACP 的 Sandbox');
      const modelDefaults = claude ? await this.claudeModels.claudeDefaultSelection() : await this.models?.defaultSelection();
      if (claude && !modelDefaults && !input.settings?.model)
        throw new HttpError(409, '请先在模型管理中配置 Claude Code 模型');
      const proposed = { ...this.defaults, ...modelDefaults,
        ...(executionMode !== this.defaults.executionMode ? { networkAccessEnabled: executionMode === 'sandbox' } : {}), ...input.settings,
        ...(project ? { executionMode: project.executionMode, workingDirectory: project.workingDirectory } : {}), };
      if (input.settings?.model !== undefined && !input.settings.modelEntryId) delete proposed.modelEntryId;
      const selected = claude ? await this.claudeModels.claudeSelection(proposed, true) : await this.models?.selection(proposed, true);
      const settings = await this.validateSettings({ ...proposed, ...(selected ? { model: selected.model, modelEntryId: selected.modelEntryId } : {}) });
      if (!project && settings.executionMode === 'sandbox') {
        project = await this.projects.create({ name: input.title ?? '新项目' }, settings);
        // A caller creating a session without a project waits for its implicit
        // project's environment; explicit project creation returns for polling.
        await this.runProjectSandboxOperation(project.id, 'create');
        project = this.projects.get(project.id);
        release = this.projects.acquire(project.id);
      }
      const now = new Date().toISOString();
      const session: Session = { id: workflow?.id ?? randomUUID(), ...(workflow ? { managedBy: workflow.owner } : {}), agentKind: input.agentKind ?? 'codex', ...(project ? { projectId: project.id, ...(project.sandbox ? { sandbox: structuredClone(project.sandbox) } : {}) } : {}), threadId: input.threadId ?? null, title: input.title ?? '新任务', settings: normalizeExecutionSettings(settings, workflow?.owner), status: 'idle', startedAt: now, archivedAt: null, createdAt: now, updatedAt: now, turns: [] };
      await this.save(session);
      this.sessions.set(session.id, session);
      return this.snapshot(session.id);
    } finally { release(); }
  }

  private async assertNativeIdle(session: Session, checkTurnAfterError = false): Promise<void> {
    if (session.agentKind === 'claude-code' && session.threadId && session.sandbox) {
      if ((await querySandbox(this.sandbox, session.sandbox)).status === 'paused') return;
      const current = await this.readClaudeSession(session);
      if (current.historyError || current.status === 'running' || current.turns.some(turn =>
        turn.userInputRequests?.some(request => request.deliveryStatus === 'queued' || request.deliveryStatus === 'sending')))
        throw new HttpError(409, '无法确认 Claude 会话空闲，请检查任务状态');
      return;
    }
    if (!this.isNativeSession(session) || !session.threadId || !session.sandbox) return;
    const sandbox = await querySandbox(this.sandbox, session.sandbox, true);
    if (sandbox.status === 'paused') return;
    if (sandbox.status !== 'ready') throw new HttpError(409, '无法确认 Codex 的执行状态，请恢复 Sandbox 后重试');
    const response = await this.sandbox!.nativeRequest!(session, 'thread/read', { threadId: session.threadId, includeTurns: false });
    const status = response.thread?.status?.type;
    if (status === 'idle' || status === 'notLoaded') return;
    let turnStatus: unknown;
    if (status === 'systemError' && checkTurnAfterError) {
      // Codex can retain systemError after a turn fails. Check the latest turn
      // before letting the user change settings for the next turn.
      const page = await this.sandbox!.nativeRequest!(session, 'thread/turns/list', {
        threadId: session.threadId, itemsView: 'notLoaded', sortDirection: 'desc', limit: 1,
      });
      turnStatus = page?.data?.[0]?.status;
      if (turnStatus === 'failed' || turnStatus === 'completed' || turnStatus === 'interrupted') return;
    }
    if (status === 'active' || turnStatus === 'inProgress') throw new HttpError(409, '请先停止当前任务');
    throw new HttpError(409, '无法确认 Codex 的执行状态');
  }

  async update(id: string, input: { title?: string; settings?: Partial<Settings>; archived?: boolean }): Promise<Session> {
    const session = this.sessions.get(id) ?? await this.readMetadata(id);
    if (session.agentKind === 'claude-code') return this.nativeControl(id, () => this.updateLocal(id, input), false);
    return this.sessionMutation(id, () => this.updateLocal(id, input), false);
  }

  private async updateLocal(id: string, input: { title?: string; settings?: Partial<Settings>; archived?: boolean }): Promise<Session> {
    const projectId = this.lookup(id).projectId;
    if (projectId) {
      await this.projects.refreshOne(projectId);
      this.projects.assertAvailable(projectId);
    }
    const session = this.lookup(id);
    await this.assertNativeIdle(session, input.settings !== undefined && input.archived === undefined);
    if (this.active.has(id) || session.status === 'running') throw new HttpError(409, '请先停止当前任务再修改会话');
    if (input.archived && session.turns.some(turn => turn.status === 'running')) {
      throw new HttpError(409, '请先停止当前任务再归档会话');
    }
    if (input.settings?.executionMode && input.settings.executionMode !== (session.settings.executionMode || 'local')) throw new HttpError(400, '已有会话不能切换执行环境，请新建任务');
    if (session.projectId && input.settings?.workingDirectory && posix.normalize(input.settings.workingDirectory) !== session.settings.workingDirectory) throw new HttpError(400, '项目会话不能修改工作目录');
    const proposed = { ...session.settings, ...input.settings };
    if (input.settings?.model !== undefined && !input.settings.modelEntryId && input.settings.model !== session.settings.model) delete proposed.modelEntryId;
    const changedModel = proposed.model !== session.settings.model || proposed.modelEntryId !== session.settings.modelEntryId;
    if (session.agentKind === 'claude-code' && input.settings && Object.keys(input.settings).some(key =>
      !['workingDirectory', 'executionMode', 'model', 'modelEntryId', 'claudeEffort'].includes(key)))
      throw new HttpError(400, 'Claude Code 不支持这些执行设置');
    let selected;
    if (changedModel) selected = session.agentKind === 'claude-code'
      ? await this.claudeModels.claudeSelection(proposed, true) : await this.models?.selection(proposed, true);
    const settings = input.settings ? await this.validateSettings({ ...proposed, ...(selected ? { model: selected.model, modelEntryId: selected.modelEntryId } : {}) }) : normalizeExecutionSettings(session.settings, session.managedBy);
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
    await this.assertNativeIdle(session);
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
    const session = this.lookup(id);
    const subscribers = this.subscribers.get(id) ?? new Set<Subscriber>();
    this.subscribers.set(id, subscribers);
    subscribers.add(callback);
    callback({ type: 'snapshot', session: this.subscriptionPolls.get(id)?.snapshot ?? this.get(id) });
    if ((session.agentKind === 'claude-code' || this.coordinator || this.nativeWebSocketEnabled) && !this.subscriptionPolls.has(id)) {
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

  /** Observe only sessions with connected SSE clients. Claude snapshots support conditional reads. */
  private async syncSubscriber(id: string, watch: SubscriptionWatch) {
    if (this.active.has(id)) { watch.observation?.controller.abort(); return; }
    const stored = await this.state.getSession(id);
    if (!stored || this.closing || !this.subscribers.has(id) || this.active.has(id)) return;
    if (stored.agentKind === 'claude-code') {
      const view = await this.readClaudeSession(stored, watch);
      const key = JSON.stringify([view.threadId, view.status, view.sandbox?.id, view.historyError, view.updatedAt, watch.etag]);
      if (this.subscriptionPolls.get(id) === watch && watch.last !== key) {
        watch.last = key;
        this.publish(id, { type: 'state', session: view });
      }
      return;
    }
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
    const available = !!current.sandbox;
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
    if (this.externalSession(session)) {
      const metadata = sessionMetadata(session);
      return this.writer.run(session.id, async () => {
        const previous = this.savedSessions.get(session.id);
        await this.state.saveSession(metadata, previous ? sessionMetadata(previous) : undefined, true);
        this.savedSessions.set(session.id, structuredClone(metadata));
      });
    }
    // Persist submitted inputs, control boundaries and statistics. Native
    // App Server history owns the output; never copy it into MySQL snapshots.
    const turns = session.turns.map(turn => ({
      id: turn.id, type: turn.type, nativeTurnId: turn.nativeTurnId, startedAt: turn.startedAt, completedAt: turn.completedAt, status: turn.status,
      codexAccepted: turn.codexAccepted, error: turn.error,
      prompt: turn.prompt,
      additionalUserInputs: turn.additionalUserInputs,
      images: turn.images,
      items: [],
      userInputRequests: turn.userInputRequests,
      usage: turn.usage, sdkUsage: turn.sdkUsage,
      contextUsage: turn.contextUsage?.map(({ blockEstimates, blockTokenizer, blockTexts, ...call }) => call),
    }));
    const contextUsage = session.contextUsage && (() => {
      const { blockEstimates, blockTokenizer, blockTexts, ...value } = session.contextUsage;
      return value;
    })();
    const next = structuredClone({ ...session, contextUsage: contextUsage || undefined, turns });
    return this.writer.run(session.id, async () => {
      await this.state.saveSession(next, this.coordinator || this.isNativeSession(session) ? this.savedSessions.get(session.id) : undefined, this.isNativeSession(session));
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
      if (this.externalSession(session)) {
        if (session.projectId) await this.ensureProjectSandbox(session.projectId);
        return this.sandbox!.uploadNativeImage!(this.lookup(id), path);
      }
      return path;
    })();
    uploads.add(operation);
    try { return await operation; } finally {
      release();
      uploads.delete(operation);
      if (!uploads.size) this.uploads.delete(id);
    }
  }

  /** REST compatibility is a single native RPC, with no background execution owner. */
  private async startNativeTurn(id: string, prompt: string, images: string[] = []): Promise<string> {
    let result!: string;
    const submit = () => this.writer.run(`native-input:${id}`, async () => { result = await this.submitNativeTurn(id, prompt, images); });
    if (this.coordinator) await this.coordinator.run(`session-input:${id}`, submit);
    else await submit();
    return result;
  }

  private async submitNativeTurn(id: string, prompt: string, images: string[]): Promise<string> {
    const prepared = await this.nativeConnection(id);
    let session = await this.readMetadata(id);
    if (!prepared.threadId) {
      const result = await this.sandbox!.nativeRequest!(session, 'thread/start', prepared.threadOptions);
      await this.bindNativeThread(id, result.thread.id);
      session = await this.readMetadata(id);
    }
    const page = prepared.threadId ? await this.sandbox!.history(structuredClone(session), { limit: 1 }) : { turns: [] };
    const running = page.turns.find(turn => turn.status === 'running');
    if (running && images.length) throw new HttpError(409, '任务执行中只能追加文字消息');
    const input = [{ type: 'text', text: prompt, text_elements: [] }, ...images.map(path => ({ type: 'localImage', path }))];
    const method = running ? 'turn/steer' : 'turn/start';
    const params = { threadId: session.threadId, input, ...(running ? { expectedTurnId: running.id } : prepared.turnOptions) };
    const result = await this.sandbox!.nativeRequest!(session, method, params);
    const nativeId = result.turn?.id ?? result.turnId ?? running?.id;
    if (!nativeId) throw new HttpError(502, 'App Server 未返回执行标识，接收状态未知，请检查会话');
    if (method === 'turn/start' && session.threadId) this.generateNativeTitle(id, session.threadId);
    return nativeId;
  }

  async startTurn(id: string, prompt: string, images: string[] = [], clientRequestId?: string): Promise<string> {
    const metadata = await this.readMetadata(id);
    if (metadata.managedBy) throw new HttpError(409, '此会话由工作台管理，请从工作台操作');
    if (metadata.agentKind === 'claude-code') return this.claudeControl(metadata, async (client, session, box) => {
      const selected = await this.boundClaudeModel(session);
      if (!session.threadId) {
        await client.reserve(box, session.id);
        // The host binds this durable CoCell handle to its own native ACP session.
        session.threadId = session.id;
      }
      session.updatedAt = new Date().toISOString();
      if (session.title === '新任务') session.title = prompt.slice(0, 50);
      await this.save(session);
      return client.submit(box, session, selected, clientRequestId ?? randomUUID(), prompt, images);
    });
    if (this.isNativeSession(metadata)) return this.startNativeTurn(id, prompt, images);
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

  private async startTurnLocal(id: string, prompt: string, images: string[] = [], submission?: InputRequestRecord): Promise<string> {
    if (this.closing) throw new HttpError(503, '服务正在关闭');
    let session = await this.refreshSessionSandbox(this.lookup(id));
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
            accepted = await this.submitSteer(session, current, prompt, execution, submission);
          } else if (this.coordinator && session.settings.executionMode === 'sandbox' && this.sandbox?.steer) {
            accepted = await this.submitSteer(session, current, prompt, undefined, submission);
          }
        } catch (error) {
          // A failed steer RPC can have an unknown delivery outcome. Never
          // retry it automatically or start a separate turn on this request.
          if (submission?.type === 'question_reply') throw error;
          throw new HttpError(502, '追加消息的接收状态不确定，请检查会话后再继续');
        }
        if (!accepted) throw new NativeTurnNotReceiving();
        if (submission?.type !== 'question_reply') Object.assign(current, appendAdditionalUserInput(current, prompt));
        session.updatedAt = new Date().toISOString();
        await this.save(session);
        this.publish(id, { type: 'state', session: this.get(id) });
        return current.id;
      }
    }
    if (this.active.has(id) || running()) throw new HttpError(409, '当前会话已有任务正在执行');
    await this.models?.selection(session.settings);
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
      session.settings = normalizeExecutionSettings(session.settings, session.managedBy);
      // Older uploads may still be queued in a browser when storage is moved.
      const imageRoots = [resolve(this.imagesDirectory, id) + sep, resolve(this.dataDirectory, 'images', id) + sep];
      for (const image of images) {
        let path: string;
        try { path = await realpath(image); } catch { throw new HttpError(400, '图片附件不存在，请重新上传'); }
        if (!imageRoots.some(root => path.startsWith(root))) throw new HttpError(400, '只能使用此会话上传的图片');
      }
      const turn: Turn = { id: submission?.id ?? randomUUID(), type: submission?.type ?? 'message', prompt, images,
        codexAccepted: false, status: 'running', phase: 'starting', items: [], itemTimestamps: {}, startedAt: new Date().toISOString() };
      // The Sandbox owns a long-lived App Server. Web holds the live RPC
      // connection, so there is no per-turn worker process to persist.
      execution.turnId = turn.id;
      session.turns.push(turn);
      session.status = 'running';
      session.updatedAt = turn.startedAt;
      if (session.title === '新任务') session.title = prompt.slice(0, 60);
      await this.save(session);
      const input = submission ?? await this.queueInput(id, turn.id, prompt, 'message', { id: turn.id, images });
      input.turnId = turn.id;
      await this.state.saveInputRequest?.(input);
      this.publish(id, { type: 'state', session: this.get(id) });
      this.executeTurn(session, turn, execution, false, input);
      return turn.id;
    } catch (error) {
      this.sessions.set(id, previous);
      await execution.finish();
      this.publish(id, { type: 'state', session: this.get(id) });
      throw error;
    }
  }

  async stop(id: string) {
    const session = await this.readMetadata(id);
    if (session.agentKind === 'claude-code') return this.claudeControl(session, (client, current, box) => client.stop(box, current.id));
    if (this.isNativeSession(session)) {
      const page = await this.sandbox!.history(structuredClone(session), { limit: 1 });
      const turn = page.turns.find(value => value.status === 'running');
      if (turn) await this.sandbox!.nativeRequest!(session, 'turn/interrupt', { threadId: session.threadId, turnId: turn.id });
      return;
    }
    return this.sessionMutation(id, () => this.stopLocal(id), false);
  }

  private async stopLocal(id: string) {
    const current = await this.refreshSessionSandbox(this.lookup(id));
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
      imageSelection: structuredClone(project.imageSelection), sandbox: structuredClone(project.sandbox),
      sandboxMounts: structuredClone(project.sandboxMounts), sandboxOwnerKey: project.sandboxOwnerKey, updatedAt: project.updatedAt };
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
    if (!Number.isInteger(port) || port < 1 || port > 65535 || port === CLAUDE_HOST_PORT) throw new HttpError(400, '服务端口不可用于预览');
    await this.ensureProjectSandbox(projectId);
    const project = this.projects.get(projectId);
    if (project.executionMode !== 'sandbox' || !this.sandbox) throw new HttpError(400, '此项目不使用 Sandbox 沙箱');
    if (!project.sandbox) throw new HttpError(409, '项目沙箱尚未创建，请先启动服务');
    return `/api/projects/${encodeURIComponent(projectId)}/service/${port}${url.pathname}${url.search}${url.hash}`;
  }

  /** Hold project and runtime leases until the native proxy closes its response/socket. */
  async projectServiceAccess(projectId: string, port: number, method: string, requestSignal: AbortSignal): Promise<ServiceProxyAccess & { signal: AbortSignal }> {
    if (!Number.isInteger(port) || port < 1 || port > 65535 || port === CLAUDE_HOST_PORT) throw new HttpError(400, '服务端口不可用于预览');
    await this.ensureProjectSandbox(projectId);
    const project = this.projects.get(projectId);
    if (!project.sandbox || !this.sandbox?.openServiceAccess) throw new HttpError(503, 'Sandbox 服务代理未配置');
    const read = ['GET', 'HEAD'].includes(method) ? this.projects.beginRead(project.id) : undefined;
    const releaseProject = read?.release ?? this.projects.acquire(project.id);
    let projectReleased = false;
    const release = () => { if (!projectReleased) { projectReleased = true; releaseProject(); } };
    const signal = read ? AbortSignal.any([requestSignal, read.signal]) : requestSignal;
    try {
      const access = await this.sandbox.openServiceAccess(this.projectWorkspace(project), port, signal);
      let released = false;
      const done = async () => {
        if (released) return;
        released = true;
        try { await access.release(); } finally { release(); }
      };
      if (signal.aborted) { await done(); signal.throwIfAborted(); }
      return { ...access, signal, release: done };
    } catch (error) { release(); read?.signal.throwIfAborted(); throw error; }
  }

  async projectService(projectId: string, port: number, path: string, request: Request): Promise<Response> {
    if (!Number.isInteger(port) || port < 1 || port > 65535 || port === CLAUDE_HOST_PORT) throw new HttpError(400, '服务端口不可用于预览');
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
    if (this.projectFileReader) {
      await this.projects.refreshOne(projectId);
      this.projects.assertAvailable(projectId);
      const project = this.projects.get(projectId);
      if (project.executionMode !== 'sandbox') throw new HttpError(400, '此项目不使用 Sandbox 沙箱');
      const read = this.projects.beginRead(project.id);
      const signal = AbortSignal.any([request.signal, read.signal]);
      try {
        const response = await this.projectFileReader(project, path, new Request(request, { signal }));
        signal.throwIfAborted();
        return holdResponse(response, read.release, signal);
      } catch (error) { read.release(); read.signal.throwIfAborted(); throw error; }
    }
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
    if (this.projectFileReader) {
      const response = await this.projectFileResponse(projectId, path, new Request('http://localhost/file'));
      return workspaceFileResult(path, new Uint8Array(await response.arrayBuffer()));
    }
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
    await Promise.allSettled([...this.inputTasks, ...this.userInputDeliveries.values()]);
    try {
      await this.sandbox?.close();
      await Promise.all([this.writer.drain(), this.projects.close()]);
      await this.notifications?.close();
      await this.state.close();
    } finally { await this.logger?.flush(); }
  }
}
