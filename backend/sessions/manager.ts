import { randomUUID } from 'node:crypto';
import { mkdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve, sep, posix } from 'node:path';
import type { Project, ProjectSummary, Session, SessionSummary, Settings, StreamMessage, Turn } from '../../protocol/types.js';
import type { SandboxRuntime } from '../execution/container-runtime.js';
import { SandboxLifecycleService } from '../projects/sandbox-lifecycle.js';
import type { WorkspaceFileReadOptions } from '../workspaces/files.js';
import type { RuntimeLog } from '../infra/diagnostics/runtime-log.js';

import { HttpError } from '../../util/errors.js';
import { ProjectService, type ProjectInput, type ProjectUpdate } from '../projects/service.js';
import { AtomicJsonWriter } from '../infra/storage/atomic-json.js';
import { createWebStateStore, type WebStateStore } from '../infra/storage/web-state.js';
import { runTurn, type CodexClient } from '../execution/runner.js';
import type { WorkspaceTarget } from '../sandboxes/types.js';
import { ApprovalRequests, approvalDecisionSchema, cancelPersistedApprovals } from '../approvals/requests.js';
import { readNativeHistory } from '../execution/native-history.mjs';
import type { NotificationStore } from '../notifications/store.js';
import { estimateNativeBlocksAsync } from '../execution/block-estimates.js';

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
  private danglingDeletions = new Map<string, Promise<void>>();
  private sessions = new Map<string, Session>();
  private active = new Map<string, ActiveExecution>();
  private subscribers = new Map<string, Set<Subscriber>>();
  private writer = new AtomicJsonWriter();
  private deleting = new Set<string>();
  private uploads = new Map<string, Set<Promise<string>>>();
  private closing = false;
  private historyReads = new Map<string, Promise<void>>();
  private billingReads = new Map<string, Promise<Turn[]>>();

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
  ) {
    this.notifications = notifications;
    this.projects = new ProjectService(state);
    if (sandbox) {
      this.lifecycle = new SandboxLifecycleService({
        ...lifecycleOptions,
        listProjects: () => this.projects.list(),
        reclaim: id => this.archiveProjectNow(id).then(() => {}),
      });
    }
  }

  async init() {
    await this.state.init();
    await this.projects.init();
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
    }).finally(() => {
      execution.finish();
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
      .map(({ turns, ...session }) => structuredClone({ ...session, turnCount: turns.length }));
  }

  get(id: string): Session { return structuredClone(this.lookup(id)); }
  async read(id: string): Promise<Session> {
    // The persisted session is the availability path for the chat UI. Native
    // rollout history lives in Sandbox and can be slow for long-running threads;
    // refresh it in the background instead of turning a transient inspection
    // timeout into a blank conversation.
    this.lookup(id);
    this.refreshNativeHistory(id);
    return this.get(id);
  }

  private refreshNativeHistory(id: string) {
    const projectId = this.sessions.get(id)?.projectId;
    if (projectId && (this.projects.isMaintaining(projectId) || !this.projects.get(projectId).sandbox)) return;
    let pending = this.historyReads.get(id);
    if (!pending) {
      pending = this.loadNativeHistory(id)
        .then(() => {
          if (!this.deleting.has(id)) this.publish(id, { type: 'state', session: this.get(id) });
        })
        .catch(error => {
          // The durable snapshot remains usable when Sandbox's bounded inspection
          // request times out. A later page visit can retry the refresh.
          console.error('Native history refresh failed:', error instanceof Error ? error.message : 'unknown error');
        })
        .finally(() => { this.historyReads.delete(id); });
      this.historyReads.set(id, pending);
    }
  }

  async billing(id: string): Promise<Turn[]> {
    const pending = this.billingReads.get(id);
    if (pending) return pending;
    const operation = this.calculateBilling(id).finally(() => { this.billingReads.delete(id); });
    this.billingReads.set(id, operation);
    return operation;
  }

  private async calculateBilling(id: string): Promise<Turn[]> {
    const session = this.get(id);
    if (!session.threadId) return [];
    if (session.settings.executionMode === 'sandbox' && !session.sandbox) return session.turns.map(turn => ({ ...turn, prompt: '', images: [], items: [] }));
    const native = session.settings.executionMode === 'sandbox'
      ? await this.readSandboxHistory(session, true) : await readNativeHistory(session.threadId, undefined, true, session.startedAt, session.nativeHistoryPath);
    if (native.path && native.path !== session.nativeHistoryPath) {
      session.nativeHistoryPath = native.path;
      await this.save(session);
    }
    const estimated = await estimateNativeBlocksAsync(native.turns);
    // The billing rail consumes IDs and context usage only. Returning the
    // complete transcript here duplicates every command/MCP result alongside
    // the already-loaded conversation, which made opening a long session
    // allocate and transfer tens of MB unnecessarily.
    return estimated.map(turn => ({ ...turn, prompt: '', images: [], items: [] }));
  }

  private async readSandboxHistory(session: Session, includeBlocks = false) {
    const release = this.projects.acquire(session.projectId);
    try { return await this.sandbox!.history(session, includeBlocks); }
    finally { release(); }
  }

  private async loadNativeHistory(id: string) {
    const session = this.lookup(id);
    const native = !session.threadId ? { turns: [] } : session.settings.executionMode === 'sandbox'
      ? await this.readSandboxHistory(session) : await readNativeHistory(session.threadId, undefined, false, session.startedAt, session.nativeHistoryPath);
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
    const mapped = native.turns.filter(turn => turn.status !== 'failed').map(turn => {
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
        items: [...turn.items, ...storedOnlyItems],
        itemTimestamps: { ...stored.itemTimestamps, ...turn.itemTimestamps },
        contextUsage: turn.contextUsage?.map(call => {
          const old = stored.contextUsage?.find(value => call.responseId && value.responseId === call.responseId);
          return old ? { ...old, ...call } : call;
        }) };
    }).sort((left, right) => left.startedAt.localeCompare(right.startedAt));
    const live = previous.find(turn => turn.id === liveId);
    if (live && !mapped.some(turn => turn.id === live.id)) mapped.push(live);
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

  private projectSummary(project: Project): ProjectSummary {
    return structuredClone({ ...project, status: project.status ?? (project.archivedAt ? 'archived' : 'active'), archivedAt: project.archivedAt ?? null, sessionCount: [...this.sessions.values()].filter(session => session.projectId === project.id).length,
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
    const project = this.projects.get(id);
    // Older project records only carried archivedAt. Treat those records as
    // archived as well so the rebuild action remains usable after migration.
    const status = project.status ?? (project.archivedAt ? 'archived' : 'active');
    if (status !== 'archived') throw new HttpError(409, '只有已归档项目可以恢复 Sandbox');
    if (project.sandbox) throw new HttpError(409, '归档项目不应保留 Sandbox 引用');
    if (!this.sandbox) throw new HttpError(503, 'Sandbox 未配置');
    const target = this.projectWorkspace(project);
    await this.sandbox.rebuild(target, sandbox => this.updateSandbox(id, id, sandbox, true));
    // Rehydrate the durable workspace/Codex archive into the newly created
    // container. Rebuilds must preserve native App Server history.
    // The append-only archive ledger is authoritative. Restore the newest
    // successful archive by timestamp instead of a mutable project pointer.
    const archive = await this.projects.latestDataArchive(id);
    if (archive && this.sandbox.restoreArchive) {
      if (!/^[A-Za-z0-9._-]+\.tar\.gz$/.test(archive.key)) throw new HttpError(400, '归档文件名无效');
      // updateSandbox persists the new binding; refresh the target before
      // acquiring it for the restore operation.
      target.sandbox = this.projects.get(id).sandbox;
      // `dataDirectory` points at the web-state subdirectory; archives live
      // beside it under the data root.
      await this.sandbox.restoreArchive(target, join(this.dataDirectory, '..', 'sandbox-data-archives', archive.key));
    }
    return this.getProject(id);
  }

  /** Archive a single project sandbox (best-effort, no deletion). */
  async scheduledArchiveForProject(projectId: string) {
    if (!this.sandbox?.createArchive) return;
    const project = this.projects.get(projectId);
    if (!project?.sandbox || project.status === 'archived') return;
    const directory = join(this.dataDirectory, '..', 'sandbox-data-archives');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    try {
      const key = `${randomUUID()}.tar.gz`;
      const destination = join(directory, key);
      const stored = await this.sandbox.createArchive(
        { id: project.id, projectId: project.id, settings: { workingDirectory: project.workingDirectory }, sandbox: project.sandbox, updatedAt: project.updatedAt }, destination);
      const sessions = [...this.sessions.values()].filter(s => s.projectId === projectId);
      const threadIds = sessions.map(s => s.threadId).filter((v): v is string => Boolean(v));
      await this.projects.saveDataArchive(projectId, {
        key, format: 'codex-workspace-v1', ...stored, createdAt: new Date().toISOString(), threadIds,
        workingDirectory: project.workingDirectory, sourceSandboxId: project.sandbox.id,
        sourceProjectId: projectId, sourceTemplate: project.sandbox.template, manifestSha256: stored.sha256,
      });
    } catch (e) { console.error("Archive failed:", e instanceof Error ? e.message : String(e)) }
  }

  /** Archive all active project sandboxes without deleting them. */
  async scheduledArchive() {
    for (const project of this.projects.list()) {
      if (!project.sandbox || project.status === 'archived') continue;
      await this.scheduledArchiveForProject(project.id).catch(() => {});
    }
  }

  async archiveProjectNow(id: string): Promise<ProjectSummary> {
    const project = this.projects.get(id);
    if (project.status === 'archived') return this.getProject(id);
    if (project.executionMode !== 'sandbox') throw new HttpError(400, '本地项目不需要 Sandbox 归档');
    const sessions = [...this.sessions.values()].filter(session => session.projectId === id);
    if (sessions.some(session => this.active.has(session.id))) throw new HttpError(409, '项目仍有执行中的任务');
    if (project.sandbox) {
      if (!this.sandbox?.createArchive) throw new HttpError(503, 'Sandbox 数据归档未配置，未删除原 Sandbox');
      const directory = join(this.dataDirectory, '..', 'sandbox-data-archives');
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const key = `${randomUUID()}.tar.gz`;
      const destination = join(directory, key);
      const temporary = `${destination}.partial`;
      try {
        const stored = await this.sandbox.createArchive(this.projectWorkspace(project), temporary);
        await rename(temporary, destination);
        const threadIds = sessions.map(session => session.threadId).filter((value): value is string => Boolean(value));
        await this.projects.saveDataArchive(id, {
          key, format: 'codex-workspace-v1', ...stored, createdAt: new Date().toISOString(), threadIds,
          workingDirectory: project.workingDirectory, sourceSandboxId: project.sandbox.id,
          sourceProjectId: project.id, sourceTemplate: project.sandbox.template,
          manifestSha256: stored.sha256,
        });
      } catch (error) {
        await rm(temporary, { force: true });
        // A failed restore can leave a project bound to a stopped replacement
        // even though the preceding archive is already durable. An explicit
        // archive request may safely detach that unusable replacement and let
        // the normal rebuild path restore the latest snapshot.
        const previous = await this.projects.latestDataArchive(id);
        if (!previous || !/container .* is not running|sandbox .* is unavailable/i.test(String(error))) throw error;
      }
      try { await this.sandbox?.delete(this.projectWorkspace(project)); }
      catch (error) {
        if ((error as { code?: string }).code === 'busy') throw new HttpError(409, 'Sandbox 仍有收尾操作，请稍后重试归档');
        throw error;
      }
      for (const session of sessions) { delete session.sandbox; await this.save(session); }
    }
    await this.projects.archiveAndDetachSandbox(id, project.sandbox?.id);
    return this.getProject(id);
  }

  private isSandboxReferenced(sandboxId: string): boolean {
    return this.projects.list().some(project => project.sandbox?.id === sandboxId
      )
      || [...this.sessions.values()].some(session =>
        (!session.projectId && session.sandbox?.id === sandboxId)
        || session.turns.some(turn => turn.execution?.sandboxId === sandboxId && turn.execution.state !== 'terminal'));
  }

  async sweepSandboxLifecycle() {
    await this.lifecycle?.sweep();
  }

  private async ensureProjectSandbox(id: string): Promise<void> {
    const project = this.projects.get(id);
    if (project.status === 'archived' && !project.sandbox) {
      throw new HttpError(409, '归档项目的 Sandbox 已删除，请先在已归档项目中点击“恢复项目”（重建 Sandbox）');
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
      for (const session of sessions) await this.removeSession(session.id);
    });
  }

  private async removeSession(id: string) {
    await this.writer.wait(id);
    await this.state.deleteSession(id);
    await Promise.all([...new Set([join(this.imagesDirectory, id), join(this.dataDirectory, 'images', id)])]
      .map(directory => rm(directory, { recursive: true, force: true })));
    this.sessions.delete(id);
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
    // Native Codex history remains canonical for ordinary completed turns.
    // An interrupted App Server turn may not expose its already-streamed items
    // through thread/turns/list, though. Retain that visible partial transcript
    // for cancelled turns so a refresh or Web restart cannot erase it.
    const turns = session.turns.map(turn => ({
      id: turn.id, nativeTurnId: turn.nativeTurnId, startedAt: turn.startedAt, completedAt: turn.completedAt, status: turn.status,
      execution: turn.execution, codexAccepted: turn.codexAccepted, error: turn.error,
      approvals: turn.status === 'running' || (turn.execution && turn.execution.state !== 'terminal') ? turn.approvals : undefined,
      prompt: turn.status === 'cancelled' ? turn.prompt : '',
      images: turn.status === 'cancelled' ? turn.images : [],
      items: turn.status === 'cancelled' ? turn.items : [],
      itemTimestamps: turn.status === 'cancelled' ? turn.itemTimestamps : undefined,
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
