import { randomUUID } from 'node:crypto';
import type { Project, Settings } from '../../protocol/types.js';
import { HttpError } from '../../util/errors.js';
import { AtomicJsonWriter } from '../infra/storage/atomic-json.js';
import type { WebStateStore } from '../infra/storage/web-state.js';
import { readRequirementInfo } from './requirements.js';

export type ProjectInput = { name?: string; requirementUrl?: string | null };
export type ProjectUpdate = Partial<ProjectInput> & { archived?: boolean };

/** Owns project records and guards operations against concurrent deletion. */
export class ProjectService {
  private records = new Map<string, Project>();
  private revisions = new Map<string, number>();
  private deleting = new Set<string>();
  private operations = new Map<string, number>();
  private activeSessions = new Map<string, Set<string>>();
  private maintenance = new Set<string>();
  private writer = new AtomicJsonWriter();
  constructor(private state: WebStateStore, private requirementInfo: (url: string) => Promise<{ name: string; status: string | null }> = readRequirementInfo) {}

  async init() {
    for (const project of await this.state.listProjects()) {
      if (!project.id || !project.name || !project.workingDirectory) throw new Error(`Invalid project state: ${project.id}`);
      this.records.set(project.id, project);
      const legacy = project as Project & { retiredSandboxes?: unknown };
      const hadRetired = Object.hasOwn(legacy, 'retiredSandboxes');
      delete legacy.retiredSandboxes;
      // The project document is the commit record. An unfinished copy never
      // changes its current sandbox. Unbound candidates appear in inventory.
      if (project.sandboxUpgrade && project.sandboxUpgrade.phase !== 'failed') {
        const upgrade = project.sandboxUpgrade;
        upgrade.phase = 'failed';
        upgrade.error = '服务重启中断了数据归档或复原，当前沙箱保持不变。已完成的归档仍可使用。';
        await this.save(project);
      } else if (hadRetired) await this.save(project);
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

  /** Serialize a durable upgrade journal independently of session snapshots. */
  async saveUpgrade(id: string, upgrade: Project['sandboxUpgrade']): Promise<void> {
    await this.mutateSandboxMetadata(id, project => {
      project.sandboxUpgrade = structuredClone(upgrade);
    });
  }

  async saveDataArchive(id: string, archive: NonNullable<Project['sandboxDataArchive']>): Promise<void> {
    await this.mutateSandboxMetadata(id, project => {
      project.sandboxDataArchive = structuredClone(archive);
    });
  }

  async reclaimSandbox(id: string, sourceId: string): Promise<void> {
    await this.mutateSandboxMetadata(id, project => {
      if (project.sandbox?.id !== sourceId || project.sandboxDataArchive?.sourceSandboxId !== sourceId
        || project.sandboxUpgrade?.kind !== 'reclaim' || !this.maintenance.has(id)) {
        throw new HttpError(409, '回收记录与当前沙箱或归档不一致');
      }
      delete project.sandbox;
      delete project.sandboxUpgrade;
      project.sandboxReclaimedAt = new Date().toISOString();
    });
  }

  private async mutateSandboxMetadata(id: string, mutate: (project: Project) => void) {
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
      current.sandboxUpgrade = next.sandboxUpgrade;
      current.sandboxReclaimedAt = next.sandboxReclaimedAt;
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
  }

  async create(input: ProjectInput, settings: Settings): Promise<Project> {
    // A bound project's name is authoritative requirement metadata, fetched before any state is saved.
    const requirementUrl = input.requirementUrl?.trim() || null;
    this.validate({ requirementUrl });
    const info = requirementUrl ? await this.requirementInfo(requirementUrl) : null;
    const name = info?.name ?? input.name?.trim();
    if (!name) throw new HttpError(400, '请输入项目名称或绑定飞书需求');
    this.validate({ name });
    const now = new Date().toISOString();
    const project: Project = { id: randomUUID(), name, requirementUrl, ...(info ? { requirementStatus: info.status } : {}),
      executionMode: settings.executionMode ?? 'local', workingDirectory: settings.workingDirectory,
      archivedAt: null, createdAt: now, updatedAt: now };
    await this.import(project);
    return this.get(project.id);
  }

  async update(id: string, input: ProjectUpdate): Promise<Project> {
    this.get(id);
    this.validate(input);
    const project = this.records.get(id)!;
    const release = this.acquire(id);
    const previous = { name: project.name, requirementUrl: project.requirementUrl, archivedAt: project.archivedAt, updatedAt: project.updatedAt };
    const revision = (this.revisions.get(id) ?? 0) + 1;
    this.revisions.set(id, revision);
    const updatedAt = new Date().toISOString();
    try {
      if (input.name !== undefined) project.name = input.name.trim();
      if (input.requirementUrl !== undefined) project.requirementUrl = input.requirementUrl;
      if (input.archived !== undefined) project.archivedAt = input.archived ? project.archivedAt ?? updatedAt : null;
      project.updatedAt = updatedAt;
      await this.save(project);
      return this.get(id);
    } catch (error) {
      // Do not roll back a later edit or overwrite a concurrent sandbox callback.
      if (this.revisions.get(id) === revision) {
        project.name = previous.name;
        project.requirementUrl = previous.requirementUrl;
        project.archivedAt = previous.archivedAt;
        if (project.updatedAt === updatedAt) project.updatedAt = previous.updatedAt;
      }
      throw error;
    } finally { release(); }
  }

  async updateSandbox(id: string, sandbox: NonNullable<Project['sandbox']>): Promise<boolean> {
    const project = this.records.get(id);
    if (!project || this.deleting.has(id)) return false;
    await this.mutateSandboxMetadata(id, next => {
      if (next.sandbox && next.sandbox.id !== sandbox.id) {
        const upgrade = next.sandboxUpgrade;
        if (!upgrade || upgrade.source?.id !== next.sandbox.id || upgrade.target?.id !== sandbox.id || upgrade.phase !== 'verifying') {
          throw new HttpError(409, '沙箱替换没有已验证的升级记录');
        }
        delete next.sandboxUpgrade;
      }
      if (!next.sandbox && next.sandboxReclaimedAt) {
        const operation = next.sandboxUpgrade;
        if (operation?.phase !== 'verifying' || operation.target?.id !== sandbox.id) {
          throw new HttpError(409, '已回收项目只能绑定经过验证的复原环境');
        }
        delete next.sandboxUpgrade;
      }
      delete next.sandboxReclaimedAt;
      next.sandbox = structuredClone(sandbox);
    });
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
