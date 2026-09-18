import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { ArchiveStore } from './store.js';
import type { ArchiveVersion, CreateArchiveVersionInput } from './types.js';

export interface FileInfo {
  sizeBytes: number;
  sha256: string;
}

/**
 * 归档业务层：编排归档创建、清理策略、物理文件管理
 * 不依赖任何业务实体（Project、Session 等），驱动方传入 metadata
 */
export class ArchiveManager {
  constructor(
    private store: ArchiveStore,
    private archivesDir: string,
  ) {}

  /**
   * 创建归档
   * @param archiveKey - 归档流 key，不传则自动生成（新归档流）
   * @param metadata - 需要在归档版本上保存的元数据
   * @param createFn - 实际创建归档文件的函数
   */
  async create(
    archiveKey: string | undefined,
    metadata: Record<string, unknown>,
    createFn: (destinationPath: string) => Promise<FileInfo>,
  ): Promise<ArchiveVersion> {
    const key = archiveKey ?? randomUUID();
    await this.store.createStream(key);

    await mkdir(this.archivesDir, { recursive: true, mode: 0o700 });
    const id = randomUUID();
    const storagePath = join(this.archivesDir, `${id}.tar.gz`);

    const fileInfo = await createFn(storagePath);

    const input: CreateArchiveVersionInput = {
      storagePath,
      sizeBytes: fileInfo.sizeBytes,
      sha256: fileInfo.sha256,
      metadata,
    };

    return this.store.createVersion(key, input);
  }

  /** 获取最新版本 */
  async getLatest(archiveKey: string): Promise<ArchiveVersion | undefined> {
    return this.store.getLatest(archiveKey);
  }

  /** 列出版本 */
  async listVersions(archiveKey: string): Promise<ArchiveVersion[]> {
    return this.store.listVersions(archiveKey);
  }

  /** 获取所有归档流 key */
  async listStreamKeys(): Promise<string[]> {
    return this.store.listStreamKeys();
  }

  /** 保留最近 N 个版本 */
  async retain(archiveKey: string, keepCount: number): Promise<number> {
    return this.store.retain(archiveKey, keepCount);
  }

  /** 对所有归档流保留最近 N 个版本 */
  async retainAll(keepCount: number): Promise<number> {
    const keys = await this.store.listStreamKeys();
    let total = 0;
    for (const key of keys) {
      total += await this.store.retain(key, keepCount);
    }
    return total;
  }

  /** 物理清理：删除软删除版本的磁盘文件 + 数据库记录 */
  async sweep(): Promise<number> {
    const deleted = await this.store.listSoftDeleted();
    if (!deleted.length) return 0;

    let fileDeleted = 0;
    for (const { id, storagePath } of deleted) {
      try {
        await rm(storagePath, { force: true });
        fileDeleted++;
      } catch {
        // 文件已不存在，仍清理数据库记录
      }
    }

    await this.store.hardDelete(deleted.map(d => d.id));
    return fileDeleted;
  }

  /** 关闭 */
  async close(): Promise<void> {
    await this.store.close();
  }
}