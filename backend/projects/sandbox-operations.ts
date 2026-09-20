import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Project, ProjectSandboxOperation } from '../../protocol/types.js';
import type { SandboxState } from '../../protocol/sandbox-types.js';
import type { SandboxRuntime } from '../execution/container-runtime.js';
import type { ArchiveManager } from '../archives/manager.js';
import type { WorkspaceTarget } from '../sandboxes/types.js';
import type { ProjectService } from './service.js';
import { HttpError } from '../../util/errors.js';

const target = (project: Project): WorkspaceTarget => ({ id: project.id, projectId: project.id,
  settings: { workingDirectory: project.workingDirectory }, sandbox: project.sandbox, updatedAt: project.updatedAt });

type Backup = { storagePath: string; sizeBytes: number; sha256: string; createdAt: string };

/** Project lifecycle orchestration. Backup versions and provider failures stay in their own modules. */
export class ProjectSandboxOperations {
  private tasks = new Set<Promise<void>>();
  constructor(private deps: {
    projects: ProjectService;
    runtime: SandboxRuntime;
    archives: () => ArchiveManager | undefined;
    directory: string;
    threadIds: (id: string) => string[];
    saveSandbox: (id: string, sandbox: SandboxState, restore: boolean) => Promise<void>;
    detached: (id: string) => Promise<void>;
  }) {}

  async latest(id: string): Promise<Backup> {
    const project = this.deps.projects.get(id);
    if (project.archiveKey) {
      const archives = this.deps.archives();
      if (!archives) throw new HttpError(503, '备份模块未配置');
      const latest = await archives.getLatest(project.archiveKey);
      // Never fall back to a legacy or earlier version when the latest is missing.
      if (!latest) throw new HttpError(409, '未找到可恢复的最新备份');
      return latest;
    }
    const legacy = await this.deps.projects.latestDataArchive(id);
    if (!legacy || !/^[A-Za-z0-9._-]+\.tar\.gz$/.test(legacy.key)) throw new HttpError(409, '未找到可恢复的最新备份');
    return { ...legacy, storagePath: join(this.deps.directory, legacy.key) };
  }

  private async validate(backup: Backup) {
    const file = await stat(backup.storagePath).catch(() => undefined);
    if (!file?.isFile() || !file.size || file.size !== backup.sizeBytes) throw new HttpError(409, '最新备份不存在、为空或大小不符，操作已停止');
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(backup.storagePath)) hash.update(chunk);
    if (hash.digest('hex') !== backup.sha256) throw new HttpError(409, '最新备份校验失败，操作已停止；不会使用旧版本或空环境');
  }

  private async phase(id: string, phase: string) {
    const operation = this.deps.projects.get(id).sandboxOperation!;
    await this.deps.projects.updateSandboxOperation(id, { ...operation, phase, updatedAt: new Date().toISOString() });
  }

  run(id: string, kind: ProjectSandboxOperation['kind'], options: { useExistingBackup?: boolean } = {}): Promise<void> {
    const project = this.deps.projects.get(id);
    if (project.executionMode !== 'sandbox') throw new HttpError(400, '此项目不使用 Sandbox');
    const release = this.deps.projects.beginMaintenance(id);
    const task = (async () => {
      try {
        await this.deps.projects.updateSandboxOperation(id, { kind, phase: '检查环境', status: 'running', updatedAt: new Date().toISOString() });
        if (kind === 'restore') await this.restore(id);
        else if (kind === 'backup') {
          if (project.status === 'archived') throw new HttpError(409, '已归档项目不能立即备份');
          await this.inspect(id);
          await this.backup(id);
        } else await this.archive(id, options.useExistingBackup === true);
        await this.deps.projects.updateSandboxOperation(id, { kind, phase: '完成', status: 'succeeded', updatedAt: new Date().toISOString() });
      } catch (error) {
        await this.deps.projects.updateSandboxOperation(id, { kind, phase: this.deps.projects.get(id).sandboxOperation?.phase ?? '检查环境',
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
    if (!runtime.createArchive) throw new HttpError(503, '备份模块未配置');
    await this.phase(id, '备份数据');
    const metadata = { format: 'codex-workspace-v1' as const, threadIds: this.deps.threadIds(id),
      workingDirectory: project.workingDirectory, sourceSandboxId: project.sandbox.id,
      sourceProjectId: id, sourceTemplate: project.sandbox.template };
    const create = async (path: string) => {
      const partial = `${path}.partial`;
      try {
        const file = await runtime.createArchive!(target(project), partial);
        await this.phase(id, '校验备份');
        await this.validate({ ...file, storagePath: partial, createdAt: new Date().toISOString() });
        await rename(partial, path);
        return file;
      } finally { await rm(partial, { force: true }); }
    };
    const archives = this.deps.archives();
    if (archives) {
      const version = await archives.create(project.archiveKey, metadata, create);
      // Save the stream pointer first; the latest version remains discoverable even if display metadata fails.
      if (!project.archiveKey) await this.deps.projects.saveArchiveKey(id, version.archiveKey);
      await this.deps.projects.updateSandboxDataArchive(id, { ...metadata, key: version.archiveKey,
        sizeBytes: version.sizeBytes, sha256: version.sha256, createdAt: version.createdAt, manifestSha256: version.sha256 });
    } else {
      await mkdir(this.deps.directory, { recursive: true, mode: 0o700 });
      const key = `${randomUUID()}.tar.gz`;
      const file = await create(join(this.deps.directory, key));
      await this.deps.projects.saveDataArchive(id, { ...metadata, ...file, key, createdAt: new Date().toISOString(), manifestSha256: file.sha256 });
    }
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

  private async restore(id: string) {
    const { projects, runtime } = this.deps;
    await this.phase(id, '校验最新备份');
    const backup = await this.latest(id);
    await this.validate(backup);
    if (!runtime.createReplacement || !runtime.restoreReplacement || !runtime.verifySandbox || !runtime.fenceSandbox || !runtime.detachSandbox) {
      throw new HttpError(503, 'Sandbox 不支持替换式恢复');
    }
    await this.inspect(id);
    const project = projects.get(id);
    if (project.status !== 'archived' && project.sandbox?.status === 'ready') {
      throw new HttpError(409, 'Sandbox 正常，无需恢复环境');
    }
    if (project.sandbox) {
      await this.phase(id, '停止旧环境');
      await runtime.fenceSandbox(project.sandbox);
      await runtime.detachSandbox(target(project));
      await this.deps.saveSandbox(id, { ...project.sandbox, status: 'unavailable' }, false);
    }
    await this.phase(id, '准备新环境');
    const replacement = await runtime.createReplacement(target(project), sandbox => this.rememberCleanup(id, sandbox));
    try {
      await this.phase(id, '恢复数据');
      await runtime.restoreReplacement(replacement, backup.storagePath);
      await this.phase(id, '验证环境');
      await runtime.verifySandbox(replacement);
    } catch (error) {
      // Keep failed candidates tracked for cleanup, but never expose them as the project environment.
      await runtime.fenceSandbox(replacement).catch(() => {});
      throw error;
    }
    await this.phase(id, '切换环境');
    if (project.sandbox) await this.rememberCleanup(id, project.sandbox);
    await this.deps.saveSandbox(id, { ...replacement, status: 'ready' }, project.status === 'archived');
    runtime.track?.(target(projects.get(id)), sandbox => this.deps.saveSandbox(id, sandbox, false));
    await this.phase(id, '清理旧环境');
    await this.cleanup(id);
  }

  private async archive(id: string, useExistingBackup: boolean) {
    const { projects, runtime } = this.deps;
    if (projects.get(id).status === 'archived') return;
    await this.inspect(id);
    const project = projects.get(id);
    if (project.sandbox?.status === 'ready') {
      // Do not fall back to an older backup when exporting a healthy environment fails.
      await this.backup(id);
    } else {
      const latest = await this.latest(id);
      await this.validate(latest);
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

  async close() { await Promise.allSettled(this.tasks); }

  async retryCleanup(id: string) {
    const release = this.deps.projects.beginMaintenance(id);
    const task = this.cleanup(id).finally(release);
    this.tasks.add(task);
    void task.finally(() => this.tasks.delete(task)).catch(() => {});
    return task;
  }
}
