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

type OperationOptions = { useExistingBackup?: boolean; imageVersionId?: string };

const target = (project: Project): WorkspaceTarget => ({ id: project.id, projectId: project.id,
  settings: { workingDirectory: project.workingDirectory }, imageSelection: project.imageSelection, sandbox: project.sandbox, updatedAt: project.updatedAt });

export class ProjectSandboxOperations {
  private tasks = new Set<Promise<void>>();
  private context = new AsyncLocalStorage<{ operation: ProjectSandboxOperation; project: Project }>();
  private pending = new Map<string, { operationId: string; waiters: Set<() => void>; done?: Promise<void> }>();
  private timings = new Map<string, { operationId: string; kind: string; started: number; phaseStarted: number; phase: string }>();
  constructor(private deps: {
    projects: ProjectService;
    runtime: SandboxRuntime;
    threadIds: (id: string) => string[];
    saveSandbox: (id: string, sandbox: SandboxState, restore: boolean, image?: ProjectImageSelection, expectedSandboxId?: string | null) => Promise<void>;
    selectRestoreImage?: (project: Project, versionId?: string) => Promise<{ selection?: ProjectImageSelection; release(): void | Promise<void> }>;
    detached: (id: string) => Promise<void>;
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
    const operationId = this.context.getStore()?.operation.id;
    const timing = operationId ? this.timings.get(operationId) : undefined;
    if (!timing) return;
    const now = Date.now();
    void this.deps.logger?.write({ event: 'sandbox.operation_phase', projectId: id,
      operationId: timing.operationId, operation: timing.kind, phase: timing.phase, status,
      startedAt: new Date(timing.phaseStarted).toISOString(), finishedAt: new Date(now).toISOString(),
      durationMs: now - timing.phaseStarted, totalDurationMs: now - timing.started,
      sandboxId: this.deps.projects.get(id).sandbox?.id });
    if (nextPhase) { timing.phase = nextPhase; timing.phaseStarted = now; }
    else this.timings.delete(operationId!);
  }

  private operationKey(id: string, step: 'capture' | 'restore'): string {
    const operation = this.context.getStore()?.operation;
    if (!operation?.id) throw new Error('Sandbox request has no observation ID');
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

  /** One user request submits each remote step once; no task takeover or replay. */
  async start(id: string, kind: ProjectSandboxOperation['kind'], options: OperationOptions = {}): Promise<{ done: Promise<void> }> {
    const project = this.deps.projects.get(id);
    if (project.executionMode !== 'sandbox') throw new HttpError(400, '此项目不使用 Sandbox');
    const selection = kind === 'restore' && this.deps.selectRestoreImage
      ? await this.deps.selectRestoreImage(project, options.imageVersionId) : undefined;
    const operation: ProjectSandboxOperation = { id: randomUUID(), kind, phase: '提交操作', status: 'running',
      ...(selection?.selection ? { imageSelection: selection.selection } : {}), updatedAt: new Date().toISOString() };
    await this.deps.projects.updateSandboxOperation(id, operation);
    const pending = { operationId: operation.id!, waiters: new Set<() => void>(), done: undefined as Promise<void> | undefined };
    this.pending.set(id, pending);
    this.timings.set(operation.id!, { operationId: operation.id!, kind, started: Date.now(), phaseStarted: Date.now(), phase: operation.phase });
    const execute = async () => {
      try {
        if (kind === 'create') await this.create(id);
        else if (kind === 'resume') await this.resume(id);
        else if (kind === 'rebuild') throw new HttpError(422, '当前 Cellbox 不支持同 ID 重建；可从备份创建新环境。');
        else if (kind === 'checkpoint') await this.checkpoint(id);
        else if (kind === 'restore') await this.restore(id, false, selection);
        else if (kind === 'backup') await this.backup(id);
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
        if (this.pending.get(id) === pending) this.pending.delete(id);
        for (const finish of pending.waiters) finish();
      }
    };
    const task = this.context.run({ operation, project }, () => Promise.resolve().then(() => traced('project.sandbox.' + kind,
      { 'project.id': id, 'operation.id': operation.id!, 'sandbox.id': project.sandbox?.id }, execute)));
    pending.done = task;
    this.tasks.add(task);
    void task.finally(() => this.tasks.delete(task)).catch(() => {});
    return { done: task };
  }

  hasResume(id: string, operationId: string): boolean { return this.pending.get(id)?.operationId === operationId; }
  hasBackup(id: string, backupId: string): boolean { return this.pending.get(id)?.operationId === backupId; }

  private async resume(id: string) {
    const project = this.context.getStore()!.project;
    if (!project.sandbox || !this.deps.runtime.resume) throw new HttpError(409, '项目没有可恢复的 Sandbox');
    await this.phase(id, '恢复运行');
    await this.deps.runtime.resume(target(project));
  }

  private async create(id: string) {
    const { projects, runtime } = this.deps;
    const project = projects.get(id);
    if (project.status === 'archived') throw new HttpError(409, '已归档项目须从备份恢复');
    if (project.remoteArchives?.length) throw new HttpError(409, '项目已有备份，请使用恢复环境');
    await this.phase(id, '创建并准备环境');
    await runtime.rebuild(target(project), sandbox => this.deps.saveSandbox(id, sandbox, false, undefined, project.sandbox?.id ?? null));
    const candidate = projects.get(id).sandbox;
    if (!candidate) throw new Error('创建操作没有返回 Sandbox');
    await this.phase(id, '验证环境');
    if (!runtime.verifySandbox) throw new HttpError(503, 'Sandbox 不支持就绪验证');
    await runtime.verifySandbox(candidate);
    await this.deps.saveSandbox(id, { ...candidate, status: 'ready' }, false);
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
    const project = await this.inspect(id);
    const runtime = this.deps.runtime;
    if (!project.sandbox) throw new HttpError(409, '项目没有可备份的持久化目录');
    if (project.sandbox.status !== 'paused' && project.sandbox.phase !== 'failed') throw new HttpError(409, '请先暂停 Sandbox，再从磁盘生成备份');
    if (!runtime.remoteArchives) throw new HttpError(503, 'Cellbox 归档不可用');
    const operation = this.context.getStore()!.operation;
    let backup: NonNullable<Project['sandboxBackup']> = { id: operation.id!, sandboxId: project.sandbox.id, status: 'running',
      phase: '从已停止的磁盘备份数据', updatedAt: new Date().toISOString() };
    await this.deps.projects.updateSandboxBackup(id, backup);
    const phase = async (value: string) => {
      operation.phase = value; operation.updatedAt = new Date().toISOString();
      // Observation records may have moved to another request while Cellbox works.
      await this.deps.projects.updateSandboxOperation(id, { ...operation }, operation.id);
      this.recordTiming(id, 'running', value);
      backup = { ...backup, phase: value, updatedAt: new Date().toISOString() };
      await this.deps.projects.updateSandboxBackup(id, backup, operation.id);
    };
    const started = Date.now();
    try {
      await phase(backup.phase);
      const captured = await runtime.remoteArchives.capture(target(project), this.operationKey(id, 'capture'));
      const reference: RemoteArchiveRef = { ...captured, threadIds: this.deps.threadIds(id) };
      if (reference.sourceSandboxId !== project.sandbox.id
        || (project.sandbox.image?.id && reference.imageId !== project.sandbox.image.id)) {
        throw new HttpError(409, 'Cellbox 归档来源与当前 Sandbox 不符，操作已停止');
      }
      await phase('校验备份');
      const inspected = await runtime.remoteArchives.inspect(reference);
      if (!matchesRemoteArchive(reference, inspected)) {
        throw new HttpError(409, 'Cellbox 归档校验失败，操作已停止');
      }
      // Persist the reference before any archive operation may release the source box.
      await this.deps.projects.saveRemoteArchive(id, reference);
      const outcome = { durationMs: Date.now() - started, scannedBytes: reference.sizeBytes, verified: true,
        updatedAt: new Date().toISOString() };
      // Remote deletion remains an explicit cleanup action, never a backup retry.
      await this.deps.projects.updateSandboxBackup(id, { ...backup, ...outcome, phase: '完成', status: 'succeeded' }, operation.id);
      Object.assign(operation, outcome);
      await this.deps.projects.updateSandboxOperation(id, { ...operation }, operation.id);
    } catch (error) {
      const detail = operationError(error);
      await this.deps.projects.updateSandboxBackup(id, { ...backup, status: detail.unknown ? 'unknown' : 'failed',
        error: detail.message, updatedAt: new Date().toISOString() }, operation.id);
      void this.deps.logger?.write({ event: 'sandbox.backup_failed', projectId: id,
        sandboxId: project.sandbox.id, operationId: operation.id, phase: backup.phase, error });
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
    const currentImage = await runtime.currentImageIdentity?.(target(restoredProject));
    if (reference.storageType !== 'oss' && !reference.portable && currentImage && currentImage.id !== reference.imageId) {
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
    await this.deps.saveSandbox(id, { ...candidate, status: 'ready' }, true, restoredProject.imageSelection, project.sandbox?.id ?? null);
    runtime.track?.(target(projects.get(id)), sandbox => this.deps.saveSandbox(id, sandbox, false));
    await this.phase(id, '清理旧环境');
    await this.cleanup(id, false, new Set(project.sandbox ? [project.sandbox.id] : []));
  }

  private async archive(id: string, useExistingBackup: boolean) {
    const { projects } = this.deps;
    const project = await this.inspect(id);
    const originalTarget = target(project);
    if (project.status !== 'archived' || project.sandbox) {
      if (project.archiveCleanupSourceId || useExistingBackup) {
        await this.latestRemote(id);
        // The operator explicitly accepted this immutable backup's date.
        // Stopping/deleting the source belongs to cleanup, not checkpointing.
      } else if (project.sandbox) {
        if (project.sandbox.status !== 'paused' && project.sandbox.phase !== 'failed')
          throw new HttpError(422, '当前 Cellbox 不支持无 Checkpoint 的纯磁盘归档；请明确暂停后归档，或选择使用已有备份。');
        await this.backup(id);
      } else {
        throw new HttpError(409, '项目没有可备份的持久化目录，请确认使用已有备份归档');
      }
      const cleanupSource = project.sandbox ?? (project.remoteArchives?.[0] ? {
        id: project.remoteArchives[0].sourceSandboxId, status: 'unknown' as const,
        template: 'legacy', workingDirectory: project.workingDirectory,
      } : undefined);
      if (cleanupSource) await projects.prepareArchiveCleanup(id, cleanupSource);
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
    const pending = new Map((current.pendingSandboxCleanup ?? []).map(sandbox => [sandbox.id, sandbox]));
    for (const sandbox of await runtime.listProjectSandboxes?.(id) ?? []) pending.set(sandbox.id, sandbox);
    // Archive references and lifecycle history can outlive their purged source.
    // Only recorded cleanup work and currently observed resources are candidates.
    await projects.mergePendingSandboxCleanup(id, [...pending.values()]);
    await this.cleanup(id, true);
    await this.deps.detached(id);
    await projects.markArchivedArtifactsCleaned(id);
  }

  async close() { await Promise.allSettled(this.tasks); }
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
