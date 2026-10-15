import type { ProjectImageSelection } from '../../protocol/image-types.js';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Project, ProjectStatus, ProjectType, Settings } from '../../protocol/types.js';
import { projectWeekOf } from '../../util/project-types.js';
import { HttpError } from '../../util/errors.js';
import { RecordWriteQueue } from '../infra/storage/record-write-queue.js';
import { mergeRecord } from '../infra/storage/record-merge.js';
import type { WebStateStore } from '../infra/storage/web-state.js';

export type ProjectInput = { name?: string; requirementUrl?: string | null; type?: ProjectType; imageSelection?: ProjectImageSelection };
export type ProjectUpdate = Partial<Omit<ProjectInput, 'imageSelection'>> & { status?: ProjectStatus; backupRetentionCount?: number };

/** Owns project records and guards operations against concurrent deletion. */
export class ProjectService {
  private records = new Map<string, Project>();
  private revisions = new Map<string, number>();
  private deleting = new Set<string>();
  private operations = new Map<string, number>();
  private reads = new Map<string, Set<{ controller: AbortController; done: Promise<void> }>>();
  private activeSessions = new Map<string, Set<string>>();
  private maintenance = new Set<string>();
  private creatingWeeklyProjects = new Set<string>();
  private writer = new RecordWriteQueue();
  private saved = new Map<string, Project>();
  constructor(private state: WebStateStore, private requirementInfo: (url: string) => Promise<{ name: string; status: string | null }> = async () => { throw new HttpError(503, '尚未配置 system 项目的工具执行环境'); }, private now: () => Date = () => new Date(), private shared = false, private onCreate?: (projectId: string) => Promise<void>) {}

  async init() {
    for (const project of await this.state.listProjects()) {
      this.saved.set(project.id, structuredClone(project));
      if (!project.id || !project.name || !project.workingDirectory) throw new Error(`Invalid project state: ${project.id}`);
      // Older records used archivedAt as a two-state flag. Keep their archive
      // timestamp, but make the new lifecycle durable on first startup.
      let migratedStatus = false;
      if (!project.status) { project.status = project.archivedAt ? 'archived' : 'active'; migratedStatus = true; }
      if (project.status === 'completed' && !project.completedAt) { project.completedAt = project.updatedAt; migratedStatus = true; }
      if (project.status === 'archived' && !project.archivedAt) { project.archivedAt = project.updatedAt; migratedStatus = true; }
      if (!project.type) { project.type = project.requirementUrl ? 2 : 1; migratedStatus = true; }
      const recoverableResume = project.sandboxOperation?.kind === 'resume'
        && project.sandboxOperation.id && project.sandboxOperation.resume?.ownerId
        && project.sandboxOperation.resume.sandboxId === project.sandbox?.id;
      if (!this.shared && project.sandboxOperation?.status === 'running' && !recoverableResume) {
        project.sandboxOperation = { ...project.sandboxOperation, status: 'failed', error: '服务重启，操作未确认完成，请重试。', updatedAt: new Date().toISOString() };
        migratedStatus = true;
      }
      this.clearSandboxStatus(project);
      if (!this.shared && project.sandboxBackup?.status === 'running') {
        project.sandboxBackup = { ...project.sandboxBackup, status: 'failed',
          error: '服务重启，磁盘备份未确认完成；可重试备份或恢复运行。', updatedAt: new Date().toISOString() };
        migratedStatus = true;
      }
      this.records.set(project.id, project);
      if (migratedStatus) await this.save(project);
    }
  }

  async refresh(skipIds: ReadonlySet<string> = new Set()) {
    if (!this.shared) return;
    // Capture baseline identities before the list query. If a local save finishes
    // while that query is in flight, its new saved baseline tells us the list
    // snapshot may predate the write; only then do we need a point read.
    const baselines = new Map(this.saved);
    const projects = await this.state.listProjects();
    const snapshot = new Map(projects.map(project => [project.id, project]));
    const ids = new Set([...snapshot.keys(), ...this.records.keys()]);
    // Queue behind local writes. The bulk snapshot is sufficient unless a save
    // advanced this record's baseline after the snapshot began.
    await Promise.all([...ids].map(id => this.writer.run(id, async () => {
      if (skipIds.has(id) || this.maintenance.has(id) || this.operations.has(id)
        || this.deleting.has(id) || this.activeSessions.has(id)) return;
      const project = this.saved.get(id) === baselines.get(id)
        ? snapshot.get(id)
        : await this.state.getProject(id);
      if (!project) { this.cancelReads(id); this.records.delete(id); this.saved.delete(id); return; }
      if (project.sandboxOperation?.status === 'running' && project.sandboxOperation.kind !== 'resume') this.cancelReads(id);
      this.clearSandboxStatus(project);
      this.records.set(id, project);
      this.saved.set(id, structuredClone(project));
    })));
  }

  /** Refresh one shared project without scanning the project table. */
  async refreshOne(id: string) {
    if (!this.shared) return;
    const baseline = this.saved.get(id);
    const snapshot = await this.state.getProject(id);
    await this.writer.run(id, async () => {
      if (this.maintenance.has(id) || this.operations.has(id) || this.deleting.has(id)
        || this.activeSessions.has(id)) return;
      // A local write may have completed while the point read was in flight.
      // In that case its saved baseline changed, so re-read rather than applying
      // a snapshot that predates the write.
      const project = this.saved.get(id) === baseline ? snapshot : await this.state.getProject(id);
      if (!project) {
        this.cancelReads(id);
        this.records.delete(id);
        this.saved.delete(id);
        return;
      }
      if (project.sandboxOperation?.status === 'running' && project.sandboxOperation.kind !== 'resume') this.cancelReads(id);
      this.clearSandboxStatus(project);
      this.records.set(id, project);
      this.saved.set(id, structuredClone(project));
    });
  }

  list(): Project[] { return [...this.records.values()].map(project => structuredClone(project)); }
  find(id: string): Project | undefined { return structuredClone(this.records.get(id)); }
  isDeleting(id: string): boolean { return this.deleting.has(id); }
  isMaintaining(id: string): boolean { return this.maintenance.has(id) || this.records.get(id)?.sandboxOperation?.status === 'running'
    || this.records.get(id)?.sandboxBackup?.status === 'running'; }
  activeSessionId(id: string): string | null { return this.activeSessions.get(id)?.values().next().value ?? null; }

  get(id: string): Project {
    if (this.deleting.has(id)) throw new HttpError(409, '项目正在删除');
    const project = this.records.get(id);
    if (!project) throw new HttpError(404, '项目不存在');
    return structuredClone(project);
  }

  /** Import legacy records before attaching their existing sessions. */
  async import(project: Project): Promise<void> {
    project = structuredClone(project);
    this.clearSandboxStatus(project);
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

  /** Reads may run concurrently, but maintenance invalidates them instead of rejecting it. */
  beginRead(id?: string) {
    if (id) { this.get(id); this.assertAvailable(id); }
    const controller = new AbortController();
    let finish!: () => void;
    const done = new Promise<void>(resolve => { finish = resolve; });
    const entry = { controller, done };
    if (id) {
      const reads = this.reads.get(id) ?? new Set();
      reads.add(entry);
      this.reads.set(id, reads);
    }
    return {
      signal: controller.signal,
      release: () => {
        if (id) {
          const reads = this.reads.get(id);
          reads?.delete(entry);
          if (!reads?.size) this.reads.delete(id);
        }
        finish();
      },
    };
  }

  private cancelReads(id: string) {
    for (const read of this.reads.get(id) ?? []) {
      read.controller.abort(new HttpError(409, '项目环境正在切换，请刷新重试'));
    }
  }

  /** Wait for cancelled readers to release their underlying Sandbox leases. */
  async drainReads(id: string) {
    await Promise.all([...(this.reads.get(id) ?? [])].map(read => read.done));
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
    if (this.isMaintaining(id)) throw new HttpError(409, '项目沙箱正在维护，请稍后重试');
  }

  beginMaintenance(id: string): () => void {
    this.get(id);
    this.assertAvailable(id);
    if (this.activeSessions.has(id) || this.operations.has(id)) throw new HttpError(409, '项目正在使用，请等待任务和文件操作结束后重试');
    this.maintenance.add(id);
    this.cancelReads(id);
    return () => { this.maintenance.delete(id); };
  }

  async archiveAndDetachSandbox(id: string, sourceId?: string, cleanupPending = false): Promise<void> {
    await this.mutateSandboxMetadata(id, project => {
      if (sourceId && project.sandbox?.id !== sourceId) throw new HttpError(409, '项目 Sandbox 已变化');
      const at = new Date().toISOString();
      delete project.sandbox;
      if (!cleanupPending) {
        delete project.archiveCleanupSourceId;
        delete project.pendingSandboxCleanup;
      }
      project.sandboxReclaimedAt = at;
      if (cleanupPending) delete project.sandboxArtifactsCleanedAt;
      else project.sandboxArtifactsCleanedAt = at;
      project.status = 'archived'; project.completedAt = null; project.archivedAt = at;
      project.lifecycleHistory = [...(project.lifecycleHistory ?? []), { id: randomUUID(), action: 'archived', at, ...(sourceId ? { sandboxId: sourceId } : {}) }];
    }, true);
  }

  async saveRemoteArchive(id: string, archive: NonNullable<Project['remoteArchives']>[number]): Promise<void> {
    await this.mutateSandboxMetadata(id, project => {
      project.remoteArchives = [structuredClone(archive), ...(project.remoteArchives ?? []).filter(item => item.id !== archive.id)];
      project.latestBackup = { createdAt: archive.createdAt, sizeBytes: archive.sizeBytes, checksum: archive.sha256 };
    });
  }
  async removeRemoteArchive(id: string, archiveId: string): Promise<void> {
    await this.mutateSandboxMetadata(id, project => {
      if (project.remoteArchives?.[0]?.id === archiveId) throw new HttpError(409, '不能删除最新的远程归档');
      project.remoteArchives = (project.remoteArchives ?? []).filter(ref => ref.id !== archiveId);
    });
  }

  async updateSandboxOperation(id: string, operation: Project['sandboxOperation']) {
    await this.mutateSandboxMetadata(id, project => { project.sandboxOperation = operation; });
  }

  async updateSandboxBackup(id: string, backup: Project['sandboxBackup']) {
    await this.mutateSandboxMetadata(id, project => { project.sandboxBackup = backup; });
  }

  /** Atomically reserve or recover the current Box's resume operation. */
  async claimResume(id: string, ownerId: string, recovery?: { operationId: string; previousOwnerId: string }) {
    let started = false;
    let project!: Project;
    await this.writer.run(id, async () => {
      if (this.deleting.has(id) || this.maintenance.has(id) || this.activeSessions.has(id) || this.operations.has(id))
        throw new HttpError(409, '项目正在使用，请等待任务和文件操作结束后重试');
      project = await this.state.mutateProject(id, current => {
        if (current.status !== 'active' || !current.sandbox || current.archiveCleanupSourceId) {
          throw new HttpError(409, '项目没有可恢复的活动 Sandbox');
        }
        const sandboxId = current.sandbox.id;
        if (current.sandboxBackup?.status === 'running') throw new HttpError(409, '磁盘备份正在读取，请等待后恢复运行');
        const existing = current.sandboxOperation;
        if (recovery && (existing?.id !== recovery.operationId || existing.status !== 'running'
          || existing.resume?.ownerId !== recovery.previousOwnerId)) throw new HttpError(409, '恢复操作已变化');
        if (existing?.status === 'running') {
          if (existing.kind !== 'resume' || existing.resume?.sandboxId !== sandboxId) {
            throw new HttpError(409, '项目已有其他沙箱操作正在运行');
          }
          if (existing.resume.ownerId === ownerId && !recovery) return;
          if (!recovery) return;
          existing.resume = { sandboxId, ownerId };
          existing.updatedAt = new Date().toISOString();
          started = true;
          return;
        }
        const now = new Date().toISOString();
        current.sandboxOperation = {
          id: randomUUID(), kind: 'resume', phase: '恢复中', status: 'running', updatedAt: now,
          resume: { sandboxId, ownerId },
        };
        started = true;
      });
      this.clearSandboxStatus(project);
      // The transaction returned the merged latest row, so cache it as the new
      // baseline without re-saving over metadata edited by another API.
      this.records.set(id, structuredClone(project));
      this.saved.set(id, structuredClone(project));
    });
    return { project: structuredClone(project), started };
  }

  /** Complete only the resume claim that still owns this exact Box. */
  async finishResume(id: string, expected: { operationId: string; ownerId: string; sandboxId: string },
    outcome: { sandbox?: NonNullable<Project['sandbox']>; error?: string }): Promise<boolean> {
    let finished = false;
    let project!: Project;
    await this.writer.run(id, async () => {
      project = await this.state.mutateProject(id, current => {
        const operation = current.sandboxOperation;
        if (!operation || operation.status !== 'running' || operation.kind !== 'resume'
          || operation.id !== expected.operationId || operation.resume?.ownerId !== expected.ownerId
          || operation.resume.sandboxId !== expected.sandboxId || current.sandbox?.id !== expected.sandboxId) return;
        if (outcome.sandbox && outcome.sandbox.id !== expected.sandboxId) throw new HttpError(409, '恢复结果的 Sandbox 身份已变化');
        if (outcome.sandbox) {
          const merged = { ...current.sandbox, ...structuredClone(outcome.sandbox), status: 'unknown' as const };
          current.sandbox = merged;
          current.workingDirectory = merged.workingDirectory;
        }
        const now = new Date().toISOString();
        if (!outcome.error) {
          delete current.sandbox.pausedAt;
          if (!current.sandbox.lastActiveAt || current.sandbox.lastActiveAt < now) current.sandbox.lastActiveAt = now;
        }
        if (current.updatedAt < now) current.updatedAt = now;
        current.sandboxOperation = {
          ...operation,
          phase: outcome.error ? '恢复失败' : '恢复完成',
          status: outcome.error ? 'failed' : 'succeeded',
          // This is the result of this operation, not a live runtime cache.
          // Readers joining on another API can return the same committed result
          // without inspecting or reconnecting the sandbox a second time.
          result: !outcome.error && outcome.sandbox
            ? { sandbox: { ...structuredClone(current.sandbox), status: outcome.sandbox.status } } : undefined,
          ...(outcome.error ? { error: outcome.error } : { error: undefined }),
          updatedAt: now,
        };
        finished = true;
      });
      this.clearSandboxStatus(project);
      const local = this.records.get(id);
      if (local && this.operations.has(id)) {
        // A descriptive edit may already have reserved its own save while the
        // resume commit was in flight. Do not replace that edit's live object.
        local.sandbox = structuredClone(project.sandbox);
        local.sandboxOperation = structuredClone(project.sandboxOperation);
        local.workingDirectory = project.workingDirectory;
        if (local.updatedAt < project.updatedAt) local.updatedAt = project.updatedAt;
      } else this.records.set(id, structuredClone(project));
      this.saved.set(id, structuredClone(project));
    });
    return finished;
  }

  async setPendingSandboxCleanup(id: string, sandboxes: NonNullable<Project['pendingSandboxCleanup']>) {
    await this.mutateSandboxMetadata(id, project => { project.pendingSandboxCleanup = structuredClone(sandboxes); });
  }

  async prepareArchiveCleanup(id: string, sandbox: NonNullable<Project['sandbox']>) {
    await this.mutateSandboxMetadata(id, project => {
      project.archiveCleanupSourceId = sandbox.id;
      project.pendingSandboxCleanup = [...(project.pendingSandboxCleanup ?? []).filter(item => item.id !== sandbox.id), structuredClone(sandbox)];
    });
  }

  async markArchivedArtifactsCleaned(id: string) {
    await this.mutateSandboxMetadata(id, project => {
      if (project.status !== 'archived') throw new HttpError(409, '项目未归档');
      delete project.pendingSandboxCleanup;
      delete project.archiveCleanupSourceId;
      project.sandboxArtifactsCleanedAt = new Date().toISOString();
    });
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
      this.clearSandboxStatus(next);
      // Provider status is request-local. If the durable project is unchanged,
      // don't advance updatedAt or issue a full project write.
      if (isDeepStrictEqual(next, current)) return;
      next.updatedAt = new Date().toISOString();
      await this.state.saveProject(next, this.shared ? this.saved.get(id) : undefined);
      this.saved.set(id, structuredClone(next));
      // Commit only the fields this operation owns; an unrelated edit may have
      // reserved its own write while storage was pending.
      current.sandbox = next.sandbox;
      current.imageSelection = next.imageSelection;
      current.workingDirectory = next.workingDirectory;
      current.latestBackup = next.latestBackup;
	  current.remoteArchives = next.remoteArchives;
      current.sandboxReclaimedAt = next.sandboxReclaimedAt;
      current.sandboxArtifactsCleanedAt = next.sandboxArtifactsCleanedAt;
      current.sandboxOperation = next.sandboxOperation;
      current.sandboxBackup = next.sandboxBackup;
      current.pendingSandboxCleanup = next.pendingSandboxCleanup;
      current.archiveCleanupSourceId = next.archiveCleanupSourceId;
      if (commitLifecycle) {
        current.status = next.status;
        current.completedAt = next.completedAt;
        current.archivedAt = next.archivedAt;
        current.lifecycleHistory = next.lifecycleHistory;
      }
      current.updatedAt = next.updatedAt;
    });
  }

  /** Project records hold references. Only request-local Cellbox observations have a status. */
  private clearSandboxStatus(project: Project) {
    if (project.sandbox) project.sandbox.status = 'unknown';
    for (const sandbox of project.pendingSandboxCleanup ?? []) sandbox.status = 'unknown';
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
        ...(input.imageSelection ? { imageSelection: structuredClone(input.imageSelection) } : {}),
        executionMode: settings.executionMode ?? 'local', workingDirectory: settings.workingDirectory,
        status: 'active', completedAt: null, archivedAt: null, createdAt: now, updatedAt: now };
      await this.import(project);
      try { await this.onCreate?.(project.id); }
      catch (error) {
        await this.state.deleteProject(project.id);
        this.records.delete(project.id); this.saved.delete(project.id);
        throw error;
      }
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
    if (input.backupRetentionCount !== undefined && (!Number.isInteger(input.backupRetentionCount)
      || input.backupRetentionCount < 2 || input.backupRetentionCount > 100)) throw new HttpError(400, '备份保留数量须为 2 到 100');
    // Ordinary descriptive edits do not change Sandbox lifecycle state. Permit
    // them while a resume owns maintenance, but keep status transitions behind
    // the normal availability guard.
    const resumeMetadataEdit = input.status === undefined
      && project.sandboxOperation?.kind === 'resume'
      && project.sandboxOperation.status === 'running';
    if (resumeMetadataEdit) this.operations.set(id, (this.operations.get(id) ?? 0) + 1);
    const release = resumeMetadataEdit ? () => {
      const count = (this.operations.get(id) ?? 1) - 1;
      if (count) this.operations.set(id, count); else this.operations.delete(id);
    } : this.acquire(id);
    const baseline = structuredClone(project);
    const previous = {
      name: project.name, requirementUrl: project.requirementUrl, status: project.status, completedAt: project.completedAt, archivedAt: project.archivedAt,
      lifecycleHistory: structuredClone(project.lifecycleHistory), backupRetentionCount: project.backupRetentionCount, updatedAt: project.updatedAt,
    };
    const revision = (this.revisions.get(id) ?? 0) + 1;
    this.revisions.set(id, revision);
    const updatedAt = new Date().toISOString();
    try {
      if (input.name !== undefined) project.name = input.name.trim();
      if (input.requirementUrl !== undefined) project.requirementUrl = input.requirementUrl;
      if (input.backupRetentionCount !== undefined) project.backupRetentionCount = input.backupRetentionCount;
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
      await this.save(project, baseline);
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
        project.backupRetentionCount = previous.backupRetentionCount;
        if (project.updatedAt === updatedAt) project.updatedAt = previous.updatedAt;
      }
      throw error;
    } finally { release(); }
  }

  async updateSandbox(id: string, sandbox: NonNullable<Project['sandbox']>, restoreProject = false, restoreImage?: ProjectImageSelection): Promise<boolean> {
    const project = this.records.get(id);
    if (!project || this.deleting.has(id)) return false;
    await this.mutateSandboxMetadata(id, next => {
      delete next.sandboxReclaimedAt;
      delete next.sandboxArtifactsCleanedAt;
      next.sandbox = structuredClone(sandbox);
      next.workingDirectory = sandbox.workingDirectory;
      if (restoreProject) next.imageSelection = restoreImage ? structuredClone(restoreImage) : undefined;
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
    this.cancelReads(id);
    try {
      await this.drainReads(id);
      await this.writer.wait(id);
      await removeDependents(project);
      await this.state.deleteProject(id);
      this.records.delete(id);
      this.revisions.delete(id);
      this.writer.forget(id);
    } finally { this.deleting.delete(id); }
  }

  private save(project: Project, baseline?: Project): Promise<void> {
    const next = structuredClone(project);
    return this.writer.run(project.id, async () => {
      const previous = baseline ?? (this.shared ? this.saved.get(project.id) : undefined);
      const saved = baseline && this.saved.get(project.id)
        ? mergeRecord(baseline, next, this.saved.get(project.id)!) : next;
      await this.state.saveProject(next, previous);
      // A field-level edit may have merged over a concurrent resume completion.
      this.saved.set(project.id, structuredClone(saved));
    });
  }
  async close(): Promise<void> { await this.writer.drain(); }
}
