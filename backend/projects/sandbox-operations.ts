import { traced, traceEvent } from '@co-cell/sandbox';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Project, ProjectSandboxOperation } from '../../protocol/types.js';
import type { SandboxState } from '../../protocol/sandbox-types.js';
import type { SandboxRuntime } from '../execution/container-runtime.js';
import type { WorkspaceTarget } from '../sandboxes/types.js';
import type { ProjectService } from './service.js';
import { HttpError, providerError, redactCredentials } from '../../util/errors.js';
import type { RuntimeLog } from '../infra/diagnostics/runtime-log.js';
import type { RemoteArchiveRef } from '../../protocol/remote-archive-types.js';
import { matchesRemoteArchive } from '../archives/remote.js';
import type { ProjectImageSelection } from '../../protocol/image-types.js';
import { querySandbox } from '../sandboxes/status.js';
import { BackupCatalogUnavailable } from '../sandboxes/cellbox-volume-backups.js';
import { sandboxMounts } from '../../util/sandbox-mounts.js';
import type { ProjectResumeObserver } from '../../protocol/resume-types.js';

type OperationOptions = { useExistingBackup?: boolean; imageVersionId?: string; onResumeProgress?: ProjectResumeObserver };

const target = (project: Project): WorkspaceTarget => ({ id: project.id, projectId: project.id,
  settings: { workingDirectory: project.workingDirectory }, imageSelection: project.imageSelection, sandbox: project.sandbox,
  sandboxMounts: project.sandboxMounts, sandboxOwnerKey: project.sandboxOwnerKey, updatedAt: project.updatedAt });

export class ProjectSandboxOperations {
  private activeOperations = new Set<Promise<void>>();
  private context = new AsyncLocalStorage<{ operation: ProjectSandboxOperation; project: Project;
    timing: { started: number; phaseStarted: number; phase: string } }>();
  constructor(private deps: {
    projects: ProjectService;
    runtime: SandboxRuntime;
    threadIds: (id: string) => string[];
    saveSandbox: (id: string, sandbox: SandboxState, restore: boolean, image?: ProjectImageSelection, expectedSandboxId?: string | null) => Promise<void>;
    selectRestoreImage?: (project: Project, versionId?: string) => Promise<{ selection?: ProjectImageSelection; release(): void | Promise<void> }>;
    detached: (id: string) => Promise<void>;
    released?: (id: string) => Promise<void>;
    logger?: Pick<RuntimeLog, 'write'>;
  }) {}

  private async phase(id: string, phase: string) {
    const scoped = this.context.getStore();
    if (!scoped) throw new Error('Sandbox request has no observation context');
    scoped.operation.phase = phase;
    scoped.operation.updatedAt = new Date().toISOString();
    await this.deps.projects.updateSandboxOperation(id, { ...scoped.operation }, scoped.operation.id);
    this.recordTiming(id, 'running', phase);
  }

  private recordTiming(id: string, status: string, nextPhase?: string) {
    const scoped = this.context.getStore();
    if (!scoped) return;
    const { operation, timing } = scoped;
    const now = Date.now();
    void this.deps.logger?.write({ event: 'sandbox.operation_phase', projectId: id,
      operationId: operation.id, operation: operation.kind, phase: timing.phase, status,
      startedAt: new Date(timing.phaseStarted).toISOString(), finishedAt: new Date(now).toISOString(),
      durationMs: now - timing.phaseStarted, totalDurationMs: now - timing.started,
      sandboxId: this.deps.projects.get(id).sandbox?.id });
    if (nextPhase) { timing.phase = nextPhase; timing.phaseStarted = now; }
  }

  private operationKey(id: string, step: 'capture' | 'restore'): string {
    const operation = this.context.getStore()?.operation;
    if (!operation?.id) throw new Error('Sandbox request has no observation ID');
    return `${operation.id}:${step}`;
  }

  private async latestRemote(id: string): Promise<RemoteArchiveRef> {
    const remote = this.deps.runtime.remoteArchives;
    if (!remote) throw new HttpError(503, 'Cellbox 归档不可用');
    const project = this.deps.projects.get(id);
    const references = remote.list ? await remote.list(target(project), project.remoteArchives ?? []) : project.remoteArchives ?? [];
    const reference = references[0];
    if (!reference) throw new HttpError(409, '未找到可恢复的最新 Cellbox 归档');
    if (reference.storageType === 'cellbox-volume') return reference;
    let inspected;
    try { inspected = await remote.inspect(reference); }
    catch { throw new HttpError(409, '最新 Cellbox 归档不可用，操作已停止'); }
    if (!matchesRemoteArchive(reference, inspected)) {
      throw new HttpError(409, '最新 Cellbox 归档与项目记录不符，操作已停止');
    }
    return reference;
  }

  async run(id: string, kind: ProjectSandboxOperation['kind'], options: OperationOptions = {}): Promise<void> {
    const { done } = await this.start(id, kind, options);
    await done;
  }

  /** Callers serialize project operations; each remote step is submitted once. */
  async start(id: string, kind: ProjectSandboxOperation['kind'], options: OperationOptions = {}): Promise<{ done: Promise<void> }> {
    const done = this.execute(id, kind, options);
    this.activeOperations.add(done);
    void done.finally(() => this.activeOperations.delete(done)).catch(() => {});
    return { done };
  }

  private async execute(id: string, kind: ProjectSandboxOperation['kind'], options: OperationOptions): Promise<void> {
    if (kind === 'delete') await this.deps.projects.markDeleting(id);
    else if (!(kind === 'restore' && this.deps.projects.get(id).removedAt)) this.deps.projects.assertAvailable(id);
    const project = this.deps.projects.get(id);
    if (project.executionMode !== 'sandbox') throw new HttpError(400, '此项目不使用 Sandbox');
    const selection = kind === 'restore' && this.deps.selectRestoreImage
      ? await this.deps.selectRestoreImage(project, options.imageVersionId) : undefined;
    const previous = kind === 'delete' && project.sandboxOperation?.kind === 'delete' ? project.sandboxOperation : undefined;
    const operation: ProjectSandboxOperation = { ...previous, id: previous?.id ?? randomUUID(), kind, phase: '提交操作', status: 'running',
      error: undefined, errorCode: undefined, cleanupError: undefined,
      ...(selection?.selection ? { imageSelection: selection.selection } : {}), updatedAt: new Date().toISOString() };
    await this.deps.projects.updateSandboxOperation(id, operation);
    const started = Date.now();
    const perform = async () => {
      try {
        if (kind === 'create') await this.create(id);
        else if (kind === 'resume') await this.resume(id, options.onResumeProgress);
        else if (kind === 'release') await this.release(id);
        else if (kind === 'rebuild') throw new HttpError(422, '当前 Cellbox 不支持同 ID 重建；可从备份创建新环境。');
        else if (kind === 'checkpoint') await this.checkpoint(id);
        else if (kind === 'restore') await this.restore(id, false, selection);
        else if (kind === 'backup') await this.backup(id);
        else if (kind === 'delete') await this.remove(id);
        else if (kind === 'refresh') throw new HttpError(422, '当前 Cellbox 不支持原地刷新；请选择明确版本创建新环境。');
        else await this.archive(id, options.useExistingBackup === true);
        operation.status = 'succeeded'; operation.phase = operation.cleanupError ? '操作完成，资源清理未完成' : '完成'; operation.updatedAt = new Date().toISOString();
        await this.deps.projects.updateSandboxOperation(id, { ...operation });
      } catch (error) {
        const detail = operationError(error);
        Object.assign(operation, { status: detail.unknown ? 'unknown' : 'failed', error: detail.message, errorCode: detail.code,
          phase: detail.unknown ? '请求结果未知' : operation.phase, updatedAt: new Date().toISOString() });
        await this.deps.projects.updateSandboxOperation(id, { ...operation });
        void this.deps.logger?.write({ event: 'sandbox.operation_failed', projectId: id, operationId: operation.id, kind, error });
        throw error;
      } finally {
        this.recordTiming(id, operation.status);
        await selection?.release();
      }
    };
    await this.context.run({ operation, project, timing: { started, phaseStarted: started, phase: operation.phase } },
      () => Promise.resolve().then(() => traced('project.sandbox.' + kind,
        { 'project.id': id, 'operation.id': operation.id!, 'sandbox.id': project.sandbox?.id }, perform)));
  }

  private async resume(id: string, onProgress?: ProjectResumeObserver) {
    const project = this.context.getStore()!.project;
    if (!project.sandbox || !this.deps.runtime.resume) throw new HttpError(409, '项目没有可恢复的 Sandbox');
    await this.phase(id, '恢复运行');
    const operationId = this.context.getStore()!.operation.id;
    await this.deps.runtime.resume(target(project), undefined, event => onProgress?.({ ...event, operationId }));
  }

  private async create(id: string) {
    const { projects, runtime } = this.deps;
    const project = projects.get(id);
    if (project.status === 'archived') throw new HttpError(409, '已归档项目须从备份恢复');
    await this.phase(id, '创建并准备环境');
    await runtime.rebuild(target(project), sandbox => this.deps.saveSandbox(id, sandbox, false, undefined, project.sandbox?.id ?? null));
    const candidate = projects.get(id).sandbox;
    if (!candidate) throw new Error('创建操作没有返回 Sandbox');
    await this.phase(id, '验证环境');
    if (!runtime.verifySandbox) throw new HttpError(503, 'Sandbox 不支持就绪验证');
    await runtime.verifySandbox(candidate);
    await this.deps.saveSandbox(id, { ...candidate, status: 'ready' }, false);
  }

  private async release(id: string) {
    const project = this.context.getStore()!.project;
    if (!project.sandbox) throw new HttpError(409, '项目没有可释放的 Sandbox');
    if (!this.deps.runtime.release) throw new HttpError(503, 'Sandbox 不支持保留磁盘的释放操作');
    await this.phase(id, '释放运行环境并保留磁盘');
    const sandbox = await this.deps.runtime.release(target(project));
    this.context.getStore()!.operation.result = { sandbox };
    await this.deps.projects.releaseSandbox(id, sandbox);
    await this.deps.released?.(id);
  }

  private async checkpoint(id: string) {
    const project = this.context.getStore()!.project;
    if (!project.sandbox) throw new HttpError(409, '项目没有可暂停的 Sandbox');
    if (!this.deps.runtime.checkpoint) throw new HttpError(503, 'Sandbox 不支持 Checkpoint');
    await this.phase(id, '保存 Checkpoint 并暂停');
    await this.deps.runtime.checkpoint(target(project));
  }

  private async inspect(id: string) {
    const project = structuredClone(this.context.getStore()?.project ?? this.deps.projects.get(id));
    if (project.sandbox) project.sandbox = await querySandbox(this.deps.runtime, project.sandbox);
    return project;
  }

  private async backup(id: string) {
    const project = this.deps.projects.get(id);
    const remote = this.deps.runtime.remoteArchives;
    if (!remote) throw new HttpError(503, 'Cellbox 备份不可用');
    const operation = this.context.getStore()!.operation;
    const previous = operation.kind === 'delete' && project.sandboxBackup?.id === operation.id ? project.sandboxBackup : undefined;
    let backup: NonNullable<Project['sandboxBackup']> = { ...previous, id: operation.id!,
      ...(project.sandbox ? { sandboxId: project.sandbox.id } : {}), status: 'running',
      phase: '提交磁盘备份', updatedAt: new Date().toISOString() };
    await this.deps.projects.updateSandboxBackup(id, backup);
    const started = Date.now();
    const threadIds = this.deps.threadIds(id);
    try {
      await this.phase(id, backup.phase);
      const captured = await remote.capture(target(project), this.operationKey(id, 'capture'), {
        ...(operation.kind === 'delete' ? {
          recovery: { operationId: previous?.remoteOperationId, snapshotIds: previous?.captureBaseline },
          onSnapshotBaseline: async (volumeId: string, snapshotIds: string[]) => {
            backup = { ...backup, volumeId, captureBaseline: snapshotIds };
            await this.deps.projects.updateSandboxBackup(id, backup, operation.id);
          },
        } : {}),
        onOperation: async (remoteOperationId, volumeId) => {
          Object.assign(operation, { remoteOperationId, volumeId });
          backup = { ...backup, remoteOperationId, volumeId, phase: 'Cellbox 备份中', updatedAt: new Date().toISOString() };
          await this.deps.projects.updateSandboxOperation(id, { ...operation }, operation.id);
          await this.deps.projects.updateSandboxBackup(id, backup, operation.id);
        },
      });
      const reference: RemoteArchiveRef = { ...captured, threadIds };
      const retentionError = reference.storageType === 'cellbox-volume' ? reference.retentionError : undefined;
      if (reference.storageType === 'cellbox-volume') delete reference.retentionError;
      await this.deps.projects.saveRemoteArchive(id, reference);
      let catalogError: string | undefined;
      if (reference.storageType === 'cellbox-volume' && remote.list) {
        const current = this.deps.projects.get(id);
        try {
          const catalog = await remote.list(target(current), (current.remoteArchives ?? []).filter(ref =>
            ref.storageType === 'cellbox-volume' && ref.volumeId === reference.volumeId));
          await this.deps.projects.reconcileVolumeBackups(id, reference.volumeId, catalog);
        } catch (error) {
          catalogError = operationError(error).message;
          void this.deps.logger?.write({ event: 'sandbox.backup_catalog_failed', projectId: id, volumeId: reference.volumeId, error });
        }
      }
      const outcome = { durationMs: Date.now() - started, ...(reference.sizeBytes === undefined ? {} : { sizeBytes: reference.sizeBytes }),
        ...(reference.storageType === 'cellbox-volume' ? { volumeId: reference.volumeId, snapshotId: reference.snapshotId,
          ...(reference.addedBytes === undefined ? {} : { addedBytes: reference.addedBytes }) } : {}),
        ...(retentionError ? { retentionError } : {}), ...(catalogError ? { catalogError } : {}), updatedAt: new Date().toISOString() };
      await this.deps.projects.updateSandboxBackup(id, { ...backup, ...outcome, phase: '完成', status: 'succeeded' }, operation.id);
      Object.assign(operation, outcome);
      await this.deps.projects.updateSandboxOperation(id, { ...operation }, operation.id);
      return reference;
    } catch (error) {
      const detail = operationError(error);
      if (error instanceof BackupCatalogUnavailable) {
        Object.assign(operation, { volumeId: error.volumeId, snapshotId: error.snapshotId });
        await this.deps.projects.updateSandboxBackup(id, { ...backup, volumeId: error.volumeId, snapshotId: error.snapshotId,
          status: 'succeeded', phase: '备份已完成，版本信息暂不可用', catalogError: detail.message,
          durationMs: Date.now() - started, updatedAt: new Date().toISOString() }, operation.id);
      } else {
        await this.deps.projects.updateSandboxBackup(id, { ...backup, status: detail.unknown ? 'unknown' : 'failed',
          error: detail.message, updatedAt: new Date().toISOString() }, operation.id);
      }
      throw error;
    }
  }

  private async rememberCleanup(id: string, sandbox: SandboxState) {
    await this.deps.projects.mergePendingSandboxCleanup(id, [sandbox]);
  }

  private async cleanup(id: string, archive = false, sourceIds?: ReadonlySet<string>) {
    const project = this.deps.projects.get(id);
    const remaining: SandboxState[] = [];
    let failed = false;
    let failure: unknown;
    for (const sandbox of project.pendingSandboxCleanup ?? []) {
      if (sourceIds && !sourceIds.has(sandbox.id)) { remaining.push(sandbox); continue; }
      if (sandbox.id === project.sandbox?.id && !archive) { remaining.push(sandbox); continue; }
      try {
        if (!this.deps.runtime.deleteDanglingSandbox) throw new Error('cleanup not supported');
        await this.deps.runtime.deleteDanglingSandbox(sandbox.id);
        // Keep the source journal until the archive state is committed, so a
        // restart after deletion can finish without selecting an older backup.
        if (archive && sandbox.id === project.archiveCleanupSourceId) remaining.push(sandbox);
      } catch (error) {
        failed = true; failure ??= error; remaining.push(sandbox);
        void this.deps.logger?.write({ event: 'sandbox.cleanup_failed', projectId: id, sandboxId: sandbox.id, error });
      }
    }
    await this.deps.projects.finishSandboxCleanup(id, new Set((project.pendingSandboxCleanup ?? []).map(sandbox => sandbox.id)), remaining);
    if (failed) {
      if (archive) throw failure;
      this.context.getStore()!.operation.cleanupError = operationError(failure).message;
    }
  }

  private async restore(id: string, allowHealthy = false, reservation?: { selection?: ProjectImageSelection }) {
    const { projects, runtime } = this.deps;
    const remote = runtime.remoteArchives;
    if (!remote) throw new HttpError(503, 'Cellbox 归档不可用');
    await this.phase(id, '校验最新归档');
    const reference = await this.latestRemote(id);
    if (!runtime.verifySandbox || !runtime.fenceSandbox || !runtime.detachSandbox) {
      throw new HttpError(503, 'Sandbox 不支持安全恢复');
    }
    const restoredProject = projects.get(id);
    if (reservation) restoredProject.imageSelection = reservation.selection;
    const currentImage = reference.storageType === 'cellbox-volume' ? undefined : await runtime.currentImageIdentity?.(target(restoredProject));
    if (reference.storageType !== 'cellbox-volume' && reference.storageType !== 'oss' && !reference.portable && currentImage && currentImage.id !== reference.imageId) {
      throw new HttpError(409, 'Cellbox 归档只能恢复到相同镜像，当前镜像已变化');
    }
    const project = await this.inspect(id);
    if (!allowHealthy && project.status !== 'archived' && project.sandbox?.status === 'ready') {
      throw new HttpError(409, 'Sandbox 正常，无需恢复环境');
    }
    await this.phase(id, '恢复数据');
    const candidate = await remote.restore(target(restoredProject), reference, this.operationKey(id, 'restore'),
      async sandbox => {
        await this.rememberCleanup(id, sandbox);
        void this.deps.logger?.write({ event: 'sandbox.operation_candidate', projectId: id,
          operationId: projects.get(id).sandboxOperation?.id, sandboxId: sandbox.id });
      }, {
        onOperation: async remoteOperationId => {
          this.context.getStore()!.operation.remoteOperationId = remoteOperationId;
          await projects.updateSandboxOperation(id, { ...this.context.getStore()!.operation }, this.context.getStore()!.operation.id);
        },
        onVolume: async ({ volumeId }) => {
          this.context.getStore()!.operation.candidateVolumeId = volumeId;
          await projects.rememberVolumeCleanup(id, volumeId);
          await projects.updateSandboxOperation(id, { ...this.context.getStore()!.operation }, this.context.getStore()!.operation.id);
        },
      });
    await this.rememberCleanup(id, candidate);
    if (restoredProject.imageSelection && candidate.image?.id !== restoredProject.imageSelection.image) {
      throw new HttpError(409, '恢复环境的镜像身份与所选版本不一致');
    }
    await this.phase(id, '验证环境');
    await remote.activate(candidate);
    await runtime.verifySandbox(candidate);
    await runtime.verifyHistory?.(candidate, reference.threadIds);
    // The old binding remains intact through staged restore and verification.
    await this.phase(id, '切换环境');
    if (project.sandbox) {
      await runtime.fenceSandbox(project.sandbox);
      await runtime.detachSandbox(target(project));
      await this.rememberCleanup(id, project.sandbox);
    }
    const boundVolumes = new Set((sandboxMounts(candidate) ?? []).map(mount => mount.volumeId));
    for (const mount of project.sandboxMounts ?? sandboxMounts(project.sandbox ?? {}) ?? [])
      if (!boundVolumes.has(mount.volumeId)) await projects.rememberVolumeCleanup(id, mount.volumeId);
    await this.deps.saveSandbox(id, { ...candidate, status: 'ready' }, true, restoredProject.imageSelection, project.sandbox?.id ?? null);
    await this.phase(id, '清理旧 Sandbox');
    await this.cleanup(id, false, new Set(project.sandbox ? [project.sandbox.id] : []));
  }

  private async archive(id: string, useExistingBackup: boolean) {
    const { projects } = this.deps;
    const project = await this.inspect(id);
    const originalTarget = target(project);
    if (project.status !== 'archived' || project.sandbox) {
      let captured: RemoteArchiveRef | undefined;
      if (project.archiveCleanupSourceId || useExistingBackup) {
        await this.latestRemote(id);
        // The operator explicitly accepted this immutable backup's date.
        // Stopping/deleting the source belongs to cleanup, not checkpointing.
      } else if (project.sandbox || project.sandboxMounts?.length) {
        captured = await this.backup(id);
      } else {
        throw new HttpError(409, '项目没有可备份的持久化目录，请确认使用已有备份归档');
      }
      const cleanupSource = project.sandbox;
      if (cleanupSource) await projects.prepareArchiveCleanup(id, cleanupSource);
      for (const mount of project.sandboxMounts ?? sandboxMounts(project.sandbox ?? {}) ?? [])
        await projects.rememberVolumeCleanup(id, mount.volumeId);
      if (captured?.storageType === 'cellbox-volume')
        await projects.rememberVolumeCleanup(id, captured.volumeId);
      // Commit the durable archive before reclaiming resources. A cleanup
      // failure must not turn a verified disk archive back into a live project.
      await projects.archiveAndDetachSandbox(id, project.sandbox?.id ?? null, true);
    }
    try {
      await this.cleanupArchived(id, originalTarget);
    } catch (error) {
      void this.deps.logger?.write({ event: 'sandbox.archive_cleanup_pending', projectId: id, error });
      const operation = this.context.getStore()!.operation;
      operation.cleanupError = operationError(error).message;
      await projects.updateSandboxOperation(id, { ...operation, updatedAt: new Date().toISOString() }, operation.id);
    }
  }

  private async cleanupArchived(id: string, originalTarget: WorkspaceTarget) {
    const { projects, runtime } = this.deps;
    await this.phase(id, '清理归档遗留资源');
    if (originalTarget.sandbox) {
      if (!runtime.detachSandbox) throw new HttpError(503, 'Sandbox 不支持释放项目连接');
      await runtime.detachSandbox(originalTarget);
    }
    const current = projects.get(id);
    if (runtime.listProjectSandboxes) {
      const observed = await runtime.listProjectSandboxes(id);
      // Reconcile recorded candidates with Cellbox's current resources. An absent
      // Box needs no destroy request; a failed inventory read stops cleanup.
      await projects.finishSandboxCleanup(id, new Set((current.pendingSandboxCleanup ?? []).map(sandbox => sandbox.id)), observed);
    }
    await this.cleanup(id, true);
    const afterBoxes = projects.get(id);
    const volumes = new Set([...(afterBoxes.pendingVolumeCleanup ?? []), ...(afterBoxes.sandboxMounts ?? []).map(mount => mount.volumeId)]);
    if (volumes.size && !runtime.remoteArchives?.removeVolume) throw new HttpError(503, 'Cellbox 磁盘清理不可用，项目记录已保留');
    for (const volumeId of volumes) {
      await this.phase(id, '清理已备份的磁盘');
      await runtime.remoteArchives!.removeVolume!(volumeId);
      await projects.finishVolumeCleanup(id, volumeId);
    }
    await this.deps.detached(id);
    await projects.markArchivedArtifactsCleaned(id);
  }

  private async remove(id: string) {
    const { projects } = this.deps;
    let project = projects.get(id);
    if (project.sandbox) {
      await this.release(id);
      project = projects.get(id);
      this.context.getStore()!.project = project;
    }
    if (project.sandboxMounts?.length) {
      const operation = this.context.getStore()!.operation;
      const saved = project.sandboxBackup;
      const captured = saved && saved.id === operation.id && saved.status === 'succeeded' && saved.volumeId && saved.snapshotId
        ? project.remoteArchives?.find(ref => ref.storageType === 'cellbox-volume'
          && ref.volumeId === saved.volumeId && ref.snapshotId === saved.snapshotId) : undefined;
      if (captured) {
        if (!this.deps.runtime.remoteArchives) throw new HttpError(503, 'Cellbox 备份不可用');
        await this.deps.runtime.remoteArchives.inspect(captured);
      } else await this.backup(id);
    }
    else if (project.remoteArchives?.length) await this.latestRemote(id);
    for (const mount of project.sandboxMounts ?? []) await projects.rememberVolumeCleanup(id, mount.volumeId);
    await projects.archiveAndDetachSandbox(id, null, true);
    await this.cleanupArchived(id, target(project));
  }

  async close() { await Promise.allSettled(this.activeOperations); }
}

function operationError(error: unknown): { code?: string; message: string; unknown: boolean } {
  const provider = providerError(error);
  if (provider) return { ...provider, unknown: ['UNKNOWN_OUTCOME', 'TRANSPORT'].includes(provider.code) };
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current && typeof current === 'object'; depth++) {
    const detail = current as { code?: string; message?: string; cause?: unknown };
    if (detail.code) return { code: detail.code, message: redactCredentials(detail.message ?? String(detail.code)), unknown: ['UNKNOWN_OUTCOME', 'TRANSPORT'].includes(detail.code) };
    current = detail.cause;
  }
  return { message: error instanceof Error ? redactCredentials(error.message) : '操作未完成', unknown: false };
}
