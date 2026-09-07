import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Project, Settings } from '../../shared/types.js';
import { HttpError } from '../core/errors.js';
import { AtomicJsonWriter } from '../storage/atomic-json.js';

export type ProjectInput = { name: string; requirementUrl?: string | null };
export type ProjectUpdate = Partial<ProjectInput> & { archived?: boolean };

/** Owns project records and guards operations against concurrent deletion. */
export class ProjectService {
  private records = new Map<string, Project>();
  private revisions = new Map<string, number>();
  private deleting = new Set<string>();
  private operations = new Map<string, number>();
  private activeSessions = new Map<string, Set<string>>();
  private writer = new AtomicJsonWriter();
  private directory: string;

  constructor(dataDirectory: string) { this.directory = join(dataDirectory, 'projects'); }

  async init() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    for (const name of await readdir(this.directory)) {
      if (!/^[\da-f-]{36}\.json$/.test(name)) continue;
      const project = JSON.parse(await readFile(join(this.directory, name), 'utf8')) as Project;
      if (name !== `${project.id}.json` || !project.name || !project.workingDirectory) throw new Error(`Invalid project state: ${name}`);
      this.records.set(project.id, project);
    }
  }

  list(): Project[] { return [...this.records.values()].map(project => structuredClone(project)); }
  find(id: string): Project | undefined { return structuredClone(this.records.get(id)); }
  isDeleting(id: string): boolean { return this.deleting.has(id); }
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
    this.operations.set(id, (this.operations.get(id) ?? 0) + 1);
    return () => {
      const remaining = (this.operations.get(id) ?? 1) - 1;
      if (remaining) this.operations.set(id, remaining); else this.operations.delete(id);
    };
  }

  startSession(projectId: string | undefined, sessionId: string): () => void {
    if (!projectId) return () => {};
    this.get(projectId);
    const sessions = this.activeSessions.get(projectId) ?? new Set<string>();
    sessions.add(sessionId);
    this.activeSessions.set(projectId, sessions);
    return () => {
      sessions.delete(sessionId);
      if (!sessions.size) this.activeSessions.delete(projectId);
    };
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
    this.validate(input);
    const now = new Date().toISOString();
    const project: Project = { id: randomUUID(), name: input.name.trim(), requirementUrl: input.requirementUrl ?? null,
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
    project.sandbox = structuredClone(sandbox);
    project.updatedAt = new Date().toISOString();
    await this.save(project);
    return !this.deleting.has(id);
  }

  /** Keep the deletion guard until dependent sessions and the sandbox have been removed. */
  async delete(id: string, removeDependents: (project: Project) => Promise<void>): Promise<void> {
    const project = this.get(id);
    if (this.activeSessions.has(id) || this.operations.has(id)) throw new HttpError(409, '项目正在使用，请先停止任务或稍后重试');
    this.deleting.add(id);
    try {
      await this.writer.wait(id);
      await removeDependents(project);
      await rm(join(this.directory, `${id}.json`));
      this.records.delete(id);
      this.revisions.delete(id);
      this.writer.forget(id);
    } finally { this.deleting.delete(id); }
  }

  private save(project: Project): Promise<void> {
    return this.writer.write(project.id, join(this.directory, `${project.id}.json`), project);
  }
  async close(): Promise<void> { await this.writer.drain(); }
}
