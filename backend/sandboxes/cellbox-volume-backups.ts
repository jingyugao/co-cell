import type { SandboxLifecycle, SandboxLifecycleContext } from '@co-cell/sandbox';
import { CellboxError, type CellboxSandboxProvider, type CellboxOperation, type CellboxVolumeBackup } from '../../packages/sandbox/src/providers/cellbox/index.js';
import type { CellboxVolumeBackupRef, RemoteArchiveRef } from '../../protocol/remote-archive-types.js';
import type { SandboxMount, SandboxState } from '../../protocol/sandbox-types.js';
import { sandboxMounts } from '../../util/sandbox-mounts.js';
import { HttpError } from '../../util/errors.js';
import type { RemoteArchives } from '../archives/remote.js';
import type { WorkspaceTarget } from './types.js';

/** The backup succeeded; failure to read its catalog must not be reported as data loss. */
export class BackupCatalogUnavailable extends Error {
  readonly code = 'BACKUP_CATALOG_UNAVAILABLE';
  constructor(readonly volumeId: string, readonly snapshotId: string, cause: unknown) {
    super('磁盘备份已完成，但暂时无法读取备份详情；后续资源清理已停止。', { cause });
  }
}

const key = (volumeId: string, snapshotId: string) => `volume:${volumeId}:${snapshotId}`;
const mountsFor = (target: WorkspaceTarget) => target.sandboxMounts ?? sandboxMounts(target.sandbox ?? {}) ?? [];

function reference(snapshot: CellboxVolumeBackup, mounts: SandboxMount[], saved?: CellboxVolumeBackupRef): CellboxVolumeBackupRef {
  return { storageType: 'cellbox-volume', id: key(snapshot.volumeId, snapshot.id), volumeId: snapshot.volumeId,
    snapshotId: snapshot.id, ownerKey: snapshot.ownerKey, profileId: snapshot.profileId,
    mounts: structuredClone(mounts), threadIds: saved?.threadIds ?? [], createdAt: snapshot.createdAt,
    ...(saved?.sourceSandboxId ? { sourceSandboxId: saved.sourceSandboxId } : {}),
    ...(snapshot.sizeBytes === undefined ? {} : { sizeBytes: snapshot.sizeBytes }),
    ...(snapshot.addedBytes === undefined ? {} : { addedBytes: snapshot.addedBytes }) };
}

export function createCellboxVolumeBackups(provider: CellboxSandboxProvider, profileId: string, lifecycle: SandboxLifecycle) {
  return {
    policy: () => provider.client.getBackupPolicy(),
    async list(target: WorkspaceTarget, saved: readonly RemoteArchiveRef[]): Promise<RemoteArchiveRef[]> {
      const current = mountsFor(target);
      const native = saved.filter((ref): ref is CellboxVolumeBackupRef => ref.storageType === 'cellbox-volume');
      const volumes = new Set([...current.map(mount => mount.volumeId), ...native.map(ref => ref.volumeId)]);
      const lists: CellboxVolumeBackupRef[][] = [];
      for (const volumeId of volumes) {
        const snapshots = await provider.client.listVolumeBackups(volumeId);
        const destinations = current.filter(mount => mount.volumeId === volumeId);
        const fallback = native.find(ref => ref.volumeId === volumeId)?.mounts;
        lists.push(snapshots.map(snapshot => reference(snapshot, destinations.length ? destinations : fallback ?? [],
          native.find(ref => ref.volumeId === volumeId && ref.snapshotId === snapshot.id))));
      }
      return [...saved.filter(ref => ref.storageType !== 'cellbox-volume'), ...lists.flat()]
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },
    async capture(target: WorkspaceTarget, _requestId: string, options?: Parameters<RemoteArchives['capture']>[2]) {
      let mounts = mountsFor(target);
      // Older project records may only have a Box reference. Reading its mount
      // metadata does not connect to, pause, or start the Sandbox.
      if (!mounts.length && target.sandbox) {
        const box = await provider.client.getBox(target.sandbox.id);
        mounts = box.mounts ?? (box.homeVolumeId ? [{ volumeId: box.homeVolumeId, mountPath: '/home/agent' }] : []);
      }
      const ids = [...new Set(mounts.map(mount => mount.volumeId))];
      if (!ids.length) throw new HttpError(409, '项目没有可备份的独立磁盘');
      if (ids.length !== 1) throw new HttpError(422, '项目挂载了多个独立磁盘；当前项目备份只支持单个磁盘，尚未提交备份。');
      const volumeId = ids[0];
      let operation: CellboxOperation | undefined;
      if (options?.recovery) {
        const snapshots = await provider.client.listVolumeBackups(volumeId);
        const baseline = options.recovery.snapshotIds;
        const recovered = baseline && snapshots.filter(snapshot => !baseline.includes(snapshot.id))
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
        if (recovered) {
          const { threadIds: _threads, ...metadata } = reference(recovered, mounts);
          return { ...metadata, ...(target.sandbox ? { sourceSandboxId: target.sandbox.id } : {}) };
        }
        if (!baseline) await options.onSnapshotBaseline?.(volumeId, snapshots.map(snapshot => snapshot.id));
        const volume = await provider.client.getVolume(volumeId);
        const operationId = volume.operationId ?? options.recovery.operationId;
        if (operationId) {
          const observed = await provider.client.getOperation(operationId);
          if (observed.kind !== 'volume-backup' || observed.targetId !== volumeId)
            throw new CellboxError('BUSY', '磁盘正在执行其他操作，请稍后重试删除');
          // A known failed operation can be explicitly retried. An accepted
          // operation is joined even if the original HTTP response was lost.
          if (observed.status !== 'failed') operation = observed;
        }
      }
      operation ??= await provider.client.createVolumeBackup(volumeId);
      await options?.onOperation?.(operation.id, volumeId);
      const completed = await provider.waitForOperation(operation);
      const snapshotId = completed.result?.backupId;
      if (!snapshotId) throw new CellboxError('UNKNOWN_OUTCOME', 'Cellbox completed the backup without returning its snapshot ID');
      let snapshot: CellboxVolumeBackup;
      try { snapshot = await provider.client.getVolumeBackup(volumeId, snapshotId); }
      catch (cause) { throw new BackupCatalogUnavailable(volumeId, snapshotId, cause); }
      const value = reference(snapshot, mounts);
      const { threadIds: _threads, ...metadata } = value;
      return { ...metadata, ...(target.sandbox ? { sourceSandboxId: target.sandbox.id } : {}),
        ...(completed.result?.retentionError ? { retentionError: completed.result.retentionError } : {}) };
    },
    async inspect(ref: CellboxVolumeBackupRef) {
      const snapshot = await provider.client.getVolumeBackup(ref.volumeId, ref.snapshotId);
      const { threadIds: _threads, ...metadata } = reference(snapshot, ref.mounts, ref);
      return metadata;
    },
    async restore(target: WorkspaceTarget, ref: CellboxVolumeBackupRef, _requestId: string,
      onCandidate: Parameters<RemoteArchives['restore']>[3], options?: Parameters<RemoteArchives['restore']>[4]): Promise<SandboxState> {
      if (!ref.mounts.length || new Set(ref.mounts.map(mount => mount.volumeId)).size !== 1)
        throw new HttpError(422, '备份缺少可用的磁盘挂载信息，尚未提交恢复。');
      const ownerKey = `project:${target.projectId ?? target.id}`;
      const context: SandboxLifecycleContext = { action: 'restore', resourceKey: ownerKey };
      return lifecycle.run(context, async () => {
        const operation = await provider.client.restoreVolume({ sourceVolumeId: ref.volumeId, backupId: ref.snapshotId, ownerKey });
        await options?.onOperation?.(operation.id);
        const mounts = ref.mounts.map(mount => ({ ...mount, volumeId: operation.targetId }));
        await options?.onVolume?.({ volumeId: operation.targetId, ownerKey, mounts });
        await provider.waitForOperation(operation);
        const selector = target.imageSelection?.revisionId ? { revisionId: target.imageSelection.revisionId }
          : target.imageSelection?.templateId ? { templateId: target.imageSelection.templateId } : provider.defaultSelector;
        const created = await provider.client.createBox({ ...selector, ownerKey, mounts, staged: true });
        await options?.onOperation?.(created.id);
        const candidate: SandboxState = { id: created.targetId, template: profileId, status: 'starting', ownerKey,
          mounts, workingDirectory: target.settings.workingDirectory };
        context.sandboxId = candidate.id;
        await onCandidate(candidate);
        await provider.waitForOperation(created);
        const box = await provider.client.getBox(candidate.id);
        return { ...candidate, mounts: box.mounts ?? mounts, homeVolumeId: box.homeVolumeId,
          image: { reference: box.image, id: box.imageId ?? box.image, repoDigests: [],
            ...(box.revisionId ? { revisionId: box.revisionId } : {}), ...(box.templateId ? { templateId: box.templateId } : {}) } };
      });
    },
    async removeVolume(volumeId: string) {
      const read = () => provider.client.getVolume(volumeId).catch(error => {
        if (error instanceof CellboxError && error.code === 'NOT_FOUND') return undefined;
        throw error;
      });
      const volume = await read();
      if (!volume || volume.phase === 'deleted') return;
      if (volume.operationId) {
        const operation = await provider.client.getOperation(volume.operationId);
        if (operation.kind !== 'volume-delete' || operation.targetId !== volumeId)
          throw new CellboxError('BUSY', '磁盘正在执行其他操作，请稍后重试删除');
        await provider.waitForOperation(operation);
        return;
      }
      try {
        await provider.waitForOperation(await provider.client.deleteVolume(volumeId));
      } catch (error) {
        if (error instanceof CellboxError && ['NOT_FOUND', 'CONFLICT', 'BUSY'].includes(error.code)) {
          const current = await read();
          if (!current || current.phase === 'deleted') return;
        }
        throw error;
      }
    },
  };
}
