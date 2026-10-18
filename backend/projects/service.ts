import type { ProjectImageSelection } from '../../protocol/image-types.js';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Project, ProjectStatus, ProjectType, Settings } from '../../protocol/types.js';
import { projectWeekOf } from '../../util/project-types.js';
import { HttpError } from '../../util/errors.js';
import { sandboxMounts } from '../../util/sandbox-mounts.js';
import type { SandboxState } from '../../protocol/sandbox-types.js';
import { RecordWriteQueue } from '../infra/storage/record-write-queue.js';
import { mergeRecord } from '../infra/storage/record-merge.js';
import type { WebStateStore } from '../infra/storage/web-state.js';

export type ProjectInput = { name?: string; requirementUrl?: string | null; type?: ProjectType; imageSelection?: ProjectImageSelection };
export type ProjectUpdate = Partial<Omit<ProjectInput, 'imageSelection'>> & { status?: ProjectStatus };

/** Owns project records and guards operations against concurrent deletion. */
export class ProjectService {
  private records = new Map<string, Project>();
  private deleting = new Set<string>();
  private activeSessions = new Map<string, Set<string>>();
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
      if (!this.shared && project.sandboxOperation?.status === 'running') {
        project.sandboxOperation = { ...project.sandboxOperation, status: 'unknown', error: '服务已重启，原请求结果未确认；请查询状态后决定下一步。', updatedAt: new Date().toISOString() };
        migratedStatus = true;
      }
      this.clearSandboxStatus(project);
      if (!this.shared && project.sandboxBackup?.status === 'running') {
        project.sandboxBackup = { ...project.sandboxBackup, status: 'unknown', error: '服务已重启，备份结果未确认；不会自动重新提交。', updatedAt: new Date().toISOString() };
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
      if (skipIds.has(id)) return;
      const project = this.saved.get(id) === baselines.get(id)
        ? snapshot.get(id)
        : await this.state.getProject(id);
      if (!project) { this.records.delete(id); this.saved.delete(id); return; }
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
      // A local write may have completed while the point read was in flight.
      // In that case its saved baseline changed, so re-read rather than applying
      // a snapshot that predates the write.
      const project = this.saved.get(id) === baseline ? snapshot : await this.state.getProject(id);
      if (!project) {
        this.records.delete(id);
        this.saved.delete(id);
        return;
      }
      this.clearSandboxStatus(project);
      this.records.set(id, project);
      this.saved.set(id, structuredClone(project));
    });
  }

  list(options: { includeRemoved?: boolean } = {}): Project[] {
    return [...this.records.values()].filter(project => options.includeRemoved || !project.removedAt).map(project => structuredClone(project));
  }
  find(id: string): Project | undefined { return structuredClone(this.records.get(id)); }
  isDeleting(id: string): boolean { return this.deleting.has(id); }
  activeSessionId(id: string): string | null { return this.activeSessions.get(id)?.values().next().value ?? null; }

  get(id: string): Project {
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
    if (id) this.get(id);
    return () => {};
  }

  /** Request-local cancellation; lifecycle operations do not invalidate readers. */
  beginRead(id?: string) {
    if (id) this.get(id);
    return { signal: new AbortController().signal, release: () => {} };
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

  async archiveAndDetachSandbox(id: string, sourceId?: string | null, cleanupPending = false): Promise<void> {
    await this.mutateSandboxMetadata(id, project => {
      if (sourceId !== undefined && (project.sandbox?.id ?? null) !== sourceId) throw new HttpError(409, '项目 Sandbox 已变化');
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

  async releaseSandbox(id: string, sandbox: SandboxState): Promise<void> {
    await this.mutateSandboxMetadata(id, project => {
      if (project.sandbox?.id !== sandbox.id) throw new HttpError(409, '项目 Sandbox 引用已变化，请检查已释放的实例。');
      const mounts = sandboxMounts(sandbox) ?? sandboxMounts(project.sandbox);
      if (mounts) project.sandboxMounts = mounts;
      if (sandbox.ownerKey) project.sandboxOwnerKey = sandbox.ownerKey;
      if (project.pendingSandboxCleanup) project.pendingSandboxCleanup = project.pendingSandboxCleanup.filter(value => value.id !== sandbox.id);
      delete project.sandbox;
      const at = new Date().toISOString();
      project.sandboxReclaimedAt = at;
      project.lifecycleHistory = [...(project.lifecycleHistory ?? []), { id: randomUUID(), action: 'released', at, sandboxId: sandbox.id }];
    });
  }

  async saveRemoteArchive(id: string, archive: NonNullable<Project['remoteArchives']>[number]): Promise<void> {
    await this.mutateSandboxMetadata(id, project => {
      project.remoteArchives = [structuredClone(archive), ...(project.remoteArchives ?? []).filter(item => item.id !== archive.id)];
      project.latestBackup = { createdAt: archive.createdAt, sizeBytes: archive.sizeBytes, checksum: archive.sha256 };
    });
  }
  async reconcileVolumeBackups(id: string, volumeId: string, archives: NonNullable<Project['remoteArchives']>): Promise<void> {
    await this.mutateSandboxMetadata(id, project => {
      const saved = new Map((project.remoteArchives ?? []).filter(ref => ref.storageType === 'cellbox-volume' && ref.volumeId === volumeId)
        .map(ref => [ref.id, ref]));
      project.remoteArchives = [...(project.remoteArchives ?? []).filter(ref => ref.storageType !== 'cellbox-volume' || ref.volumeId !== volumeId),
        ...archives.filter(ref => ref.storageType === 'cellbox-volume' && ref.volumeId === volumeId)
          .map(ref => ({ ...ref, threadIds: saved.get(ref.id)?.threadIds ?? ref.threadIds }))]
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      const latest = project.remoteArchives[0];
      project.latestBackup = latest ? { createdAt: latest.createdAt, sizeBytes: latest.sizeBytes,
        ...(latest.sha256 ? { checksum: latest.sha256 } : {}) } : undefined;
    });
  }

  async rememberVolumeCleanup(id: string, volumeId: string) {
    await this.mutateSandboxMetadata(id, project => {
      project.pendingVolumeCleanup = [...new Set([...(project.pendingVolumeCleanup ?? []), volumeId])];
    });
  }

  async finishVolumeCleanup(id: string, volumeId: string) {
    await this.mutateSandboxMetadata(id, project => {
      project.pendingVolumeCleanup = (project.pendingVolumeCleanup ?? []).filter(value => value !== volumeId);
      project.sandboxMounts = project.sandboxMounts?.filter(mount => mount.volumeId !== volumeId);
      if (!project.sandboxMounts?.length) { delete project.sandboxMounts; delete project.sandboxOwnerKey; }
    });
  }

  async markRemoved(id: string) {
    await this.mutateSandboxMetadata(id, project => {
      if (project.sandbox || project.sandboxMounts?.length || project.pendingSandboxCleanup?.length || project.pendingVolumeCleanup?.length)
        throw new HttpError(409, '仍有磁盘或运行环境待清理，项目记录已保留');
      project.removedAt = new Date().toISOString();
    });
  }
  async updateSandboxOperation(id: string, operation: Project['sandboxOperation'], expectedId?: string) {
    let applied = false;
    await this.mutateSandboxMetadata(id, project => {
      if (expectedId !== undefined && project.sandboxOperation?.id !== expectedId) return;
      // An older task may finish after a new request has been recorded.
      if (operation?.status !== 'running' && project.sandboxOperation?.id !== operation?.id) return;
      project.sandboxOperation = operation;
      applied = true;
    });
    return applied;
  }

  async updateSandboxBackup(id: string, backup: Project['sandboxBackup'], expectedId?: string) {
    await this.mutateSandboxMetadata(id, project => {
      if (expectedId !== undefined && project.sandboxBackup?.id !== expectedId) return;
      project.sandboxBackup = backup;
    });
  }

  async setPendingSandboxCleanup(id: string, sandboxes: NonNullable<Project['pendingSandboxCleanup']>) {
    await this.mutateSandboxMetadata(id, project => { project.pendingSandboxCleanup = structuredClone(sandboxes); });
  }

  async mergePendingSandboxCleanup(id: string, sandboxes: NonNullable<Project['pendingSandboxCleanup']>) {
    await this.mutateSandboxMetadata(id, project => {
      const merged = new Map((project.pendingSandboxCleanup ?? []).map(sandbox => [sandbox.id, sandbox]));
      for (const sandbox of sandboxes) merged.set(sandbox.id, structuredClone(sandbox));
      project.pendingSandboxCleanup = [...merged.values()];
    });
  }

  async finishSandboxCleanup(id: string, attempted: ReadonlySet<string>, remaining: NonNullable<Project['pendingSandboxCleanup']>) {
    await this.mutateSandboxMetadata(id, project => {
      const merged = new Map((project.pendingSandboxCleanup ?? []).filter(sandbox => !attempted.has(sandbox.id)).map(sandbox => [sandbox.id, sandbox]));
      for (const sandbox of remaining) merged.set(sandbox.id, structuredClone(sandbox));
      project.pendingSandboxCleanup = [...merged.values()];
    });
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

  private async mutateSandboxMetadata(id: string, mutate: (project: Project) => void, _commitLifecycle = false) {
    // Only our record is transactional; no remote request runs in this callback.
    await this.writer.run(id, async () => {
      const next = await this.state.mutateProject(id, current => {
        const before = structuredClone(current);
        mutate(current);
        this.clearSandboxStatus(current);
        if (!isDeepStrictEqual(before, current)) current.updatedAt = new Date().toISOString();
      });
      this.records.set(id, structuredClone(next));
      this.saved.set(id, structuredClone(next));
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
    if (weekOf && this.list().some(project => project.type === 3 && project.weekOf === weekOf)) {
      throw new HttpError(409, '本周项目已存在，每周只能创建一个');
    }
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
  }

  async update(id: string, input: ProjectUpdate): Promise<Project> {
    this.validate(input);
    await this.writer.run(id, async () => {
      const next = await this.state.mutateProject(id, project => {
        if (input.requirementUrl !== undefined) {
          if (project.type === 2 && !input.requirementUrl?.trim()) throw new HttpError(400, '飞书项目必须绑定飞书需求');
          if (project.type !== 2 && input.requirementUrl) throw new HttpError(400, '只有飞书项目可以绑定飞书需求');
          project.requirementUrl = input.requirementUrl;
        }
        if (input.name !== undefined) project.name = input.name.trim();
        const now = new Date().toISOString();
        if (input.status !== undefined && input.status !== project.status) {
          const from = project.status, to = input.status;
          if (!((from === 'active' && to === 'completed') || (from === 'completed' && to === 'active')
            || (from === 'archived' && to === 'active' && project.executionMode === 'local')))
            throw new HttpError(409, '项目只能在“使用中”和“已完成”之间切换；归档项目请使用恢复操作');
          project.status = to;
          project.completedAt = to === 'completed' ? now : null;
          if (to === 'active') project.archivedAt = null;
          project.lifecycleHistory = [...(project.lifecycleHistory ?? []), {
            id: randomUUID(), action: to === 'completed' ? 'completed' : 'restored', at: now,
            ...(project.sandbox ? { sandboxId: project.sandbox.id } : {}),
          }];
        }
        project.updatedAt = now;
      });
      this.records.set(id, structuredClone(next));
      this.saved.set(id, structuredClone(next));
    });
    return this.get(id);
  }

  async updateSandbox(id: string, sandbox: NonNullable<Project['sandbox']>, restoreProject = false, restoreImage?: ProjectImageSelection, expectedSandboxId?: string | null): Promise<boolean> {
    const project = this.records.get(id);
    if (!project || this.deleting.has(id)) return false;
    let applied = false;
    await this.mutateSandboxMetadata(id, next => {
      // Compare only our binding inside the record transaction; no remote lock.
      const expected = expectedSandboxId === undefined ? sandbox.id : expectedSandboxId;
      if (expectedSandboxId !== undefined && (next.sandbox?.id ?? null) !== expected && next.sandbox?.id !== sandbox.id) return;
      if (expectedSandboxId === undefined && !next.sandbox && (restoreProject || !next.sandboxReclaimedAt && next.status !== 'archived')) {
        // Initial creation can establish a previously absent binding.
      } else if (expectedSandboxId === undefined && next.sandbox?.id !== sandbox.id) return;
      applied = true;
      if (restoreProject) {
        delete next.sandboxMounts;
        delete next.sandboxOwnerKey;
        delete next.removedAt;
      }
      delete next.sandboxReclaimedAt;
      delete next.sandboxArtifactsCleanedAt;
      next.sandbox = structuredClone(sandbox);
      if (next.pendingSandboxCleanup) next.pendingSandboxCleanup = next.pendingSandboxCleanup.filter(value => value.id !== sandbox.id);
      const mounts = sandboxMounts(sandbox);
      if (mounts) next.sandboxMounts = mounts;
      const boundVolumes = new Set(mounts?.map(mount => mount.volumeId) ?? []);
      if (next.pendingVolumeCleanup) next.pendingVolumeCleanup = next.pendingVolumeCleanup.filter(id => !boundVolumes.has(id));
      if (sandbox.ownerKey) next.sandboxOwnerKey = sandbox.ownerKey;
      next.workingDirectory = sandbox.workingDirectory;
      if (restoreProject) next.imageSelection = restoreImage ? structuredClone(restoreImage) : undefined;
      const image = sandbox.image;
      if (next.imageSelection && image?.revisionId && image.templateId === next.imageSelection.templateId) {
        next.imageSelection = { ...next.imageSelection, revisionId: image.revisionId, versionId: image.revisionId,
          version: image.version ?? image.revisionId, image: image.reference };
      }
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
    return applied && !this.deleting.has(id);
  }

  /** Keep the deletion guard until dependent sessions and the sandbox have been removed. */
  async delete(id: string, removeDependents: (project: Project) => Promise<void>): Promise<void> {
    const project = this.get(id);
    this.deleting.add(id);
    try {
      await this.writer.wait(id);
      await removeDependents(project);
      await this.state.deleteProject(id);
      this.records.delete(id);
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
