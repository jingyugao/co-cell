import { traced, traceEvent } from '@co-cell/sandbox';
import { randomUUID } from 'node:crypto';
import type { Project, ProjectSandboxOperation } from '../../protocol/types.js';
import type { SandboxState } from '../../protocol/sandbox-types.js';
import type { SandboxRuntime } from '../execution/container-runtime.js';
import type { WorkspaceTarget } from '../sandboxes/types.js';
import type { ProjectService } from './service.js';
import { HttpError } from '../../util/errors.js';
import type { RuntimeLog } from '../infra/diagnostics/runtime-log.js';
import type { RemoteArchiveRef } from '../../protocol/remote-archive-types.js';
import { matchesRemoteArchive } from '../archives/remote.js';
import { pruneRemoteArchives } from '../archives/retention.js';
import type { ProjectImageSelection } from '../../protocol/image-types.js';
import { querySandbox } from '../sandboxes/status.js';

type OperationOptions = { useExistingBackup?: boolean; imageVersionId?: string };

const target = (project: Project): WorkspaceTarget => ({ id: project.id, projectId: project.id,
  settings: { workingDirectory: project.workingDirectory }, imageSelection: project.imageSelection, sandbox: project.sandbox, updatedAt: project.updatedAt });

export class ProjectSandboxOperations {
  private tasks = new Set<Promise<void>>();
  private pending = new Map<string, { operationId: string; waiters: Set<() => void> }>();
  private timings = new Map<string, { operationId: string; kind: string; started: number; phaseStarted: number; phase: string }>();
  constructor(private deps: {
    projects: ProjectService;
    runtime: SandboxRuntime;
    threadIds: (id: string) => string[];
    saveSandbox: (id: string, sandbox: SandboxState, restore: boolean, image?: ProjectImageSelection) => Promise<void>;
    selectRestoreImage?: (project: Project, versionId?: string) => Promise<{ selection?: ProjectImageSelection; release(): void }>;
    detached: (id: string) => Promise<void>;
    logger?: RuntimeLog;
  }) {}

  private async phase(id: string, phase: string) {
    const operation = this.deps.projects.get(id).sandboxOperation!;
    await this.deps.projects.updateSandboxOperation(id, { ...operation, phase, updatedAt: new Date().toISOString() });
    this.recordTiming(id, 'running', phase);
  }

  private recordTiming(id: string, status: string, nextPhase?: string) {
    const timing = this.timings.get(id);
    if (!timing) return;
    const now = Date.now();
    void this.deps.logger?.write({ event: 'sandbox.operation_phase', projectId: id,
      operationId: timing.operationId, operation: timing.kind, phase: timing.phase, status,
      startedAt: new Date(timing.phaseStarted).toISOString(), finishedAt: new Date(now).toISOString(),
      durationMs: now - timing.phaseStarted, totalDurationMs: now - timing.started,
      sandboxId: this.deps.projects.get(id).sandbox?.id });
    if (nextPhase) { timing.phase = nextPhase; timing.phaseStarted = now; }
    else this.timings.delete(id);
  }

  private operationKey(id: string, step: 'capture' | 'restore'): string {
    const operation = this.deps.projects.get(id).sandboxOperation;
    if (!operation?.id) throw new Error('Sandbox operation has no durable idempotency key');
    return `${operation.id}:${step}`;
  }

  private async latestRemote(id: string): Promise<RemoteArchiveRef> {
    const remote = this.deps.runtime.remoteArchives;
    if (!remote) throw new HttpError(503, 'Cellbox 归档不可用');
    const reference = this.deps.projects.get(id).remoteArchives?.[0];
    if (!reference) throw new HttpError(409, '未找到可恢复的最新 Cellbox 归档');
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

  async wait(id: string, operationId: string, waitMs: number, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const pending = this.pending.get(id);
    if (!pending || pending.operationId !== operationId || waitMs <= 0) return;
    await new Promise<void>((resolve, reject) => {
      const finish = () => { cleanup(); resolve(); };
      const abort = () => { cleanup(); reject(signal!.reason); };
      const timer = setTimeout(finish, waitMs);
      const cleanup = () => {
        clearTimeout(timer);
        pending.waiters.delete(finish);
        signal?.removeEventListener('abort', abort);
      };
      pending.waiters.add(finish);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    });
  }

  /** Persist acceptance before returning; the caller can poll while the task runs. */
  async start(id: string, kind: ProjectSandboxOperation['kind'], options: OperationOptions = {}): Promise<{ done: Promise<void> }> {
    const project = this.deps.projects.get(id);
    if (project.executionMode !== 'sandbox') throw new HttpError(400, '此项目不使用 Sandbox');
    if (project.archiveCleanupSourceId && kind !== 'archive') throw new HttpError(409, '项目归档清理尚未完成，请先重试归档');
    const release = this.deps.projects.beginMaintenance(id);
    let reservation: { selection?: ProjectImageSelection; release(): void } | undefined;
    let operationId: string;
    try {
      await this.deps.projects.drainReads(id);
      if (options.imageVersionId && (kind !== 'restore' || project.status !== 'archived')) throw new HttpError(409, '仅归档项目恢复时可以选择镜像版本');
      if (kind === 'restore' && project.status === 'archived' && this.deps.selectRestoreImage) reservation = await this.deps.selectRestoreImage(project, options.imageVersionId);
      await this.deps.projects.updateSandboxOperation(id, { id: randomUUID(), kind,
        phase: kind === 'create' ? '创建 Sandbox' : '检查环境', status: 'running', updatedAt: new Date().toISOString() });
      const accepted = this.deps.projects.get(id).sandboxOperation!;
      operationId = accepted.id!;
      const now = Date.now();
      this.timings.set(id, { operationId: accepted.id!, kind, started: now, phaseStarted: now, phase: accepted.phase });
      void this.deps.logger?.write({ event: 'sandbox.operation_started', projectId: id,
        operationId: accepted.id, operation: kind, startedAt: new Date(now).toISOString(), sandboxId: project.sandbox?.id });
    } catch (error) { reservation?.release(); release(); throw error; }
    const pending = { operationId, waiters: new Set<() => void>() };
    this.pending.set(id, pending);
    const task = Promise.resolve().then(() => traced(`project.sandbox.${kind}`, {
      'project.id': id, 'operation.id': operationId, 'sandbox.id': project.sandbox?.id,
    }, async () => {
      try {
        if (kind === 'create') await this.create(id);
        else if (kind === 'checkpoint') await this.checkpoint(id);
        else if (kind === 'restore') await this.restore(id,
          project.sandboxOperation?.status === 'failed' && ['create', 'resume'].includes(project.sandboxOperation.kind), reservation);
        else if (kind === 'resume') await this.resume(id);
        else if (kind === 'backup') {
          if (project.status === 'archived') throw new HttpError(409, '已归档项目不能立即备份');
          await this.backup(id);
        } else if (kind === 'refresh') await this.refreshRuntime(id);
        else await this.archive(id, options.useExistingBackup === true);
        await this.deps.projects.updateSandboxOperation(id, { ...this.deps.projects.get(id).sandboxOperation!, kind,
          phase: '完成', status: 'succeeded', updatedAt: new Date().toISOString() });
      } catch (error) {
        // Keep the user-facing state deliberately concise, but always retain the
        // provider error and operation context in the bounded server log. Without
        // this, restore failures are indistinguishable from one another in the UI.
        void this.deps.logger?.write({
          event: 'sandbox.operation_failed',
          operation: kind,
          projectId: id,
          phase: this.deps.projects.get(id).sandboxOperation?.phase,
          error,
        });
        await this.deps.projects.updateSandboxOperation(id, { ...this.deps.projects.get(id).sandboxOperation!, kind, phase: this.deps.projects.get(id).sandboxOperation?.phase ?? '检查环境',
          status: 'failed', error: error instanceof HttpError ? error.message : '操作失败，请重试；详细原因请查看服务端日志。', updatedAt: new Date().toISOString() });
        throw error;
      } finally {
        this.recordTiming(id, this.deps.projects.get(id).sandboxOperation?.status ?? 'failed');
        reservation?.release(); release();
        // Wake readers only after the terminal state is durable and execution
        // is admitted again. A Box being Running alone is not resume success.
        this.pending.delete(id);
        const status = this.deps.projects.get(id).sandboxOperation?.status;
        traceEvent(status === 'succeeded' ? 'project.success.published' : 'project.failure.published', { 'operation.status': status });
        for (const finish of pending.waiters) finish();
        traceEvent('project.waiters.notified');
      }
    }));
    this.tasks.add(task);
    void task.finally(() => this.tasks.delete(task)).catch(() => {});
    return { done: task };
  }

  private async create(id: string) {
    const { projects, runtime } = this.deps;
    const project = projects.get(id);
    if (project.status === 'archived') throw new HttpError(409, '已归档项目须从备份恢复');
    if (project.remoteArchives?.length) throw new HttpError(409, '项目已有备份，请使用恢复环境');
    // A failed preparation can retry the same box. The provider's durable create
    // journal also reuses an accepted box when the initial response was lost.
    await this.phase(id, '创建并准备环境');
    await runtime.rebuild(target(project), sandbox => this.deps.saveSandbox(id, sandbox, false));
    const candidate = projects.get(id).sandbox;
    if (!candidate) throw new Error('创建操作没有返回 Sandbox');
    await this.phase(id, '验证环境');
    if (!runtime.verifySandbox) throw new HttpError(503, 'Sandbox 不支持就绪验证');
    await runtime.verifySandbox(candidate);
    await this.deps.saveSandbox(id, { ...candidate, status: 'ready' }, false);
  }

  private async checkpoint(id: string) {
    const { projects, runtime } = this.deps;
    if (projects.get(id).status === 'archived') throw new HttpError(409, '已归档项目不能暂停');
    const project = await this.inspect(id);
    if (project.sandbox?.status !== 'ready') throw new HttpError(409, '仅运行中的 Sandbox 可以创建 Checkpoint');
    if (!runtime.checkpoint) throw new HttpError(503, 'Sandbox 不支持 Checkpoint');
    await runtime.verifySandbox?.(project.sandbox);
    await this.phase(id, '保存 Checkpoint 并暂停');
    const paused = await runtime.checkpoint(target(project));
    if (paused.status !== 'paused') throw new Error('Checkpoint 完成后 Sandbox 未暂停');
    await this.deps.saveSandbox(id, paused, false);
  }

  private async inspect(id: string) {
    const project = this.deps.projects.get(id);
    if (project.sandbox) project.sandbox = await querySandbox(this.deps.runtime, project.sandbox);
    return project;
  }

  private async backup(id: string) {
    const project = await this.inspect(id);
    const runtime = this.deps.runtime;
    if (project.sandbox?.status !== 'ready') throw new HttpError(409, 'Sandbox 不正常，无法生成新备份');
    if (!runtime.remoteArchives) throw new HttpError(503, 'Cellbox 归档不可用');
    await runtime.verifySandbox?.(project.sandbox);
    await this.phase(id, '备份数据');
    const started = Date.now();
    const captured = await runtime.remoteArchives.capture(target(project), this.operationKey(id, 'capture'));
    const reference: RemoteArchiveRef = { ...captured, threadIds: this.deps.threadIds(id) };
    if (reference.sourceSandboxId !== project.sandbox.id
      || (project.sandbox.image?.id && reference.imageId !== project.sandbox.image.id)) {
      throw new HttpError(409, 'Cellbox 归档来源与当前 Sandbox 不符，操作已停止');
    }
    await this.phase(id, '校验备份');
    const inspected = await runtime.remoteArchives.inspect(reference);
    if (!matchesRemoteArchive(reference, inspected)) {
      throw new HttpError(409, 'Cellbox 归档校验失败，操作已停止');
    }
    // Persist the reference before any archive operation may release the source box.
    await this.deps.projects.saveRemoteArchive(id, reference);
    await this.deps.projects.updateSandboxOperation(id, { ...this.deps.projects.get(id).sandboxOperation!,
      durationMs: Date.now() - started, scannedBytes: reference.sizeBytes, verified: true,
      updatedAt: new Date().toISOString() });
    if (runtime.remoteArchives.remove) {
      const current = this.deps.projects.get(id);
      await pruneRemoteArchives(current.remoteArchives ?? [], current.backupRetentionCount ?? 2,
        runtime.remoteArchives, archiveId => this.deps.projects.removeRemoteArchive(id, archiveId)).catch(error => {
        void this.deps.logger?.write({ event: 'sandbox.backup_retention_failed', projectId: id, error });
      });
    }
  }

  private async resume(id: string) {
    const { projects, runtime } = this.deps;
    const project = projects.get(id);
    if (project.status === 'archived' || !project.sandbox) throw new HttpError(409, '项目没有可恢复运行的 Sandbox');
    const current = await this.inspect(id);
    if (current.sandbox?.status !== 'paused') throw new HttpError(409, 'Sandbox 未暂停，无需恢复运行');
    if (!runtime.resume) throw new HttpError(503, 'Sandbox 不支持恢复运行');
    await this.phase(id, '恢复运行');
    await runtime.resume(target(current), sandbox => this.deps.saveSandbox(id, sandbox, false));
    const resumed = projects.get(id).sandbox;
    if (!resumed) throw new HttpError(503, 'Sandbox 恢复后缺少运行实例');
    // Cellbox completes after restoring the execution and unquiescing Guest;
    // its health diagnostics run asynchronously. The next real App Server
    // connection performs initialize/protocol validation without a duplicate
    // probe or temporary WebSocket stream blocking another lifecycle action.
    await this.deps.saveSandbox(id, { ...resumed, status: 'ready' }, false);
  }

  private async rememberCleanup(id: string, sandbox: SandboxState) {
    const pending = this.deps.projects.get(id).pendingSandboxCleanup ?? [];
    await this.deps.projects.setPendingSandboxCleanup(id, [...pending.filter(item => item.id !== sandbox.id), sandbox]);
  }

  private async cleanup(id: string, archive = false) {
    const project = this.deps.projects.get(id);
    const remaining: SandboxState[] = [];
    let failed = false;
    for (const sandbox of project.pendingSandboxCleanup ?? []) {
      if (sandbox.id === project.sandbox?.id && !archive) { remaining.push(sandbox); continue; }
      try {
        if (!this.deps.runtime.deleteDanglingSandbox) throw new Error('cleanup not supported');
        await this.deps.runtime.deleteDanglingSandbox(sandbox.id);
        // Keep the source journal until the archive state is committed, so a
        // restart after deletion can finish without selecting an older backup.
        if (archive && sandbox.id === project.archiveCleanupSourceId) remaining.push(sandbox);
      } catch (error) {
        failed = true; remaining.push(sandbox);
        void this.deps.logger?.write({ event: 'sandbox.cleanup_failed', projectId: id, sandboxId: sandbox.id, error });
      }
    }
    await this.deps.projects.setPendingSandboxCleanup(id, remaining);
    if (archive && failed) {
      throw new HttpError(503, '归档环境尚未清理完成，请重试');
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
    const currentImage = await runtime.currentImageIdentity?.(target(restoredProject));
    if (reference.storageType !== 'oss' && !reference.portable && currentImage && currentImage.id !== reference.imageId) {
      throw new HttpError(409, 'Cellbox 归档只能恢复到相同镜像，当前镜像已变化');
    }
    const project = await this.inspect(id);
    if (!allowHealthy && project.status !== 'archived' && project.sandbox?.status === 'ready') {
      throw new HttpError(409, 'Sandbox 正常，无需恢复环境');
    }
    let replacement: SandboxState | undefined;
    try {
      await this.phase(id, '恢复数据');
      const candidate = await remote.restore(target(restoredProject), reference, this.operationKey(id, 'restore'),
        async sandbox => {
          replacement = sandbox;
          await this.rememberCleanup(id, sandbox);
          void this.deps.logger?.write({ event: 'sandbox.operation_candidate', projectId: id,
            operationId: projects.get(id).sandboxOperation?.id, sandboxId: sandbox.id });
        });
      replacement = candidate;
      await this.rememberCleanup(id, candidate);
      if (restoredProject.imageSelection && candidate.image?.id !== restoredProject.imageSelection.image) {
        throw new HttpError(409, '恢复环境的镜像身份与所选版本不一致');
      }
      await this.phase(id, '验证环境');
      await remote.activate(candidate);
      await runtime.verifySandbox(candidate);
      await runtime.verifyHistory?.(candidate, reference.threadIds);
    } catch (error) {
      if (replacement) await runtime.fenceSandbox(replacement).catch(() => {});
      throw error;
    }
    // The old binding remains intact through staged restore and verification.
    await this.phase(id, '切换环境');
    if (project.sandbox) {
      await runtime.fenceSandbox(project.sandbox);
      await runtime.detachSandbox(target(project));
      await this.rememberCleanup(id, project.sandbox);
    }
    if (!replacement) throw new Error('恢复操作没有创建 Sandbox');
    await this.deps.saveSandbox(id, { ...replacement, status: 'ready' }, project.status === 'archived', restoredProject.imageSelection);
    runtime.track?.(target(projects.get(id)), sandbox => this.deps.saveSandbox(id, sandbox, false));
    await this.phase(id, '清理旧环境');
    await this.cleanup(id);
  }

  private async archive(id: string, useExistingBackup: boolean) {
    const { projects, runtime } = this.deps;
    const project = await this.inspect(id);
    if (project.status === 'archived') {
      if (project.sandbox) {
        // Legacy status flags could leave a live binding. Preserve its data
        // before reclaiming it rather than interpreting the flag as a backup.
        if (project.sandbox.status === 'ready') await this.backup(id);
        else await this.latestRemote(id);
      }
      const pending = new Map((project.pendingSandboxCleanup ?? []).map(sandbox => [sandbox.id, sandbox]));
      for (const sandbox of await runtime.listProjectSandboxes?.(id) ?? []) pending.set(sandbox.id, sandbox);
      const sourceIds = [...(project.remoteArchives ?? []).map(ref => ref.sourceSandboxId),
        ...(project.lifecycleHistory ?? []).filter(record => record.action === 'archived').flatMap(record => record.sandboxId ? [record.sandboxId] : [])];
      for (const sourceId of sourceIds) {
        if (!pending.has(sourceId)) pending.set(sourceId, { id: sourceId, status: 'unknown', template: 'legacy', workingDirectory: project.workingDirectory });
      }
      if (project.sandbox) pending.set(project.sandbox.id, project.sandbox);
      await projects.setPendingSandboxCleanup(id, [...pending.values()]);
      await this.phase(id, '清理归档遗留资源');
      await this.cleanup(id, true);
      await this.deps.detached(id);
      // Legacy archives may still carry their obsolete binding.
      if (project.sandbox) {
        await runtime.detachSandbox?.(target(project));
        await projects.archiveAndDetachSandbox(id, project.sandbox.id);
      } else await projects.markArchivedArtifactsCleaned(id);
      return;
    }
    if (project.archiveCleanupSourceId || useExistingBackup) {
      await this.latestRemote(id);
    } else if (project.sandbox?.status === 'ready') {
      await this.backup(id);
    } else {
      await this.latestRemote(id);
      if (!useExistingBackup) throw new HttpError(409, '当前环境无法生成新备份，请确认使用已有备份归档；未备份数据不会保存');
    }
    for (const sandbox of await runtime.listProjectSandboxes?.(id) ?? []) {
      if (sandbox.id !== project.sandbox?.id) await this.rememberCleanup(id, sandbox);
    }
    if (project.sandbox) {
      if (!runtime.fenceSandbox || !runtime.detachSandbox) throw new HttpError(503, 'Sandbox 不支持安全释放');
      await this.phase(id, '释放环境');
      await projects.prepareArchiveCleanup(id, project.sandbox);
      await runtime.fenceSandbox(project.sandbox);
      await runtime.detachSandbox(target(project));
    }
    await this.phase(id, '清理环境和缓存');
    await this.cleanup(id, true);
    await this.deps.detached(id);
    await projects.archiveAndDetachSandbox(id, project.sandbox?.id);
  }

  private async refreshRuntime(id: string) {
    const { projects, runtime } = this.deps;
    const project = await this.inspect(id);
    if (project.status === 'archived' || project.sandbox?.status !== 'ready') throw new HttpError(409, '仅可刷新正常运行的项目 Sandbox');
    const currentImage = await runtime.currentImageIdentity?.(target(project));
    if (!currentImage || project.sandbox.image?.id !== currentImage.id) {
      throw new HttpError(409, 'Cellbox 归档只能恢复到相同镜像，无法切换镜像版本');
    }
    await this.phase(id, '备份当前环境');
    await this.backup(id);
    await this.restore(id, true);
  }

  async close() { await Promise.allSettled(this.tasks); }

  async retryCleanup(id: string) {
    const release = this.deps.projects.beginMaintenance(id);
    const task = this.deps.projects.drainReads(id).then(() => this.cleanup(id)).finally(release);
    this.tasks.add(task);
    void task.finally(() => this.tasks.delete(task)).catch(() => {});
    return task;
  }
}
