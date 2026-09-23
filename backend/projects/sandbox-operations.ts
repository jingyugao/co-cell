import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Project, ProjectSandboxOperation } from '../../protocol/types.js';
import type { SandboxState } from '../../protocol/sandbox-types.js';
import type { SandboxRuntime } from '../execution/container-runtime.js';
import { createArchiveReader, type ArchiveService } from '@co-cell/archives';
import type { WorkspaceTarget } from '../sandboxes/types.js';
import type { ProjectService } from './service.js';
import { HttpError } from '../../util/errors.js';
import type { RuntimeLog } from '../infra/diagnostics/runtime-log.js';

const target = (project: Project): WorkspaceTarget => ({ id: project.id, projectId: project.id,
  settings: { workingDirectory: project.workingDirectory }, sandbox: project.sandbox, updatedAt: project.updatedAt });

type ArchiveVersion = NonNullable<Awaited<ReturnType<ArchiveService['getLatest']>>>;
type Backup = Parameters<ArchiveService['validate']>[0] | ArchiveVersion;
type ArchiveContent = Pick<ArchiveService, 'validate' | 'restore'>;

/** Project lifecycle orchestration. Backup versions and provider failures stay in their own modules. */
export class ProjectSandboxOperations {
  private tasks = new Set<Promise<void>>();
  private readonly fileReader = createArchiveReader();
  constructor(private deps: {
    projects: ProjectService;
    runtime: SandboxRuntime;
    archives: () => ArchiveService | undefined;
    content?: ArchiveContent;
    directory: string;
    threadIds: (id: string) => string[];
    saveSandbox: (id: string, sandbox: SandboxState, restore: boolean) => Promise<void>;
    detached: (id: string) => Promise<void>;
    logger?: RuntimeLog;
    backupIgnore?: string[];
  }) {}

  private content(): ArchiveContent {
    return this.deps.content ?? this.deps.archives() ?? this.fileReader;
  }

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
    return this.fileReader.artifactFromFile({ ...legacy, storagePath: join(this.deps.directory, legacy.key),
      metadata: { threadIds: legacy.threadIds } });
  }

  private async validate(backup: Backup) {
    const label = 'version' in backup ? `版本 ${backup.version}` : '最新备份';
    try { await this.content().validate(backup); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as Error).message === 'Tar archive size does not match') {
        throw new HttpError(409, `${label}不存在、为空或大小不符，操作已停止`);
      }
      throw new HttpError(409, `${label}校验失败，操作已停止；不会使用旧版本或空环境`);
    }
  }

  private async phase(id: string, phase: string) {
    const operation = this.deps.projects.get(id).sandboxOperation!;
    await this.deps.projects.updateSandboxOperation(id, { ...operation, phase, updatedAt: new Date().toISOString() });
  }

  run(id: string, kind: ProjectSandboxOperation['kind'], options: { useExistingBackup?: boolean; targetImageId?: string } = {}): Promise<void> {
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
        } else if (kind === 'migrate') await this.migrate(id);
        else if (kind === 'switch') await this.switchVersion(id, options.targetImageId);
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

  private async commandBackup(id: string, sandboxId: string, archiveKey: string | undefined,
    metadata: Record<string, unknown>): Promise<{ version: ArchiveVersion; durationMs: number }> {
    const archives = this.deps.archives();
    const runtime = this.deps.runtime;
    if (!archives || !runtime.archiveSourceRoot || !runtime.quiesceForBackup || !runtime.executeArchiveCommand) {
      throw new HttpError(503, 'Sandbox 不支持命令式备份');
    }
    const sourceRoot = await runtime.archiveSourceRoot(sandboxId);
    if (!sourceRoot) throw new HttpError(503, 'Sandbox 缺少已验证的备份数据挂载');
    await this.phase(id, '准备一致性备份');
    const release = await runtime.quiesceForBackup(sandboxId);
    let pending: Awaited<ReturnType<ArchiveService['beginBackup']>> | undefined;
    const started = Date.now();
    try {
      pending = await archives.beginBackup({ storeId: id, archiveKey, hostBacked: true,
        metadata: { ...metadata, verified: true } });
      const command = await archives.commandForBackup(pending.id, {
        sandboxId, sourceRoot, ignores: this.deps.backupIgnore ?? [],
      });
      await this.phase(id, '创建增量快照');
      const result = await runtime.executeArchiveCommand(sandboxId, command);
      await this.phase(id, '校验备份');
      const version = await archives.finishBackup(pending.id, result);
      return { version, durationMs: Date.now() - started };
    } catch (error) {
      if (pending) await archives.failBackup(pending.id).catch(failure => {
        void this.deps.logger?.write({ event: 'sandbox.backup_fail_record_failed', projectId: id,
          versionId: pending!.id, error: failure });
      });
      throw error;
    } finally { await release(); }
  }

  private async backup(id: string) {
    const project = this.deps.projects.get(id);
    const runtime = this.deps.runtime;
    if (project.sandbox?.status !== 'ready') throw new HttpError(409, 'Sandbox 不正常，无法生成新备份');
    await this.phase(id, '备份数据');
    const metadata = { format: 'codex-workspace-v1' as const, threadIds: this.deps.threadIds(id),
      workingDirectory: project.workingDirectory, sourceSandboxId: project.sandbox.id,
      sourceProjectId: id, sourceTemplate: project.sandbox.template };
    const archives = this.deps.archives();
    const source = archives?.supportsSnapshots ? await runtime.hostData?.(target(project)) : undefined;
    if (source && archives && runtime.archiveSourceRoot && runtime.quiesceForBackup && runtime.executeArchiveCommand
      && await runtime.archiveSourceRoot(project.sandbox.id)) {
      const { version, durationMs } = await this.commandBackup(id, project.sandbox.id, project.archiveKey, metadata);
      const details = archives.describe(version);
      if (!project.archiveKey) await this.deps.projects.saveArchiveKey(id, version.archiveKey);
      await this.deps.projects.updateLatestBackup(id, { createdAt: version.createdAt,
        sizeBytes: details.sizeBytes, ...(details.bytesAdded === undefined ? {} : { bytesAdded: details.bytesAdded }),
        ...(details.revisionId ? { revisionId: details.revisionId } : {}),
        ...(details.checksum ? { checksum: details.checksum } : {}) }, { clearLegacyArchive: true });
      await this.deps.projects.updateSandboxOperation(id, { ...this.deps.projects.get(id).sandboxOperation!,
        durationMs, scannedBytes: details.sizeBytes,
        ...(details.bytesAdded === undefined ? {} : { addedBytes: details.bytesAdded }),
        ...(details.revisionId ? { snapshotId: details.revisionId } : {}),
        verified: true, updatedAt: new Date().toISOString() });
      await archives.applyRetention(version.archiveKey, project.backupRetentionCount ?? 2).catch(error => {
        void this.deps.logger?.write({ event: 'sandbox.backup_retention_failed', projectId: id, error });
      });
      return;
    }
    if (source && archives && runtime.pauseForBackup && runtime.resumeAfterBackup) {
      await archives.prepareSnapshot(id, source.root);
      await this.phase(id, '暂停环境');
      await runtime.pauseForBackup(project.sandbox.id);
      let snapshot;
      try {
        await this.phase(id, '创建增量快照');
        snapshot = await archives.captureSnapshot(id, project.sandbox.id, source.root, this.deps.backupIgnore ?? []);
      } finally {
        await runtime.resumeAfterBackup(project.sandbox.id);
      }
      await this.phase(id, '记录备份版本');
      let version;
      try {
        version = await archives.recordVersion(project.archiveKey ?? id, {
          location: snapshot.location,
          logicalSizeBytes: snapshot.logicalSizeBytes, bytesAdded: snapshot.bytesAdded,
          metadata: { ...metadata, durationMs: snapshot.durationMs, repositorySizeBytes: snapshot.storageSizeBytes,
            engineVersion: snapshot.engineVersion, verified: true },
        });
      } catch (error) {
        await this.deps.logger?.write({ event: 'sandbox.backup_unrecorded_version', projectId: id,
          location: snapshot.location, error });
        throw error;
      }
      if (!project.archiveKey) await this.deps.projects.saveArchiveKey(id, version.archiveKey);
      await this.deps.projects.updateLatestBackup(id, { createdAt: version.createdAt,
        sizeBytes: snapshot.logicalSizeBytes, bytesAdded: snapshot.bytesAdded,
        storageSizeBytes: snapshot.storageSizeBytes, revisionId: snapshot.location.revisionId }, { clearLegacyArchive: true });
      await this.deps.projects.updateSandboxOperation(id, { ...this.deps.projects.get(id).sandboxOperation!,
        durationMs: snapshot.durationMs, scannedBytes: snapshot.logicalSizeBytes, addedBytes: snapshot.bytesAdded,
        repositorySizeBytes: snapshot.storageSizeBytes,
        snapshotId: snapshot.location.revisionId, verified: true, updatedAt: new Date().toISOString() });
      await archives.applyRetention(version.archiveKey, project.backupRetentionCount ?? 2).catch(error => {
        void this.deps.logger?.write({ event: 'sandbox.backup_retention_failed', projectId: id, error });
      });
      return;
    }
    if (!runtime.createArchive) throw new HttpError(503, '备份模块未配置');
    const create = async (path: string) => {
      const partial = `${path}.partial`;
      try {
        const file = await runtime.createArchive!(target(project), partial);
        await this.phase(id, '校验备份');
        await this.validate(this.fileReader.artifactFromFile({ ...file, storagePath: partial,
          createdAt: new Date().toISOString() }));
        await rename(partial, path);
        return file;
      } finally { await rm(partial, { force: true }); }
    };
    if (archives) {
      const version = await archives.create(project.archiveKey, metadata, create);
      // Save the stream pointer first; the latest version remains discoverable even if display metadata fails.
      if (!project.archiveKey) await this.deps.projects.saveArchiveKey(id, version.archiveKey);
      await this.deps.projects.updateSandboxDataArchive(id, { ...metadata, key: version.archiveKey,
        sizeBytes: version.sizeBytes, sha256: version.sha256, createdAt: version.createdAt, manifestSha256: version.sha256 });
      await this.deps.projects.updateLatestBackup(id, { createdAt: version.createdAt,
        sizeBytes: version.sizeBytes, checksum: version.sha256 });
      await archives.retain(version.archiveKey, project.backupRetentionCount ?? 2).catch(error => {
        void this.deps.logger?.write({ event: 'sandbox.backup_retention_failed', projectId: id, error });
      });
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
    let replacement: SandboxState | undefined;
    try {
      await this.phase(id, '恢复数据');
      await this.content().restore(backup, {
        restoreFromFile: async path => {
          replacement = await runtime.createReplacement!(target(project), sandbox => this.rememberCleanup(id, sandbox));
          await runtime.restoreReplacement!(replacement, path);
        },
        restoreIntoDirectory: async populate => {
          if (!runtime.createStoppedReplacement || !runtime.startReplacement) throw new HttpError(503, 'Sandbox 不支持目录恢复');
          const staged = await runtime.createStoppedReplacement(target(project), sandbox => this.rememberCleanup(id, sandbox));
          replacement = staged.sandbox;
          await populate(staged.root);
          await runtime.startReplacement(replacement);
        },
      });
      if (!replacement) throw new Error('恢复操作没有创建 Sandbox');
      await this.phase(id, '验证环境');
      await runtime.verifySandbox(replacement);
      if (runtime.verifyHistory) {
        const threadIds = Array.isArray(backup.metadata?.threadIds)
          ? backup.metadata.threadIds.filter((value): value is string => typeof value === 'string') : [];
        await runtime.verifyHistory(replacement, threadIds);
      }
    } catch (error) {
      // Keep failed candidates tracked for cleanup, but never expose them as the project environment.
      if (replacement) await runtime.fenceSandbox(replacement).catch(() => {});
      throw error;
    }
    if (!replacement) throw new Error('恢复操作没有创建 Sandbox');
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

  /** Switch a ready project to the currently configured image, preserving the old binding until verification. */
  private async switchVersion(id: string, targetImageId: string | undefined) {
    const { projects, runtime } = this.deps;
    const project = projects.get(id);
    if (!targetImageId || !/^sha256:[a-f0-9]{64}$/.test(targetImageId)) throw new HttpError(400, '目标 Sandbox 版本无效');
    if (project.status === 'archived' || project.sandbox?.status !== 'ready') throw new HttpError(409, '仅可切换正常运行的项目 Sandbox');
    if (!runtime.currentImageIdentity) throw new HttpError(503, 'Sandbox 不支持版本切换');
    const latestImage = await runtime.currentImageIdentity();
    if (latestImage.id !== targetImageId) throw new HttpError(409, 'Sandbox 最新版本已变化，请刷新页面');
    if (project.sandbox.image?.id === targetImageId) throw new HttpError(409, '项目已使用此 Sandbox 版本');
    await this.inspect(id);
    if (projects.get(id).sandbox?.status !== 'ready') throw new HttpError(409, 'Sandbox 不正常，无法切换版本');
    if (!await runtime.hostData?.(target(project))) return this.migrate(id, targetImageId);
    if (!runtime.createStoppedReplacement || !runtime.startReplacement || !runtime.verifySandbox
      || !runtime.fenceSandbox || !runtime.detachSandbox || !runtime.verifyHistory) {
      throw new HttpError(503, 'Sandbox 不支持安全版本切换');
    }
    await this.phase(id, '备份当前环境');
    await this.backup(id);
    // The backup was verified when captured; restore verifies it again before reading.
    const backup = await this.latest(id);
    await this.phase(id, '准备新版本 Sandbox');
    const staged = await runtime.createStoppedReplacement(target(project), sandbox => this.rememberCleanup(id, sandbox));
    let switched = false;
    try {
      await this.phase(id, '恢复备份');
      await this.content().restore(backup, {
        restoreFromFile: async () => { throw new Error('主机数据目录的版本切换需要目录备份'); },
        restoreIntoDirectory: populate => populate(staged.root),
      });
      await runtime.startReplacement(staged.sandbox);
      await this.phase(id, '验证新环境');
      await runtime.verifySandbox(staged.sandbox);
      if (staged.sandbox.image?.id !== targetImageId) throw new Error('新 Sandbox 镜像版本与目标版本不一致');
      const threadIds = Array.isArray(backup.metadata?.threadIds)
        ? backup.metadata.threadIds.filter((value): value is string => typeof value === 'string') : [];
      await runtime.verifyHistory(staged.sandbox, threadIds);
      await this.phase(id, '切换环境');
      await this.rememberCleanup(id, project.sandbox);
      await runtime.fenceSandbox(project.sandbox);
      await runtime.detachSandbox(target(project));
      await this.deps.saveSandbox(id, { ...staged.sandbox, status: 'ready' }, false);
      switched = true;
      runtime.track?.(target(projects.get(id)), sandbox => this.deps.saveSandbox(id, sandbox, false));
      await this.cleanup(id);
    } catch (error) {
      if (!switched) {
        await runtime.fenceSandbox(staged.sandbox).catch(() => {});
        await runtime.startReplacement(project.sandbox).catch(() => {});
        runtime.track?.(target(projects.get(id)), sandbox => this.deps.saveSandbox(id, sandbox, false));
      }
      throw error;
    }
  }

  /** Explicit one-project cutover from a legacy Docker writable layer to host-backed generations. */
  private async migrate(id: string, targetImageId?: string) {
    const { projects, runtime } = this.deps;
    const project = projects.get(id);
    const archives = this.deps.archives();
    if (!archives?.supportsSnapshots) throw new HttpError(503, '增量备份迁移不可用');
    if (project.status === 'archived' || project.sandbox?.status !== 'ready') throw new HttpError(409, '仅可迁移正常运行的项目 Sandbox');
    if (await runtime.hostData?.(target(project))) throw new HttpError(409, '项目已使用主机数据目录');
    if (!runtime.createReplacement || !runtime.restoreReplacement || !runtime.verifySandbox || !runtime.fenceSandbox
      || !runtime.detachSandbox || !runtime.pauseForBackup || !runtime.resumeAfterBackup || !runtime.hostData) {
      throw new HttpError(503, 'Sandbox 不支持安全迁移');
    }
    await this.inspect(id);
    await this.phase(id, '生成迁移前 tar 备份');
    await this.backup(id);
    // Avoid hashing a large tar here; the restore driver checks it before extraction.
    const fileBackup = await this.latest(id);
    const tarSummary = projects.get(id).latestBackup;
    const tarData = projects.get(id).sandboxDataArchive;
    await this.phase(id, '准备主机数据目录');
    const candidate = await runtime.createReplacement(target(project), sandbox => this.rememberCleanup(id, sandbox));
    let switched = false;
    let versionId: string | undefined;
    try {
      await this.phase(id, '恢复迁移前数据');
      await this.content().restore(fileBackup, {
        restoreFromFile: path => runtime.restoreReplacement!(candidate, path),
        restoreIntoDirectory: async () => { throw new Error('迁移前备份必须是文件归档'); },
      });
      await runtime.verifySandbox(candidate);
      if (targetImageId && candidate.image?.id !== targetImageId) throw new Error('新 Sandbox 镜像版本与目标版本不一致');
      await runtime.verifyHistory?.(candidate, this.deps.threadIds(id));
      const staged = await runtime.hostData(target({ ...project, sandbox: candidate }));
      if (!staged) throw new Error('替换 Sandbox 未使用已验证的主机数据目录');
      let version: ArchiveVersion;
      let snapshotSummary: { sizeBytes: number; bytesAdded?: number; revisionId?: string;
        storageSizeBytes?: number; durationMs?: number };
      if (runtime.archiveSourceRoot && runtime.quiesceForBackup && runtime.executeArchiveCommand
        && await runtime.archiveSourceRoot(candidate.id)) {
        const captured = await this.commandBackup(id, candidate.id, projects.get(id).archiveKey ?? id, {
          format: 'codex-workspace-v1', threadIds: this.deps.threadIds(id), sourceProjectId: id,
          sourceSandboxId: candidate.id,
        });
        version = captured.version;
        const details = archives.describe(version);
        snapshotSummary = { sizeBytes: details.sizeBytes, bytesAdded: details.bytesAdded,
          revisionId: details.revisionId, durationMs: captured.durationMs };
      } else {
        await archives.prepareSnapshot(id, staged.root);
        await this.phase(id, '创建首个增量快照');
        await runtime.pauseForBackup(candidate.id);
        let snapshot;
        try { snapshot = await archives.captureSnapshot(id, candidate.id, staged.root, this.deps.backupIgnore ?? []); }
        finally { await runtime.resumeAfterBackup(candidate.id); }
        version = await archives.recordVersion(projects.get(id).archiveKey ?? id, {
          location: snapshot.location, logicalSizeBytes: snapshot.logicalSizeBytes,
          bytesAdded: snapshot.bytesAdded, metadata: { format: 'codex-workspace-v1',
            threadIds: this.deps.threadIds(id), sourceProjectId: id, sourceSandboxId: candidate.id,
            durationMs: snapshot.durationMs, repositorySizeBytes: snapshot.storageSizeBytes,
            engineVersion: snapshot.engineVersion, verified: true },
        });
        snapshotSummary = { sizeBytes: snapshot.logicalSizeBytes, bytesAdded: snapshot.bytesAdded,
          revisionId: snapshot.location.revisionId, storageSizeBytes: snapshot.storageSizeBytes,
          durationMs: snapshot.durationMs };
      }
      versionId = version.id;
      if (!projects.get(id).archiveKey) await projects.saveArchiveKey(id, version.archiveKey);
      await projects.updateLatestBackup(id, { createdAt: version.createdAt,
        sizeBytes: snapshotSummary.sizeBytes, bytesAdded: snapshotSummary.bytesAdded,
        storageSizeBytes: snapshotSummary.storageSizeBytes, revisionId: snapshotSummary.revisionId }, { clearLegacyArchive: true });
      await this.phase(id, '切换环境');
      await this.rememberCleanup(id, project.sandbox);
      await runtime.fenceSandbox(project.sandbox);
      await runtime.detachSandbox(target(project));
      await this.deps.saveSandbox(id, { ...candidate, status: 'ready' }, false);
      switched = true;
      runtime.track?.(target(projects.get(id)), sandbox => this.deps.saveSandbox(id, sandbox, false));
      await this.cleanup(id);
    } catch (error) {
      let rollbackError: unknown;
      if (!switched) {
        if (versionId) {
          try {
            const reverted = await this.deps.archives()!.revertLatestVersion(projects.get(id).archiveKey ?? id, versionId);
            if (!reverted) throw new Error('无法恢复原 tar 备份指针');
            if (tarSummary) await projects.updateLatestBackup(id, tarSummary);
            if (tarData) await projects.updateSandboxDataArchive(id, tarData);
          } catch (failure) { rollbackError = failure; }
        }
        await runtime.fenceSandbox(candidate).catch(() => {});
        await runtime.startReplacement?.(project.sandbox).catch(() => {});
        runtime.track?.(target(projects.get(id)), sandbox => this.deps.saveSandbox(id, sandbox, false));
      }
      if (rollbackError) throw new Error('迁移失败，且无法恢复原 tar 备份指针；请人工检查归档版本', { cause: rollbackError });
      throw error;
    }
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
