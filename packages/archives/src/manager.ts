import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ArchiveDao } from './dao.js';
import type { ArchiveVersion, FileArchiveVersion, SnapshotArchiveVersion, CreateArchiveVersionInput } from './types.js';
import { ArchiveContentService, RevisionDriver } from './content.js';
import type { ArchiveService, ArchiveCapturedVersion, ArchiveFileInfo, ArchiveRevisionInput,
  PendingArchiveBackup, ArchiveCommandResult } from './contract.js';
import type { ArchiveCommand } from './driver.js';
import { ARCHIVE_FORMAT } from './formats.js';


/**
 * 归档业务层：编排归档创建、清理策略、物理文件管理
 * 不依赖任何业务实体（Project、Session 等），驱动方传入 metadata
 */
export class ArchiveManager extends ArchiveContentService implements ArchiveService {
  constructor(
    private dao: ArchiveDao,
    private archivesDir: string,
    private readonly storage?: RevisionDriver,
    private readonly commandPaths: { sandboxArchiveDirectory?: string; sandboxRepositoryRoot?: string } = {},
  ) { super(storage, archivesDir); }

  get supportsSnapshots(): boolean { return this.storage !== undefined; }

  async beginBackup(input: { storeId: string; archiveKey?: string; hostBacked: boolean;
    metadata: Record<string, unknown> }): Promise<PendingArchiveBackup> {
    const archiveKey = input.archiveKey ?? input.storeId;
    const format = input.hostBacked && this.storage ? ARCHIVE_FORMAT.snapshot : ARCHIVE_FORMAT.file;
    if (format === ARCHIVE_FORMAT.snapshot && !this.commandPaths.sandboxRepositoryRoot) {
      throw new Error('Sandbox revision repository path is not configured');
    }
    let storagePath: string | null = null;
    const id = randomUUID();
    if (format === ARCHIVE_FORMAT.file) {
      if (!this.commandPaths.sandboxArchiveDirectory) throw new Error('Sandbox archive directory is not configured');
      await mkdir(this.archivesDir, { recursive: true, mode: 0o700 });
      storagePath = this.file.storagePath({ storeId: archiveKey, revisionId: id });
    }
    await this.dao.beginPendingVersion(id, archiveKey, format, storagePath, input.metadata,
      format === ARCHIVE_FORMAT.snapshot ? input.storeId : null);
    return { id, storeId: input.storeId };
  }

  async listPendingBackups(): Promise<PendingArchiveBackup[]> {
    return (await this.dao.listPendingVersions()).map(item => ({ id: item.id,
      storeId: item.repositoryId ?? item.archiveKey }));
  }

  async commandForBackup(id: string, input: { sandboxId: string; sourceRoot: string;
    ignores: readonly string[] }): Promise<ArchiveCommand> {
    const pending = await this.dao.getPendingVersion(id);
    if (!pending) throw new Error('Pending archive version not found');
    if (pending.format === ARCHIVE_FORMAT.file) {
      if (!pending.storagePath) throw new Error('Pending file archive has no destination');
      if (!this.commandPaths.sandboxArchiveDirectory) throw new Error('Sandbox archive directory is not configured');
      return this.file.getCmd({ storeId: pending.archiveKey, sandboxId: input.sandboxId,
        sourceRoot: input.sourceRoot, ignores: input.ignores,
        storagePath: join(this.commandPaths.sandboxArchiveDirectory,
          this.file.relativePath({ storeId: pending.archiveKey, revisionId: pending.id })) });
    }
    if (!this.storage || !this.commandPaths.sandboxRepositoryRoot) {
      throw new Error('Sandbox revision repository path is not configured');
    }
    if (!pending.repositoryId) throw new Error('Pending revision archive has no store ID');
    return this.storage.getCmd({ storeId: pending.repositoryId, sandboxId: input.sandboxId,
      sourceRoot: input.sourceRoot, ignores: input.ignores,
      storagePath: join(this.commandPaths.sandboxRepositoryRoot, pending.repositoryId) });
  }

  async finishBackup(id: string, result: ArchiveCommandResult): Promise<ArchiveVersion> {
    const pending = await this.dao.getPendingVersion(id);
    if (!pending) throw new Error('Pending archive version not found');
    if (result.exitCode !== 0) throw new Error(`Archive command failed with exit code ${result.exitCode}`);
    if (pending.format === ARCHIVE_FORMAT.file) {
      if (!pending.storagePath) throw new Error('Pending file archive has no destination');
      const info = await this.file.inspect(pending.storagePath);
      await this.file.validate({ format: ARCHIVE_FORMAT.file, storagePath: pending.storagePath,
        ...info, createdAt: new Date().toISOString() });
      return this.dao.finishPendingVersion(id, { format: ARCHIVE_FORMAT.file, ...info });
    }
    if (!this.storage) throw new Error('Revision archives are unavailable');
    if (!pending.repositoryId) throw new Error('Pending revision archive has no store ID');
    const summary = this.storage.parseCommandResult(result.stdout);
    await this.storage.validate({ format: ARCHIVE_FORMAT.snapshot, repositoryId: pending.repositoryId,
      ...summary, createdAt: new Date().toISOString() });
    return this.dao.finishPendingVersion(id, { format: ARCHIVE_FORMAT.snapshot, ...summary });
  }

  async failBackup(id: string): Promise<void> { await this.dao.failPendingVersion(id); }

  async initializeStorage(): Promise<void> { await this.storage?.initialize(); }

  async prepareSnapshot(storeId: string, sourceRoot: string): Promise<void> {
    if (!this.storage) throw new Error('Incremental archives are unavailable');
    await this.storage.prepare(storeId, sourceRoot);
  }

  async captureSnapshot(storeId: string, sandboxId: string, sourceRoot: string, ignores: string[]): Promise<ArchiveCapturedVersion> {
    if (!this.storage) throw new Error('Incremental archives are unavailable');
    return this.storage.create({ storeId, sandboxId, sourceRoot, ignores });
  }

  /**
   * 创建归档
   * @param archiveKey - 归档流 key，不传则自动生成（新归档流）
   * @param metadata - 需要在归档版本上保存的元数据
   * @param createFn - 实际创建归档文件的函数
   */
  async create(
    archiveKey: string | undefined,
    metadata: Record<string, unknown>,
    createFn: (destinationPath: string) => Promise<ArchiveFileInfo>,
  ): Promise<FileArchiveVersion> {
    const key = archiveKey ?? randomUUID();
    await this.dao.createStream(key);

    const id = randomUUID();
    const fileInfo = await this.file.create({ storeId: key, revisionId: id, write: createFn });

    const input: CreateArchiveVersionInput = {
      id,
      storagePath: fileInfo.storagePath,
      sizeBytes: fileInfo.sizeBytes,
      sha256: fileInfo.sha256,
      metadata,
    };

    return this.dao.insertFileVersion(key, input);
  }

  /** Register a Restic snapshot after its caller has created and verified it. */
  async recordVersion(
    archiveKey: string,
    input: ArchiveRevisionInput,
  ): Promise<SnapshotArchiveVersion> {
    await this.dao.createStream(archiveKey);
    return this.dao.insertSnapshotVersion(archiveKey, { repositoryId: input.location.storeId,
      snapshotId: input.location.revisionId, logicalSizeBytes: input.logicalSizeBytes,
      bytesAdded: input.bytesAdded, metadata: input.metadata });
  }

  async revertLatestVersion(archiveKey: string, versionId: string): Promise<boolean> {
    return this.dao.revertVersion(archiveKey, versionId);
  }

  /** 获取最新版本 */
  async getLatest(archiveKey: string): Promise<ArchiveVersion | undefined> {
    return this.dao.getLatest(archiveKey);
  }

  async getVersion(archiveKey: string, id: string): Promise<ArchiveVersion | undefined> {
    return this.dao.getVersion(archiveKey, id);
  }

  /** 列出版本 */
  async listVersions(archiveKey: string): Promise<ArchiveVersion[]> {
    return this.dao.listVersions(archiveKey);
  }

  /** 获取所有归档流 key */
  async listStreamKeys(): Promise<string[]> {
    return this.dao.listStreamKeys();
  }

  /** 保留最近 N 个版本 */
  async retain(archiveKey: string, keepCount: number): Promise<number> {
    return this.dao.retain(archiveKey, keepCount);
  }

  async applyRetention(archiveKey: string, keepCount: number): Promise<number> {
    return this.dao.retainRestic(archiveKey, keepCount);
  }

  /** 对所有归档流保留最近 N 个版本 */
  async retainAll(keepCount: number): Promise<number> {
    const keys = await this.dao.listStreamKeys();
    let total = 0;
    for (const key of keys) {
      total += await this.dao.retain(key, keepCount);
    }
    return total;
  }

  /** 物理清理：删除软删除版本的磁盘文件 + 数据库记录 */
  async sweep(): Promise<number> {
    const deleted = await this.dao.listSoftDeleted();
    if (!deleted.length) return 0;

    let fileDeleted = 0;
    for (const { id, storagePath } of deleted) {
      try {
        await this.file.removeStored(storagePath);
      } catch {
        // Keep the row for retry if physical cleanup fails.
        continue;
      }
      await this.dao.hardDelete([id]);
      fileDeleted++;
    }
    return fileDeleted;
  }

  /** Forget database-retired snapshots, then reclaim unreferenced packs. */
  async sweepManagedVersions(): Promise<number> {
    const revision = this.storage;
    if (!revision) return 0;
    const pending = await this.dao.listSoftDeletedRestic();
    const byStore = new Map<string, typeof pending>();
    for (const item of pending) {
      const items = byStore.get(item.repositoryId) ?? [];
      items.push(item);
      byStore.set(item.repositoryId, items);
    }
    let removed = 0;
    for (const [storeId, items] of byStore) {
      const unreferenced = [];
      for (const item of items) {
        if (!await this.dao.isSnapshotReferenced(storeId, item.snapshotId)) unreferenced.push(item);
      }
      if (!unreferenced.length) continue;
      await revision.remove(unreferenced.map(item => ({ storeId, revisionId: item.snapshotId })));
      await this.dao.hardDelete(unreferenced.map(item => item.id));
      removed += unreferenced.length;
    }
    return removed;
  }

  /** Return crash-left snapshots that have no archive row; never delete them automatically. */
  async unrecordedVersions(): Promise<Array<{ storeId: string; revisionId: string }>> {
    const revision = this.storage;
    if (!revision) return [];
    const referenced = new Set((await this.dao.listResticReferences()).map(item => `${item.repositoryId}/${item.snapshotId}`));
    return revision.unrecordedVersions(referenced);
  }

  /** 关闭 */
  async close(): Promise<void> {
    await this.dao.close();
  }
}
