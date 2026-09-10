import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve, sep, posix } from 'node:path';
import type { Project, ProjectSummary, Session, SessionSummary, Settings, StreamMessage, Turn } from '../../shared/types.js';
import type { E2BRuntime } from '../sandboxes/e2b.js';
import { getChanges } from '../workspaces/git.js';
import type { WorkspaceFileReadOptions } from '../workspaces/files.js';
import type { RawToolReader } from '../execution/raw-tools.js';
import type { RuntimeLog } from '../diagnostics/runtime-log.js';

import { HttpError } from '../core/errors.js';
import { ProjectService, type ProjectInput, type ProjectUpdate } from '../projects/service.js';
import { AtomicJsonWriter } from '../storage/atomic-json.js';
import { runTurn, type CodexClient } from '../execution/runner.js';
import type { WorkspaceTarget } from '../sandboxes/types.js';
import { ApprovalRequests, approvalDecisionSchema, cancelPersistedApprovals } from '../approvals/requests.js';
import { readNativeHistory } from '../execution/native-history.mjs';
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
  // E2B is the isolation boundary; Codex inside it uses guidance rather than
  // another filesystem/network sandbox (toolchain caches live outside cwd).
  return settings.executionMode === 'e2b'
    ? { ...settings, sandboxMode: 'danger-full-access', networkAccessEnabled: true }
    : settings;
}

export class SessionManager {
  private projects: ProjectService;
  private sessions = new Map<string, Session>();
  private active = new Map<string, ActiveExecution>();
  private subscribers = new Map<string, Set<Subscriber>>();
  private writer = new AtomicJsonWriter();
  private deleting = new Set<string>();
  private uploads = new Map<string, Set<Promise<string>>>();
  private closing = false;
  private historyReads = new Map<string, Promise<void>>();
  private billingReads = new Map<string, Promise<Turn[]>>();

  constructor(private client: CodexClient, public readonly dataDirectory: string, public readonly defaults: Settings, private e2b?: E2BRuntime, private e2bWorkingDirectory = '/home/user/workspace', private logger?: RuntimeLog) { this.projects = new ProjectService(dataDirectory); }

  async init() {
    await mkdir(this.dataDirectory, { recursive: true, mode: 0o700 });
    await this.projects.init();
    for (const name of await readdir(this.dataDirectory)) {
      if (!/^[\da-f-]{36}\.json$/.test(name)) continue;
      // Invalid state is reported rather than silently overwriting someone's history.
      const session = JSON.parse(await readFile(join(this.dataDirectory, name), 'utf8')) as Session;
      if (name !== `${session.id}.json` || !Array.isArray(session.turns) || !session.settings) {
        throw new Error(`Invalid session state: ${name}`);
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
      if (!session.projectId && session.settings.executionMode === 'e2b') {
        // Persist the project first. If interrupted, deterministic IDs make migration repeatable.
        if (!this.projects.find(session.id)) {
          const project: Project = { id: session.id, name: session.title, requirementUrl: null, executionMode: 'e2b', workingDirectory: session.settings.workingDirectory,
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
        if (turn.status === 'running' && !turn.execution) {
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
            // Message bodies are reconstructed by replaying the sandbox journal.
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
      if (project.executionMode !== 'e2b' || !project.sandbox) continue;
      const siblings = [...this.sessions.values()].filter(session => session.projectId === project.id)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      const owner: WorkspaceTarget = siblings[0] ? structuredClone(this.hydrate(siblings[0])) : this.projectWorkspace(project);
      if (project.updatedAt > owner.updatedAt) owner.updatedAt = project.updatedAt;
      this.e2b?.track?.(owner, sandbox => this.updateSandbox(project.id, owner.id, sandbox));
    }
    for (const session of this.sessions.values()) {
      if (session.projectId || session.settings.executionMode !== 'e2b' || !session.sandbox) continue;
      this.e2b?.track?.(structuredClone(session), sandbox => this.updateSandbox(undefined, session.id, sandbox));
    }
    for (const session of this.sessions.values()) {
      const turn = session.turns.find(turn => this.canRecover(session, turn));
      if (turn) this.executeTurn(session, turn, this.reserveTurn(session), true);
    }
  }

  private canRecover(session: Session, turn: Turn): boolean {
    return Boolean(this.e2b && session.settings.executionMode === 'e2b' && session.sandbox
      && turn.execution?.kind === 'e2b-worker' && turn.execution.protocolVersion === 1 && turn.execution.state !== 'terminal');
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
      client: this.client, e2b: this.e2b, logger: this.logger, recovering,
      save: () => this.save(session), publish: message => this.publish(id, message), snapshot: () => this.get(id),
      updateSandbox: sandbox => this.updateSandbox(session.projectId, id, sandbox),
      requestApproval: approvals.request, closeApprovals: () => approvals.close(), detachApprovals: () => approvals.detach(),
    }).finally(execution.finish);
    void running.catch(error => console.error('Session persistence failed:', error instanceof Error ? error.message : 'unknown error'));
  }

  list(): SessionSummary[] {
    return [...this.sessions.values()].map(session => this.hydrate(session)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map(({ turns, ...session }) => structuredClone({ ...session, turnCount: turns.length }));
  }

  get(id: string): Session { return structuredClone(this.lookup(id)); }
  async read(id: string): Promise<Session> {
    let pending = this.historyReads.get(id);
    if (!pending) {
      pending = this.loadNativeHistory(id).finally(() => { this.historyReads.delete(id); });
      this.historyReads.set(id, pending);
    }
    await pending;
    return this.get(id);
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
    const native = session.settings.executionMode === 'e2b'
      ? await this.e2b!.history(session, true) : await readNativeHistory(session.threadId, undefined, true);
    const estimated = await estimateNativeBlocksAsync(native);
    // The billing rail consumes IDs and context usage only. Returning the
    // complete transcript here duplicates every command/MCP result alongside
    // the already-loaded conversation, which made opening a long session
    // allocate and transfer tens of MB unnecessarily.
    return estimated.map(turn => ({ ...turn, prompt: '', images: [], items: [] }));
  }

  private async loadNativeHistory(id: string) {
    const session = this.lookup(id);
    const native = !session.threadId ? [] : session.settings.executionMode === 'e2b'
      ? await this.e2b!.history(session) : await readNativeHistory(session.threadId);
    const previous = session.turns;
    const liveId = this.active.get(id)?.turnId;
    const mapped = native.map(turn => {
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
      return { ...turn, id: stored.id, nativeTurnId: turn.id, sdkUsage: stored.sdkUsage,
        // SDK failures can include transport/observer errors absent from the
        // rollout. Reading history must not turn a durable failure into success.
        ...(stored.status === 'failed' ? { status: stored.status, error: stored.error ?? turn.error } : {}),
        contextUsage: turn.contextUsage?.map(call => {
          const old = stored.contextUsage?.find(value => call.responseId && value.responseId === call.responseId);
          return old ? { ...old, ...call } : call;
        }) };
    });
    const live = previous.find(turn => turn.id === liveId);
    if (live && !mapped.some(turn => turn.id === live.id)) mapped.push(live);
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
    return structuredClone({ ...project, archivedAt: project.archivedAt ?? null, sessionCount: [...this.sessions.values()].filter(session => session.projectId === project.id).length,
      activeSessionId: this.projects.activeSessionId(project.id) });
  }

  getProject(id: string): ProjectSummary { return this.projectSummary(this.projects.get(id)); }

  async createProject(input: ProjectInput, settings?: Settings): Promise<ProjectSummary> {
    if (this.closing) throw new HttpError(503, '服务正在关闭');
    const valid = await this.validateSettings(settings ?? { ...this.defaults, executionMode: 'e2b', workingDirectory: this.defaults.executionMode === 'e2b' ? this.defaults.workingDirectory : this.e2bWorkingDirectory });
    const project = await this.projects.create(input, valid);
    return this.projectSummary(project);
  }

  async updateProject(id: string, input: ProjectUpdate): Promise<ProjectSummary> {
    return this.projectSummary(await this.projects.update(id, input));
  }

  async deleteProject(id: string) {
    await this.projects.delete(id, async project => {
      const sessions = [...this.sessions.values()].filter(session => session.projectId === id);
      for (const session of sessions) await Promise.allSettled([...(this.uploads.get(session.id) ?? [])]);
      if (project.executionMode === 'e2b' && project.sandbox) {
        if (!this.e2b) throw new HttpError(503, 'E2B 未配置，无法删除项目沙箱；项目记录已保留');
        await this.e2b.delete(this.projectWorkspace(project));
      }
      for (const session of sessions) await this.removeSession(session.id);
    });
  }

  private async removeSession(id: string) {
    await this.writer.wait(id);
    await rm(join(this.dataDirectory, `${id}.json`), { force: true });
    await rm(join(this.dataDirectory, 'images', id), { recursive: true, force: true });
    this.sessions.delete(id);
    this.subscribers.delete(id);
    this.writer.forget(id);
  }

  private async updateSandbox(projectId: string | undefined, sessionId: string, sandbox: NonNullable<Session['sandbox']>) {
    if (projectId) {
      if (!await this.projects.updateSandbox(projectId, sandbox)) return;
      for (const sibling of this.sessions.values()) {
        if (sibling.projectId !== projectId || this.deleting.has(sibling.id)) continue;
        sibling.sandbox = structuredClone(sandbox);
        await this.save(sibling);
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
    if (settings.executionMode === 'e2b') {
      if (!this.e2b) throw new HttpError(400, 'E2B 尚未配置，请检查服务端连接设置');
      if (!posix.isAbsolute(settings.workingDirectory) || settings.workingDirectory.includes('\0')) throw new HttpError(400, 'E2B 工作目录必须是沙箱内的绝对路径');
      const directory = posix.normalize(settings.workingDirectory);
      if (!directory.startsWith('/home/user/') || /^\/home\/user\/\.codex(?:-web)?(?:\/|$)/.test(directory)) throw new HttpError(400, 'E2B 工作目录须位于 /home/user 下，且不能使用 Codex 内部目录');
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
      if (input.threadId && executionMode === 'e2b') throw new HttpError(400, 'E2B 项目不能导入本机 thread，请在已有 E2B 会话中继续');
      const settings = await this.validateSettings({ ...this.defaults,
        ...(executionMode !== this.defaults.executionMode ? { networkAccessEnabled: executionMode === 'e2b' } : {}), ...input.settings,
        ...(project ? { executionMode: project.executionMode, workingDirectory: project.workingDirectory } : {}), });
      if (!project && settings.executionMode === 'e2b') {
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
      if (!session.projectId && session.settings.executionMode === 'e2b' && session.sandbox) {
        if (!this.e2b) throw new HttpError(503, 'E2B 未配置，无法删除沙箱；会话记录已保留');
        await this.e2b.delete(session);
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
    // Persist execution locators and numeric billing evidence, never a second message history.
    const turns = session.turns.map(turn => ({
      id: turn.id, nativeTurnId: turn.nativeTurnId, startedAt: turn.startedAt, completedAt: turn.completedAt, status: turn.status,
      execution: turn.execution, codexAccepted: turn.codexAccepted, error: turn.error,
      approvals: turn.execution?.state !== 'terminal' ? turn.approvals : undefined,
      prompt: '', images: [], items: [], usage: turn.usage, sdkUsage: turn.sdkUsage,
      contextUsage: turn.contextUsage?.map(({ blockEstimates, blockTokenizer, blockTexts, ...call }) => call),
    }));
    const { blockEstimates, blockTokenizer, blockTexts, ...contextUsage } = session.contextUsage ?? {};
    return this.writer.write(session.id, join(this.dataDirectory, `${session.id}.json`), { ...session, contextUsage: session.contextUsage ? contextUsage : undefined, turns });
  }

  async uploadImage(id: string, content: Uint8Array, extension: string): Promise<string> {
    this.lookup(id);
    const uploads = this.uploads.get(id) ?? new Set<Promise<string>>();
    this.uploads.set(id, uploads);
    const operation = (async () => {
      const directory = join(this.dataDirectory, 'images', id);
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
    const session = this.lookup(id);
    if (session.archivedAt) throw new HttpError(409, '会话已归档，请先恢复后再发送消息');
    if (this.active.has(id) || session.turns.some(turn => turn.status === 'running')) throw new HttpError(409, '当前会话已有任务正在执行');
    const previous = structuredClone(session);
    // Reserve the session synchronously, before validating attachments or saving state.
    const execution = this.reserveTurn(session);
    try {
      session.settings = normalizeExecutionSettings(session.settings);
      const imageRoot = resolve(this.dataDirectory, 'images', id) + sep;
      for (const image of images) {
        let path: string;
        try { path = await realpath(image); } catch { throw new HttpError(400, '图片附件不存在，请重新上传'); }
        if (!path.startsWith(imageRoot)) throw new HttpError(400, '只能使用此会话上传的图片');
      }
      const turn: Turn = { id: randomUUID(), prompt, images, codexAccepted: false, status: 'running', phase: 'starting', items: [], itemTimestamps: {}, startedAt: new Date().toISOString() };
      if (session.settings.executionMode === 'e2b') turn.execution = {
        kind: 'e2b-worker', protocolVersion: 1, workerId: randomUUID(), lastAppliedSeq: 0, state: 'launching',
      };
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

  async stop(id: string) {
    this.lookup(id);
    const execution = this.active.get(id);
    if (execution) {
      execution.controller.abort();
      await execution.done;
      return;
    }

    // A Web restart or an unexpected worker exit can leave a persisted
    // `running` turn without an in-memory execution to abort.  Refresh the
    // SDK/E2B history first; if no durable execution remains, converge this
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
    const project = this.projects.get(projectId);
    if (project.executionMode !== 'e2b' || !this.e2b) throw new HttpError(400, '此项目不使用 E2B 沙箱');
    if (!project.sandbox) throw new HttpError(409, '项目沙箱尚未创建，请先启动服务');
    const release = this.projects.acquire(project.id);
    const owner = this.projectWorkspace(project);
    try {
      const origin = await this.e2b.preview(owner, port);
      const target = new URL(origin);
      target.pathname = url.pathname; target.search = url.search; target.hash = url.hash;
      return target.href;
    } finally { release(); }
  }

  async changes(id: string) {
    const session = this.lookup(id);
    if (session.settings.executionMode !== 'e2b') return getChanges(session.settings.workingDirectory);
    if (!this.e2b) throw new HttpError(503, 'E2B 未配置');
    const release = this.projects.acquire(session.projectId);
    try { return await this.e2b.changes(session); } finally { release(); }
  }

  async projectFile(projectId: string, path: string, options?: WorkspaceFileReadOptions) {
    if (this.closing) throw new HttpError(503, '服务正在关闭');
    const project = this.projects.get(projectId);
    if (project.executionMode !== 'e2b' || !this.e2b) throw new HttpError(400, '此项目不使用 E2B 沙箱');
    if (!project.sandbox) throw new HttpError(409, '项目沙箱尚未创建，请先发送一条消息');
    const release = this.projects.acquire(project.id);
    try { return await this.e2b.file(this.projectWorkspace(project), path, options); }
    finally { release(); }
  }

  async rawTools(id: string, cursor: number, localReader: RawToolReader) {
    const session = this.lookup(id);
    if (session.settings.executionMode !== 'e2b') return localReader.read(session.threadId, cursor);
    if (!this.e2b) throw new HttpError(503, 'E2B 未配置');
    const release = this.projects.acquire(session.projectId);
    try { return await this.e2b.rawTools(session, cursor); } finally { release(); }
  }

  async close() {
    this.closing = true;
    const detachments: Promise<void>[] = [];
    for (const [id, execution] of this.active) {
      const session = this.sessions.get(id);
      const turn = session?.turns.find(turn => turn.id === execution.turnId);
      if (session?.settings.executionMode === 'e2b' && turn?.execution?.kind === 'e2b-worker' && this.e2b) {
        this.e2b.detach(turn);
        if (execution.approvals) detachments.push(execution.approvals.detach());
      } else execution.controller.abort();
    }
    await Promise.allSettled(detachments);
    await Promise.allSettled([...this.active.values()].map(execution => execution.done));
    try {
      await this.e2b?.close();
      await Promise.all([this.writer.drain(), this.projects.close()]);
    } finally { await this.logger?.flush(); }
  }
}
