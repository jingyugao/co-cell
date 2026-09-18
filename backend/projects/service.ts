import { randomUUID } from 'node:crypto';
import type { Project, ProjectStatus, ProjectType, Settings } from '../../protocol/types.js';
import { projectWeekOf } from '../../util/project-types.js';
import { HttpError } from '../../util/errors.js';
import { AtomicJsonWriter } from '../infra/storage/atomic-json.js';
import type { WebStateStore } from '../infra/storage/web-state.js';
import { readRequirementInfo } from './requirements.js';

export type ProjectInput = { name?: string; requirementUrl?: string | null; type?: ProjectType };
export type ProjectUpdate = Partial<ProjectInput> & { status?: ProjectStatus };

/** Owns project records and guards operations against concurrent deletion. */
export class ProjectService {
  private records = new Map<string, Project>();
  private revisions = new Map<string, number>();
  private deleting = new Set<string>();
  private operations = new Map<string, number>();
  private activeSessions = new Map<string, Set<string>>();
  private maintenance = new Set<string>();
  private creatingWeeklyProjects = new Set<string>();
  private writer = new AtomicJsonWriter();
  constructor(private state: WebStateStore, private requirementInfo: (url: string) => Promise<{ name: string; status: string | null }> = readRequirementInfo, private now: () => Date = () => new Date()) {}

  async init() {
    for (const project of await this.state.listProjects()) {
      if (!project.id || !project.name || !project.workingDirectory) throw new Error(`Invalid project state: ${project.id}`);
      // Older records used archivedAt as a two-state flag. Keep their archive
      // timestamp, but make the new lifecycle durable on first startup.
      let migratedStatus = false;
      if (!project.status) { project.status = project.archivedAt ? 'archived' : 'active'; migratedStatus = true; }
      if (project.status === 'completed' && !project.completedAt) { project.completedAt = project.updatedAt; migratedStatus = true; }
      if (project.status === 'archived' && !project.archivedAt) { project.archivedAt = project.updatedAt; migratedStatus = true; }
      if (!project.type) { project.type = project.requirementUrl ? 2 : 1; migratedStatus = true; }
      this.records.set(project.id, project);
      if (migratedStatus) await this.save(project);
    }
  }

  list(): Project[] { return [...this.records.values()].map(project => structuredClone(project)); }
  find(id: string): Project | undefined { return structuredClone(this.records.get(id)); }
  isDeleting(id: string): boolean { return this.deleting.has(id); }
  isMaintaining(id: string): boolean { return this.maintenance.has(id); }
  activeSessionId(id: string): string | null { return this.activeSessions.get(id)?.values().next().value ?? null; }

  get(id: string): Project {
    if (this.deleting.has(id)) throw new HttpError(409, '项目正在删除');
    const project = this.records.get(id);
    if (!project) throw new HttpError(404, '项目不存在');
    return structuredClone(project);
  }

  /** Import legacy records before attaching their existing sessions. */
  async import(project: Project): Promise<void> {
    await this.save(project);
    this.records.set(project.id, structuredClone(project));
  }

  acquire(id?: string): () => void {
    if (!id) return () => {};
    this.get(id);
    this.assertAvailable(id);
    this.operations.set(id, (this.operations.get(id) ?? 0) + 1);
    return () => {
      const remaining = (this.operations.get(id) ?? 1) - 1;
      if (remaining) this.operations.set(id, remaining); else this.operations.delete(id);
    };
  }

  startSession(projectId: string | undefined, sessionId: string): () => void {
    if (!projectId) return () => {};
    this.get(projectId);
    this.assertAvailable(projectId);
    const sessions = this.activeSessions.get(projectId) ?? new Set<string>();
    sessions.add(sessionId);
    this.activeSessions.set(projectId, sessions);
    return () => {
      sessions.delete(sessionId);
      if (!sessions.size) this.activeSessions.delete(projectId);
    };
  }

  private assertAvailable(id: string) {
    if (this.maintenance.has(id)) throw new HttpError(409, '项目沙箱正在维护，请稍后重试');
  }

  beginMaintenance(id: string): () => void {
    this.get(id);
    this.assertAvailable(id);
    if (this.activeSessions.has(id) || this.operations.has(id)) throw new HttpError(409, '项目正在使用，请等待任务和文件操作结束后重试');
    this.maintenance.add(id);
    return () => { this.maintenance.delete(id); };
  }

  async archiveAndDetachSandbox(id: string, sourceId?: string): Promise<void> {
    await this.mutateSandboxMetadata(id, project => {
      if (sourceId && project.sandbox?.id !== sourceId) throw new HttpError(409, '项目 Sandbox 已变化');
      const at = new Date().toISOString();
      delete project.sandbox;
      project.sandboxReclaimedAt = at;
      project.status = 'archived'; project.completedAt = null; project.archivedAt = at;
      project.lifecycleHistory = [...(project.lifecycleHistory ?? []), { id: randomUUID(), action: 'archived', at, ...(sourceId ? { sandboxId: sourceId } : {}) }];
    }, true);
  }

  async saveDataArchive(id: string, archive: NonNullable<Project['sandboxDataArchive']>): Promise<void> {
    // Record first: if the project pointer write fails, the immutable archive
    // remains discoverable in the ledger. Historical rows are never updated.
    await this.state.recordProjectArchive(id, archive);
    await this.mutateSandboxMetadata(id, project => { project.sandboxDataArchive = structuredClone(archive); });
  }

  latestDataArchive(id: string) {
    this.get(id);
    return this.state.latestProjectArchive(id);
  }

  /** 保存项目的归档流 key */
  async saveArchiveKey(id: string, archiveKey: string): Promise<void> {
    await this.mutateSandboxMetadata(id, project => { project.archiveKey = archiveKey; });
  }

  /** 更新项目上的 sandboxDataArchive（用于前端展示，不写入 project_sandbox_archives 表） */
  async updateSandboxDataArchive(id: string, archive: NonNullable<Project['sandboxDataArchive']>): Promise<void> {
    await this.mutateSandboxMetadata(id, project => { project.sandboxDataArchive = structuredClone(archive); });
  }

  /** 获取项目的归档流 key */
  getArchiveKey(id: string): string | undefined {
    return this.records.get(id)?.archiveKey;
  }

  private async mutateSandboxMetadata(id: string, mutate: (project: Project) => void, commitLifecycle = false) {
    await this.writer.run(id, async () => {
      const current = this.records.get(id);
      if (!current || this.deleting.has(id)) throw new HttpError(409, '项目已删除或正在删除');
      const next = structuredClone(current);
      // Preserve the idle baseline of legacy records before maintenance writes
      // advance updatedAt; failed maintenance is not fresh user activity.
      if (next.sandbox && !next.sandbox.lastActiveAt) next.sandbox.lastActiveAt = current.updatedAt;
      mutate(next);
      next.updatedAt = new Date().toISOString();
      await this.state.saveProject(next);
      // Commit only the fields this operation owns; an unrelated edit may have
      // reserved its own write while storage was pending.
      current.sandbox = next.sandbox;
      current.sandboxDataArchive = next.sandboxDataArchive;
      current.archiveKey = next.archiveKey;
      current.sandboxReclaimedAt = next.sandboxReclaimedAt;
      if (commitLifecycle) {
        current.status = next.status;
        current.completedAt = next.completedAt;
        current.archivedAt = next.archivedAt;
        current.lifecycleHistory = next.lifecycleHistory;
      }
      current.updatedAt = next.updatedAt;
    });
  }

  private validate(input: Partial<ProjectInput>) {
    if (input.name !== undefined && (!input.name.trim() || input.name.trim().length > 100)) throw new HttpError(400, '项目名称须为 1 到 100 个字符');
    if (input.requirementUrl != null) {
      let url: URL;
      try { url = new URL(input.requirementUrl); } catch { throw new HttpError(400, '需求链接须为 HTTP 或 HTTPS URL'); }
      if (!['http:', 'https:'].includes(url.protocol) || input.requirementUrl.length > 4096) throw new HttpError(400, '需求链接须为 HTTP 或 HTTPS URL');
    }
    if (input.type !== undefined && ![1, 2, 3].includes(input.type)) throw new HttpError(400, '项目类型无效');
  }

  async create(input: ProjectInput, settings: Settings): Promise<Project> {
    // A bound project's name is authoritative requirement metadata, fetched before any state is saved.
    const type = input.type ?? (input.requirementUrl ? 2 : 1);
    const requirementUrl = input.requirementUrl?.trim() || null;
    this.validate({ requirementUrl, type });
    if (type === 2 && !requirementUrl) throw new HttpError(400, '飞书项目必须绑定飞书需求');
    if (type !== 2 && requirementUrl) throw new HttpError(400, '只有飞书项目可以绑定飞书需求');
    const weekOf = type === 3 ? projectWeekOf(this.now()) : undefined;
    if (weekOf && (this.creatingWeeklyProjects.has(weekOf) || this.list().some(project => project.type === 3 && project.weekOf === weekOf))) {
      throw new HttpError(409, '本周项目已存在，每周只能创建一个');
    }
    if (weekOf) this.creatingWeeklyProjects.add(weekOf);
    try {
      const info = requirementUrl ? await this.requirementInfo(requirementUrl) : null;
      const name = info?.name ?? input.name?.trim();
      if (!name) throw new HttpError(400, '请输入项目名称或绑定飞书需求');
      this.validate({ name });
      const now = this.now().toISOString();
      const project: Project = { id: randomUUID(), name, type, ...(weekOf ? { weekOf } : {}), requirementUrl, ...(info ? { requirementStatus: info.status } : {}),
        executionMode: settings.executionMode ?? 'local', workingDirectory: settings.workingDirectory,
        status: 'active', completedAt: null, archivedAt: null, createdAt: now, updatedAt: now };
      await this.import(project);
      return this.get(project.id);
    } finally { if (weekOf) this.creatingWeeklyProjects.delete(weekOf); }
  }

  async update(id: string, input: ProjectUpdate): Promise<Project> {
    this.get(id);
    this.validate(input);
    const project = this.records.get(id)!;
    if (input.requirementUrl !== undefined) {
      if (project.type === 2 && !input.requirementUrl?.trim()) throw new HttpError(400, '飞书项目必须绑定飞书需求');
      if (project.type !== 2 && input.requirementUrl) throw new HttpError(400, '只有飞书项目可以绑定飞书需求');
    }
    const release = this.acquire(id);
    const previous = {
      name: project.name, requirementUrl: project.requirementUrl, status: project.status, completedAt: project.completedAt, archivedAt: project.archivedAt,
      lifecycleHistory: structuredClone(project.lifecycleHistory), updatedAt: project.updatedAt,
    };
    const revision = (this.revisions.get(id) ?? 0) + 1;
    this.revisions.set(id, revision);
    const updatedAt = new Date().toISOString();
    try {
      if (input.name !== undefined) project.name = input.name.trim();
      if (input.requirementUrl !== undefined) project.requirementUrl = input.requirementUrl;
      const requestedStatus = input.status;
      if (requestedStatus !== undefined && requestedStatus !== project.status) {
        const from = project.status;
        const to = requestedStatus;
        if (!((from === 'active' && to === 'completed') || (from === 'completed' && to === 'active')
          || (from === 'archived' && to === 'active' && project.executionMode === 'local'))) {
          throw new HttpError(409, '项目只能在“使用中”和“已完成”之间切换；归档项目请使用恢复操作');
        }
        project.status = to;
        project.completedAt = to === 'completed' ? updatedAt : null;
        if (to === 'active') project.archivedAt = null;
        if (from !== to) {
          project.lifecycleHistory = [...(project.lifecycleHistory ?? []), {
            id: randomUUID(), action: to === 'completed' ? 'completed' : 'restored', at: updatedAt,
            ...(project.sandbox ? { sandboxId: project.sandbox.id } : {}),
          }];
        }
      }
      project.updatedAt = updatedAt;
      await this.save(project);
      return this.get(id);
    } catch (error) {
      // Do not roll back a later edit or overwrite a concurrent sandbox callback.
      if (this.revisions.get(id) === revision) {
        project.name = previous.name;
        project.requirementUrl = previous.requirementUrl;
        project.status = previous.status;
        project.completedAt = previous.completedAt;
        project.archivedAt = previous.archivedAt;
        project.lifecycleHistory = previous.lifecycleHistory;
        if (project.updatedAt === updatedAt) project.updatedAt = previous.updatedAt;
      }
      throw error;
    } finally { release(); }
  }

  async updateSandbox(id: string, sandbox: NonNullable<Project['sandbox']>, restoreProject = false): Promise<boolean> {
    const project = this.records.get(id);
    if (!project || this.deleting.has(id)) return false;
    await this.mutateSandboxMetadata(id, next => {
      delete next.sandboxReclaimedAt;
      next.sandbox = structuredClone(sandbox);
      if (restoreProject && next.status === 'archived') {
        const at = new Date().toISOString();
        next.status = 'active';
        next.completedAt = null;
        next.archivedAt = null;
        next.lifecycleHistory = [...(next.lifecycleHistory ?? []), {
          id: randomUUID(), action: 'restored', at, sandboxId: sandbox.id,
        }];
      }
    }, restoreProject);
    return !this.deleting.has(id);
  }

  /** Keep the deletion guard until dependent sessions and the sandbox have been removed. */
  async delete(id: string, removeDependents: (project: Project) => Promise<void>): Promise<void> {
    const project = this.get(id);
    if (this.activeSessions.has(id) || this.operations.has(id) || this.maintenance.has(id)) throw new HttpError(409, '项目正在使用，请先停止任务或稍后重试');
    this.deleting.add(id);
    try {
      await this.writer.wait(id);
      await removeDependents(project);
      await this.state.deleteProject(id);
      this.records.delete(id);
      this.revisions.delete(id);
      this.writer.forget(id);
    } finally { this.deleting.delete(id); }
  }

  private save(project: Project): Promise<void> {
    return this.writer.run(project.id, () => this.state.saveProject(project));
  }
  async close(): Promise<void> { await this.writer.drain(); }
}
