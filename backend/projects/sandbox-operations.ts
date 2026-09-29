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

const target = (project: Project): WorkspaceTarget => ({ id: project.id, projectId: project.id,
  settings: { workingDirectory: project.workingDirectory }, sandbox: project.sandbox, updatedAt: project.updatedAt });

export class ProjectSandboxOperations {
  private tasks = new Set<Promise<void>>();
  constructor(private deps: {
    projects: ProjectService;
    runtime: SandboxRuntime;
    threadIds: (id: string) => string[];
    saveSandbox: (id: string, sandbox: SandboxState, restore: boolean) => Promise<void>;
    detached: (id: string) => Promise<void>;
    logger?: RuntimeLog;
  }) {}

  private async phase(id: string, phase: string) {
    const operation = this.deps.projects.get(id).sandboxOperation!;
    await this.deps.projects.updateSandboxOperation(id, { ...operation, phase, updatedAt: new Date().toISOString() });
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

  run(id: string, kind: ProjectSandboxOperation['kind'], options: { useExistingBackup?: boolean } = {}): Promise<void> {
    const project = this.deps.projects.get(id);
    if (project.executionMode !== 'sandbox') throw new HttpError(400, '此项目不使用 Sandbox');
    const release = this.deps.projects.beginMaintenance(id);
    const task = (async () => {
      try {
        await this.deps.projects.updateSandboxOperation(id, { id: randomUUID(), kind, phase: '检查环境', status: 'running', updatedAt: new Date().toISOString() });
        if (kind === 'restore') await this.restore(id);
        else if (kind === 'resume') await this.resume(id);
        else if (kind === 'backup') {
          if (project.status === 'archived') throw new HttpError(409, '已归档项目不能立即备份');
          await this.inspect(id);
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
      } finally { release(); }
    })();
    this.tasks.add(task);
    void task.finally(() => this.tasks.delete(task)).catch(() => {});
    return task;
  }

  private async inspect(id: string) {
    const project = this.deps.projects.get(id);
    if (!project.sandbox) return;
    try { await this.deps.runtime.inspect?.(target(project)); }
    catch (error) {
      if ((error as { code?: string }).code !== 'not_accessible') throw new HttpError(502, '暂时无法检查 Sandbox，操作已停止，请重试');
      await this.deps.saveSandbox(id, { ...project.sandbox, status: 'unavailable' }, false);
    }
    const current = this.deps.projects.get(id);
    if (current.sandbox?.status === 'ready' && this.deps.runtime.verifySandbox) {
      try { await this.deps.runtime.verifySandbox(current.sandbox, 5_000); }
      catch { await this.deps.saveSandbox(id, { ...current.sandbox, status: 'unavailable' }, false); }
    }
  }

  private async backup(id: string) {
    const project = this.deps.projects.get(id);
    const runtime = this.deps.runtime;
    if (project.sandbox?.status !== 'ready') throw new HttpError(409, 'Sandbox 不正常，无法生成新备份');
    if (!runtime.remoteArchives) throw new HttpError(503, 'Cellbox 归档不可用');
    await this.phase(id, '备份数据');
    const metadata = { format: 'codex-workspace-v1' as const, threadIds: this.deps.threadIds(id),
      workingDirectory: project.workingDirectory, sourceSandboxId: project.sandbox.id,
      sourceProjectId: id, sourceTemplate: project.sandbox.template };
      const started = Date.now();
      const captured = await runtime.remoteArchives.capture(target(project), this.operationKey(id, 'capture'));
      const reference: RemoteArchiveRef = { ...captured, threadIds: metadata.threadIds };
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
      return;
  }

  private async resume(id: string) {
    const { projects, runtime } = this.deps;
    const project = projects.get(id);
    if (project.status === 'archived' || !project.sandbox) throw new HttpError(409, '项目没有可恢复运行的 Sandbox');
    await this.inspect(id);
    const current = projects.get(id);
    if (current.sandbox?.status !== 'paused') throw new HttpError(409, 'Sandbox 未暂停，无需恢复运行');
    if (!runtime.resume) throw new HttpError(503, 'Sandbox 不支持恢复运行');
    await this.phase(id, '恢复运行');
    await runtime.resume(target(current), sandbox => this.deps.saveSandbox(id, sandbox, false));
    if (projects.get(id).sandbox?.status !== 'ready') throw new Error('Sandbox 恢复后未就绪');
  }

  private async rememberCleanup(id: string, sandbox: SandboxState) {
    const pending = this.deps.projects.get(id).pendingSandboxCleanup ?? [];
    await this.deps.projects.setPendingSandboxCleanup(id, [...pending.filter(item => item.id !== sandbox.id), sandbox]);
  }

  private async cleanup(id: string) {
    const project = this.deps.projects.get(id);
    const remaining: SandboxState[] = [];
    for (const sandbox of project.pendingSandboxCleanup ?? []) {
      if (sandbox.id === project.sandbox?.id) continue;
      try {
        if (!this.deps.runtime.deleteDanglingSandbox) throw new Error('cleanup not supported');
        await this.deps.runtime.deleteDanglingSandbox(sandbox.id);
      } catch { remaining.push(sandbox); }
    }
    await this.deps.projects.setPendingSandboxCleanup(id, remaining);
  }

  private async restore(id: string, allowHealthy = false) {
    const { projects, runtime } = this.deps;
    const remote = runtime.remoteArchives;
    if (!remote) throw new HttpError(503, 'Cellbox 归档不可用');
    await this.phase(id, '校验最新归档');
    const reference = await this.latestRemote(id);
    if (!runtime.verifySandbox || !runtime.fenceSandbox || !runtime.detachSandbox) {
      throw new HttpError(503, 'Sandbox 不支持安全恢复');
    }
    const currentImage = await runtime.currentImageIdentity?.();
    if (reference.storageType !== 'oss' && currentImage && currentImage.id !== reference.imageId) {
      throw new HttpError(409, 'Cellbox 归档只能恢复到相同镜像，当前镜像已变化');
    }
    await this.inspect(id);
    const project = projects.get(id);
    if (!allowHealthy && project.status !== 'archived' && project.sandbox?.status === 'ready') {
      throw new HttpError(409, 'Sandbox 正常，无需恢复环境');
    }
    let replacement: SandboxState | undefined;
    try {
      await this.phase(id, '恢复数据');
      const candidate = await remote.restore(target(project), reference, this.operationKey(id, 'restore'),
        async sandbox => { replacement = sandbox; await this.rememberCleanup(id, sandbox); });
      replacement = candidate;
      await this.rememberCleanup(id, candidate);
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
    await this.deps.saveSandbox(id, { ...replacement, status: 'ready' }, project.status === 'archived');
    runtime.track?.(target(projects.get(id)), sandbox => this.deps.saveSandbox(id, sandbox, false));
    await this.phase(id, '清理旧环境');
    await this.cleanup(id);
  }

  private async archive(id: string, useExistingBackup: boolean) {
    const { projects, runtime } = this.deps;
    await this.inspect(id);
    const project = projects.get(id);
    if (project.sandbox?.status === 'ready') {
      await this.backup(id);
    } else {
      await this.latestRemote(id);
      if (!useExistingBackup) throw new HttpError(409, '当前环境无法生成新备份，请确认使用已有备份归档；未备份数据不会保存');
    }
    if (project.sandbox) {
      if (!runtime.fenceSandbox || !runtime.detachSandbox) throw new HttpError(503, 'Sandbox 不支持安全释放');
      await this.phase(id, '释放环境');
      await runtime.fenceSandbox(project.sandbox);
      await this.rememberCleanup(id, project.sandbox);
      await runtime.detachSandbox(target(project));
    }
    await projects.archiveAndDetachSandbox(id, project.sandbox?.id);
    await this.deps.detached(id);
    await this.cleanup(id);
  }

  private async refreshRuntime(id: string) {
    const { projects, runtime } = this.deps;
    const project = projects.get(id);
    if (project.status === 'archived' || project.sandbox?.status !== 'ready') throw new HttpError(409, '仅可刷新正常运行的项目 Sandbox');
    const currentImage = await runtime.currentImageIdentity?.();
    if (!currentImage || project.sandbox.image?.id !== currentImage.id) {
      throw new HttpError(409, 'Cellbox 归档只能恢复到相同镜像，无法切换镜像版本');
    }
    await this.inspect(id);
    if (projects.get(id).sandbox?.status !== 'ready') throw new HttpError(409, 'Sandbox 不正常，无法刷新环境');
    await this.phase(id, '备份当前环境');
    await this.backup(id);
    await this.restore(id, true);
  }

  async close() { await Promise.allSettled(this.tasks); }

  async retryCleanup(id: string) {
    const release = this.deps.projects.beginMaintenance(id);
    const task = this.cleanup(id).finally(release);
    this.tasks.add(task);
    void task.finally(() => this.tasks.delete(task)).catch(() => {});
    return task;
  }
}
