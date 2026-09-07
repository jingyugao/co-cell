import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve, sep, posix } from 'node:path';
import type { Codex, Input, Thread, ThreadOptions } from '@openai/codex-sdk';
import type { AgentEvent } from '../shared/types.js';
import type { Project, ProjectSummary, Session, SessionSummary, Settings, StreamMessage, Turn } from '../shared/types.js';
import { applyTurnEvent } from '../shared/session-events.js';
import type { E2BRuntime } from './e2b.js';
import { getChanges } from './git.js';
import type { RawToolReader } from './raw-tools.js';
import type { RuntimeLog } from './runtime-log.js';

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export type CodexClient = Pick<Codex, 'startThread' | 'resumeThread'>;
type Subscriber = (message: StreamMessage) => void;

function normalizeExecutionSettings(settings: Settings): Settings {
  // E2B is the isolation boundary; Codex inside it uses guidance rather than
  // another filesystem/network sandbox (toolchain caches live outside cwd).
  return settings.executionMode === 'e2b'
    ? { ...settings, sandboxMode: 'danger-full-access', networkAccessEnabled: true }
    : settings;
}

export class SessionManager {
  private projects = new Map<string, Project>();
  private projectRevisions = new Map<string, number>();
  private deletingProjects = new Set<string>();
  private projectOperations = new Map<string, number>();
  private activeProjects = new Map<string, Set<string>>();
  private sessions = new Map<string, Session>();
  private active = new Map<string, { controller: AbortController; done: Promise<void> }>();
  private subscribers = new Map<string, Set<Subscriber>>();
  private writes = new Map<string, Promise<void>>();
  private deleting = new Set<string>();
  private uploads = new Map<string, Set<Promise<string>>>();
  private closing = false;

  constructor(private client: CodexClient, public readonly dataDirectory: string, public readonly defaults: Settings, private e2b?: E2BRuntime, private e2bWorkingDirectory = '/home/user/workspace', private logger?: RuntimeLog) {}

  async init() {
    await mkdir(this.dataDirectory, { recursive: true, mode: 0o700 });
    const projectDirectory = join(this.dataDirectory, 'projects');
    await mkdir(projectDirectory, { recursive: true, mode: 0o700 });
    for (const name of await readdir(projectDirectory)) {
      if (!/^[\da-f-]{36}\.json$/.test(name)) continue;
      const project = JSON.parse(await readFile(join(projectDirectory, name), 'utf8')) as Project;
      if (name !== `${project.id}.json` || !project.name || !project.workingDirectory) throw new Error(`Invalid project state: ${name}`);
      this.projects.set(project.id, project);
    }
    for (const name of await readdir(this.dataDirectory)) {
      if (!/^[\da-f-]{36}\.json$/.test(name)) continue;
      // Invalid state is reported rather than silently overwriting someone's history.
      const session = JSON.parse(await readFile(join(this.dataDirectory, name), 'utf8')) as Session;
      if (name !== `${session.id}.json` || !Array.isArray(session.turns) || !session.settings) {
        throw new Error(`Invalid session state: ${name}`);
      }
      let changed = false;
      if (!session.projectId && session.settings.executionMode === 'e2b') {
        // Persist the project first. If interrupted, deterministic IDs make migration repeatable.
        if (!this.projects.has(session.id)) {
          const project: Project = { id: session.id, name: session.title, requirementUrl: null, executionMode: 'e2b', workingDirectory: session.settings.workingDirectory,
            sandbox: session.sandbox, createdAt: session.createdAt, updatedAt: session.updatedAt };
          await this.saveProject(project);
          this.projects.set(project.id, project);
        }
        session.projectId = session.id;
        changed = true;
      }
      if (session.projectId) {
        const project = this.projects.get(session.projectId);
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
        if (turn.retry !== undefined) {
          delete turn.retry;
          changed = true;
        }
        if (turn.status !== 'running' && turn.phase !== undefined) {
          delete turn.phase;
          changed = true;
        }
        // Older versions retained transient stream errors even after a successful turn.
        if (turn.status === 'completed' && turn.error !== undefined) {
          delete turn.error;
          changed = true;
        }
      }
      if (session.status === 'running') {
        changed = true;
        session.status = session.turns.some(turn => turn.status === 'running')
          ? 'cancelled' : session.turns.at(-1)?.status ?? 'cancelled';
        for (const turn of session.turns.filter(t => t.status === 'running')) {
          turn.status = 'cancelled';
          delete turn.phase;
          turn.error = '服务已重启，本轮执行已中断。可以发送消息继续原会话。';
          turn.completedAt = new Date().toISOString();
        }
      }
      if (changed) await this.save(session);
      this.sessions.set(session.id, session);
    }
    // Restore idle tracking without connecting to or waking persisted sandboxes.
    // Projects remain owners even after their last conversation is deleted.
    for (const project of this.projects.values()) {
      if (project.executionMode !== 'e2b' || !project.sandbox) continue;
      const siblings = [...this.sessions.values()].filter(session => session.projectId === project.id)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      const owner: Session = siblings[0] ? structuredClone(this.hydrate(siblings[0])) : {
        id: project.id, projectId: project.id, title: project.name, threadId: null,
        settings: normalizeExecutionSettings({ ...this.defaults, executionMode: project.executionMode, workingDirectory: project.workingDirectory }),
        sandbox: structuredClone(project.sandbox), status: 'idle', turns: [], createdAt: project.createdAt, updatedAt: project.updatedAt,
      };
      if (project.updatedAt > owner.updatedAt) owner.updatedAt = project.updatedAt;
      this.e2b?.track?.(owner, sandbox => this.updateSandbox(project.id, owner.id, sandbox));
    }
    for (const session of this.sessions.values()) {
      if (session.projectId || session.settings.executionMode !== 'e2b' || !session.sandbox) continue;
      this.e2b?.track?.(structuredClone(session), sandbox => this.updateSandbox(undefined, session.id, sandbox));
    }
  }

  list(): SessionSummary[] {
    return [...this.sessions.values()].map(session => this.hydrate(session)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map(({ turns, ...session }) => structuredClone({ ...session, turnCount: turns.length }));
  }

  get(id: string): Session { return structuredClone(this.lookup(id)); }
  private lookup(id: string): Session {
    if (this.deleting.has(id)) throw new HttpError(409, '会话正在删除');
    const session = this.sessions.get(id);
    if (!session) throw new HttpError(404, '会话不存在');
    if (session.projectId) this.projectLookup(session.projectId);
    return this.hydrate(session);
  }

  private hydrate(session: Session): Session {
    if (session.projectId) session.sandbox = structuredClone(this.projects.get(session.projectId)?.sandbox);
    return session;
  }

  private projectLookup(id: string): Project {
    if (this.deletingProjects.has(id)) throw new HttpError(409, '项目正在删除');
    const project = this.projects.get(id);
    if (!project) throw new HttpError(404, '项目不存在');
    return project;
  }

  private projectOperation(id?: string): () => void {
    if (!id) return () => {};
    this.projectLookup(id);
    this.projectOperations.set(id, (this.projectOperations.get(id) ?? 0) + 1);
    return () => {
      const remaining = (this.projectOperations.get(id) ?? 1) - 1;
      if (remaining) this.projectOperations.set(id, remaining); else this.projectOperations.delete(id);
    };
  }

  listProjects(): ProjectSummary[] {
    return [...this.projects.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(project => this.projectSummary(project));
  }

  private projectSummary(project: Project): ProjectSummary {
    return structuredClone({ ...project, sessionCount: [...this.sessions.values()].filter(session => session.projectId === project.id).length,
      activeSessionId: this.activeProjects.get(project.id)?.values().next().value ?? null });
  }

  getProject(id: string): ProjectSummary { return this.projectSummary(this.projectLookup(id)); }

  private validateProjectInput(input: { name?: string; requirementUrl?: string | null }) {
    if (input.name !== undefined && (!input.name.trim() || input.name.trim().length > 100)) throw new HttpError(400, '项目名称须为 1 到 100 个字符');
    if (input.requirementUrl != null) {
      let url: URL;
      try { url = new URL(input.requirementUrl); } catch { throw new HttpError(400, '需求链接须为 HTTP 或 HTTPS URL'); }
      if (!['http:', 'https:'].includes(url.protocol) || input.requirementUrl.length > 4096) throw new HttpError(400, '需求链接须为 HTTP 或 HTTPS URL');
    }
  }

  async createProject(input: { name: string; requirementUrl?: string | null }, settings?: Settings): Promise<ProjectSummary> {
    if (this.closing) throw new HttpError(503, '服务正在关闭');
    this.validateProjectInput(input);
    const valid = await this.validateSettings(settings ?? { ...this.defaults, executionMode: 'e2b', workingDirectory: this.defaults.executionMode === 'e2b' ? this.defaults.workingDirectory : this.e2bWorkingDirectory });
    const now = new Date().toISOString();
    const project: Project = { id: randomUUID(), name: input.name.trim(), requirementUrl: input.requirementUrl ?? null, executionMode: valid.executionMode ?? 'local',
      workingDirectory: valid.workingDirectory, createdAt: now, updatedAt: now };
    await this.saveProject(project);
    this.projects.set(project.id, project);
    return this.getProject(project.id);
  }

  async updateProject(id: string, input: { name?: string; requirementUrl?: string | null }): Promise<ProjectSummary> {
    const project = this.projectLookup(id);
    this.validateProjectInput(input);
    const release = this.projectOperation(id);
    const previous = { name: project.name, requirementUrl: project.requirementUrl, updatedAt: project.updatedAt };
    const revision = (this.projectRevisions.get(id) ?? 0) + 1;
    this.projectRevisions.set(id, revision);
    const updatedAt = new Date().toISOString();
    try {
      if (input.name !== undefined) project.name = input.name.trim();
      if (input.requirementUrl !== undefined) project.requirementUrl = input.requirementUrl;
      project.updatedAt = updatedAt;
      await this.saveProject(project);
      return this.getProject(id);
    } catch (error) {
      // A failed edit must not become visible only in memory, or overwrite a later edit / sandbox callback.
      if (this.projectRevisions.get(id) === revision) {
        project.name = previous.name;
        project.requirementUrl = previous.requirementUrl;
        if (project.updatedAt === updatedAt) project.updatedAt = previous.updatedAt;
      }
      throw error;
    } finally { release(); }
  }

  async deleteProject(id: string) {
    const project = this.projectLookup(id);
    if (this.activeProjects.has(id) || this.projectOperations.has(id)) throw new HttpError(409, '项目正在使用，请先停止任务或稍后重试');
    this.deletingProjects.add(id);
    const sessions = [...this.sessions.values()].filter(session => session.projectId === id);
    try {
      for (const session of sessions) await Promise.allSettled([...(this.uploads.get(session.id) ?? [])]);
      await this.writes.get(`project:${id}`);
      if (project.executionMode === 'e2b' && project.sandbox) {
        if (!this.e2b) throw new HttpError(503, 'E2B 未配置，无法删除项目沙箱；项目记录已保留');
        const owner: Session = sessions[0] ? this.hydrate(sessions[0]) : { id: project.id, projectId: project.id, title: project.name, threadId: null,
          settings: { ...this.defaults, executionMode: project.executionMode, workingDirectory: project.workingDirectory }, sandbox: project.sandbox,
          status: 'idle', turns: [], createdAt: project.createdAt, updatedAt: project.updatedAt };
        await this.e2b.delete(owner);
      }
      for (const session of sessions) await this.removeSession(session.id);
      await rm(join(this.dataDirectory, 'projects', `${id}.json`));
      this.projects.delete(id);
      this.projectRevisions.delete(id);
      this.writes.delete(`project:${id}`);
    } finally { this.deletingProjects.delete(id); }
  }

  private async removeSession(id: string) {
    await this.writes.get(id);
    await rm(join(this.dataDirectory, `${id}.json`), { force: true });
    await rm(join(this.dataDirectory, 'images', id), { recursive: true, force: true });
    this.sessions.delete(id);
    this.subscribers.delete(id);
    this.writes.delete(id);
  }

  private saveProject(project: Project) {
    return this.saveRecord(`project:${project.id}`, join(this.dataDirectory, 'projects', `${project.id}.json`), project);
  }

  private async updateSandbox(projectId: string | undefined, sessionId: string, sandbox: NonNullable<Session['sandbox']>) {
    if (projectId) {
      const project = this.projects.get(projectId);
      if (!project || this.deletingProjects.has(projectId)) return;
      project.sandbox = structuredClone(sandbox);
      project.updatedAt = new Date().toISOString();
      await this.saveProject(project);
      if (this.deletingProjects.has(projectId)) return;
      for (const sibling of this.sessions.values()) {
        if (sibling.projectId !== projectId || this.deleting.has(sibling.id)) continue;
        sibling.sandbox = structuredClone(sandbox);
        await this.save(sibling);
        if (!this.deletingProjects.has(projectId) && !this.deleting.has(sibling.id)) this.publish(sibling.id, { type: 'state', session: this.get(sibling.id) });
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
    let project = input.projectId ? this.projectLookup(input.projectId) : undefined;
    let release = this.projectOperation(project?.id);
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
        release = this.projectOperation(project.id);
      }
      const now = new Date().toISOString();
      const session: Session = { id: randomUUID(), ...(project ? { projectId: project.id, ...(project.sandbox ? { sandbox: structuredClone(project.sandbox) } : {}) } : {}), threadId: input.threadId ?? null, title: input.title ?? '新任务', settings, status: 'idle', createdAt: now, updatedAt: now, turns: [] };
      await this.save(session);
      this.sessions.set(session.id, session);
      return this.get(session.id);
    } finally { release(); }
  }

  async update(id: string, input: { title?: string; settings?: Partial<Settings> }): Promise<Session> {
    const session = this.lookup(id);
    if (this.active.has(id)) throw new HttpError(409, '请先停止当前任务再修改会话');
    if (input.settings?.executionMode && input.settings.executionMode !== (session.settings.executionMode || 'local')) throw new HttpError(400, '已有会话不能切换执行环境，请新建任务');
    if (session.projectId && input.settings?.workingDirectory && posix.normalize(input.settings.workingDirectory) !== session.settings.workingDirectory) throw new HttpError(400, '项目会话不能修改工作目录');
    const settings = input.settings ? await this.validateSettings({ ...session.settings, ...input.settings }) : normalizeExecutionSettings(session.settings);
    this.lookup(id);
    // Re-check after filesystem validation so a concurrent turn cannot change settings mid-run.
    if (this.active.has(id)) throw new HttpError(409, '任务正在执行');
    session.settings = settings;
    if (input.title !== undefined) session.title = input.title;
    session.updatedAt = new Date().toISOString();
    await this.save(session);
    this.publish(id, { type: 'state', session: this.get(id) });
    return this.get(id);
  }

  async delete(id: string) {
    const session = this.lookup(id);
    if (this.active.has(id)) throw new HttpError(409, '请先停止当前任务');
    const release = this.projectOperation(session.projectId);
    this.deleting.add(id);
    try {
      await Promise.allSettled([...(this.uploads.get(id) ?? [])]);
      await this.writes.get(id);
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
    return this.saveRecord(session.id, join(this.dataDirectory, `${session.id}.json`), session);
  }

  private saveRecord(key: string, file: string, value: unknown): Promise<void> {
    const serialized = JSON.stringify(value);
    const operation = (this.writes.get(key) ?? Promise.resolve()).catch(() => {}).then(async () => {
      await writeFile(`${file}.tmp`, serialized, { mode: 0o600 });
      await rename(`${file}.tmp`, file);
    });
    this.writes.set(key, operation);
    return operation;
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
    if (this.active.has(id)) throw new HttpError(409, '当前会话已有任务正在执行');
    if (session.projectId) {
      const activeSessions = this.activeProjects.get(session.projectId) ?? new Set<string>();
      activeSessions.add(id);
      this.activeProjects.set(session.projectId, activeSessions);
    }
    const releaseProject = () => {
      if (!session.projectId) return;
      const activeSessions = this.activeProjects.get(session.projectId);
      activeSessions?.delete(id);
      if (!activeSessions?.size) this.activeProjects.delete(session.projectId);
    };
    const controller = new AbortController();
    const previous = structuredClone(session);
    // Reserve the session synchronously, before validating attachments or saving state.
    let finish!: () => void;
    const execution = { controller, done: new Promise<void>(resolve => { finish = resolve; }) };
    this.active.set(id, execution);
    try {
      session.settings = normalizeExecutionSettings(session.settings);
      const imageRoot = resolve(this.dataDirectory, 'images', id) + sep;
      for (const image of images) {
        let path: string;
        try { path = await realpath(image); } catch { throw new HttpError(400, '图片附件不存在，请重新上传'); }
        if (!path.startsWith(imageRoot)) throw new HttpError(400, '只能使用此会话上传的图片');
      }
      const turn: Turn = { id: randomUUID(), prompt, images, status: 'running', phase: 'starting', items: [], startedAt: new Date().toISOString() };
      session.turns.push(turn);
      session.status = 'running';
      session.updatedAt = turn.startedAt;
      if (session.title === '新任务') session.title = prompt.slice(0, 60);
      await this.save(session);
      this.publish(id, { type: 'state', session: this.get(id) });
      const running = this.run(session, turn, controller).finally(() => {
        this.active.delete(id);
        releaseProject();
        finish();
      });
      // run() handles failures; this catches only final persistence failure and keeps the process alive.
      void running.catch(error => console.error('Session persistence failed:', error instanceof Error ? error.message : 'unknown error'));
      return turn.id;
    } catch (error) {
      this.sessions.set(id, previous);
      this.active.delete(id);
      releaseProject();
      finish();
      this.publish(id, { type: 'state', session: this.get(id) });
      throw error;
    }
  }

  private async run(session: Session, turn: Turn, controller: AbortController) {
    let terminalFailure: string | undefined;
    const started = Date.now();
    const log = (event: string, extra: Record<string, unknown> = {}) => {
      void this.logger?.write({ event, sessionId: session.id, projectId: session.projectId, turnId: turn.id,
        threadId: session.threadId, model: session.settings.model, runtime: session.settings.executionMode ?? 'local',
        sandboxId: session.sandbox?.id, status: turn.status, ...extra });
    };
    log('turn.started');
    try {
      const { model, executionMode, ...settings } = session.settings;
      const options: ThreadOptions = { ...settings, ...(model ? { model } : {}), approvalPolicy: 'never', skipGitRepoCheck: true };
      let events: AsyncGenerator<AgentEvent>;
      if (executionMode === 'e2b') {
        if (!this.e2b) throw new HttpError(503, 'E2B 未配置，无法运行此沙箱会话');
        events = this.e2b.run(session, turn, controller.signal, sandbox => this.updateSandbox(session.projectId, session.id, sandbox));
      } else {
        const thread: Thread = session.threadId ? this.client.resumeThread(session.threadId, options) : this.client.startThread(options);
        const input: Input = turn.images.length ? [{ type: 'text', text: turn.prompt }, ...turn.images.map(path => ({ type: 'local_image' as const, path }))] : turn.prompt;
        ({ events } = await thread.runStreamed(input, { signal: controller.signal }));
      }
      let terminal = false;
      for await (const event of events) {
        // The CLI can emit the actual failure before throwing a generic nonzero
        // exit error. Only retain a terminal failure, never a recovered retry.
        if (event.type === 'turn.failed') terminalFailure = event.error.message.trim() ? event.error.message : undefined;
        else if (event.type === 'turn.started' || event.type === 'turn.completed') terminalFailure = undefined;
        this.applyEvent(session, turn, event);
        if (event.type === 'error') log('sdk.error', { error: event.message });
        else if (event.type === 'turn.failed') log('turn.failed', { error: event.error.message });
        else if (event.type === 'item.started' || event.type === 'item.completed') {
          const item = event.item;
          if (['command_execution', 'file_change', 'mcp_tool_call', 'web_search'].includes(item.type)) log('tool.' + event.type.slice(5), {
            toolType: item.type, toolId: item.id, ...('status' in item ? { status: item.status } : {}),
            ...(item.type === 'command_execution' ? { exitCode: item.exit_code } : {}),
          });
        }
        if (event.type === 'turn.completed' || event.type === 'turn.failed') terminal = true;
        await this.save(session);
        this.publish(session.id, { type: 'sdk', turnId: turn.id, event });
      }
      if (!terminal) throw new Error(turn.error || 'Codex 事件流提前结束，未收到完成事件');
    } catch (error) {
      turn.status = controller.signal.aborted ? 'cancelled' : 'failed';
      if (!controller.signal.aborted) turn.error = terminalFailure ?? (error instanceof Error ? error.message : String(error));
    } finally {
      if (controller.signal.aborted && turn.status === 'running') turn.status = 'cancelled';
      turn.completedAt = new Date().toISOString();
      delete turn.phase;
      delete turn.retry;
      session.status = turn.status;
      session.updatedAt = turn.completedAt;
      log('turn.finished', { status: turn.status, durationMs: Date.now() - started, error: turn.error });
      await this.save(session);
      this.publish(session.id, { type: 'state', session: this.get(session.id) });
    }
  }

  private applyEvent(session: Session, turn: Turn, event: AgentEvent) {
    if (event.type === 'thread.started') session.threadId = event.thread_id;
    Object.assign(turn, applyTurnEvent(turn, event));
  }

  async stop(id: string) {
    this.lookup(id);
    const execution = this.active.get(id);
    if (!execution) return;
    execution.controller.abort();
    await execution.done;
  }

  async waitForIdle(id: string) { await this.active.get(id)?.done; }

  async changes(id: string) {
    const session = this.lookup(id);
    if (session.settings.executionMode !== 'e2b') return getChanges(session.settings.workingDirectory);
    if (!this.e2b) throw new HttpError(503, 'E2B 未配置');
    const release = this.projectOperation(session.projectId);
    try { return await this.e2b.changes(session); } finally { release(); }
  }

  async rawTools(id: string, cursor: number, localReader: RawToolReader) {
    const session = this.lookup(id);
    if (session.settings.executionMode !== 'e2b') return localReader.read(session.threadId, cursor);
    if (!this.e2b) throw new HttpError(503, 'E2B 未配置');
    const release = this.projectOperation(session.projectId);
    try { return await this.e2b.rawTools(session, cursor); } finally { release(); }
  }

  async close() {
    this.closing = true;
    for (const execution of this.active.values()) execution.controller.abort();
    await Promise.allSettled([...this.active.values()].map(execution => execution.done));
    try {
      await this.e2b?.close();
      await Promise.allSettled([...this.writes.values()]);
    } finally { await this.logger?.flush(); }
  }
}
