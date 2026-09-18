import { randomUUID } from 'node:crypto';
import { createPool, type Pool, type RowDataPacket } from 'mysql2/promise';
import type { ArchiveStream, ArchiveVersion, CreateArchiveVersionInput, ArchiveListOptions } from './types.js';

interface ArchiveVersionRow extends RowDataPacket {
  id: string;
  archive_key: string;
  version: number;
  parent_id: string | null;
  is_latest: number;
  storage_path: string;
  size_bytes: number | string;
  sha256: string;
  metadata: string;
  status: string;
  created_at: string;
  deleted_at: string | null;
}

interface ArchiveStreamRow extends RowDataPacket {
  archive_key: string;
  latest_version_id: string | null;
  created_at: string;
  updated_at: string;
}

/** 归档数据层：独立管理 archive_info + archive_versions 两张表 */
export class ArchiveStore {
  private pool: Pool;

  constructor(url: string) {
    this.pool = createPool({ uri: url, connectionLimit: 5, charset: 'utf8mb4', timezone: 'Z' });
  }

  async init(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS archive_info (
        archive_key VARCHAR(191) PRIMARY KEY,
        latest_version_id CHAR(36) NULL,
        created_at DATETIME(3) NOT NULL,
        updated_at DATETIME(3) NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS archive_versions (
        id CHAR(36) PRIMARY KEY,
        archive_key VARCHAR(191) NOT NULL,
        version INT UNSIGNED NOT NULL,
        parent_id CHAR(36) NULL,
        is_latest BOOLEAN NOT NULL DEFAULT FALSE,
        storage_path VARCHAR(255) NOT NULL,
        size_bytes BIGINT UNSIGNED NOT NULL,
        sha256 CHAR(64) NOT NULL,
        metadata JSON NOT NULL,
        status ENUM('active','soft_deleted') NOT NULL DEFAULT 'active',
        created_at DATETIME(3) NOT NULL,
        deleted_at DATETIME(3) NULL,
        INDEX idx_versions_key_ver (archive_key, version DESC),
        INDEX idx_versions_key_latest (archive_key, is_latest)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);
  }

  /** 创建归档流 */
  async createStream(key: string): Promise<ArchiveStream> {
    const now = new Date().toISOString().slice(0, 23).replace('T', ' ');
    await this.pool.query(
      'INSERT IGNORE INTO archive_info (archive_key, latest_version_id, created_at, updated_at) VALUES (?, NULL, ?, ?)',
      [key, now, now],
    );
    return { archiveKey: key, latestVersionId: null, createdAt: now, updatedAt: now };
  }

  /** 获取归档流 */
  async getStream(key: string): Promise<ArchiveStream | undefined> {
    const [rows] = await this.pool.query<ArchiveStreamRow[]>(
      'SELECT archive_key, latest_version_id, created_at, updated_at FROM archive_info WHERE archive_key = ?',
      [key],
    );
    if (!rows.length) return undefined;
    return this.toStream(rows[0]);
  }

  /** 创建新版本（事务：加行锁 → 插入 → 更新最新指针） */
  async createVersion(
    archiveKey: string,
    input: CreateArchiveVersionInput,
  ): Promise<ArchiveVersion> {
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();

      // 1. 锁定归档流，串行化同一 key 的写入
      const [info] = await conn.query<ArchiveStreamRow[]>(
        'SELECT archive_key, latest_version_id FROM archive_info WHERE archive_key = ? FOR UPDATE',
        [archiveKey],
      );
      if (!info.length) {
        // 流不存在则自动创建
        const now = this.mysqlNow();
        await conn.query(
          'INSERT INTO archive_info (archive_key, latest_version_id, created_at, updated_at) VALUES (?, NULL, ?, ?)',
          [archiveKey, now, now],
        );
        info.push({ archive_key: archiveKey, latest_version_id: null, created_at: now, updated_at: now } as ArchiveStreamRow);
      }

      const prevLatestId: string | null = info[0].latest_version_id ?? null;
      const nextVersion = await this.nextVersion(conn, archiveKey);

      // 2. 插入新版本
      const id = randomUUID();
      const now = this.mysqlNow();
      await conn.query(
        `INSERT INTO archive_versions
         (id, archive_key, version, parent_id, is_latest, storage_path, size_bytes, sha256, metadata, status, created_at)
         VALUES (?, ?, ?, ?, TRUE, ?, ?, ?, CAST(? AS JSON), 'active', ?)`,
        [id, archiveKey, nextVersion, prevLatestId, input.storagePath, input.sizeBytes, input.sha256, JSON.stringify(input.metadata), now],
      );

      // 3. 更新 archive_info 的最新指针
      await conn.query(
        'UPDATE archive_info SET latest_version_id = ?, updated_at = ? WHERE archive_key = ?',
        [id, now, archiveKey],
      );

      // 4. 如果之前存在最新版本，取消它的 is_latest 标记
      if (prevLatestId) {
        await conn.query(
          'UPDATE archive_versions SET is_latest = FALSE WHERE id = ?',
          [prevLatestId],
        );
      }

      await conn.commit();
      return {
        id, archiveKey, version: nextVersion,
        parentId: prevLatestId, isLatest: true,
        storagePath: input.storagePath, sizeBytes: input.sizeBytes, sha256: input.sha256,
        metadata: input.metadata, status: 'active',
        createdAt: now, deletedAt: null,
      };
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }
  }

  /** 获取指定归档流的最新版本（通过 latest_version_id 关联，O(1)） */
  async getLatest(archiveKey: string): Promise<ArchiveVersion | undefined> {
    const [rows] = await this.pool.query<ArchiveVersionRow[]>(
      `SELECT v.* FROM archive_versions v
       JOIN archive_info i ON i.latest_version_id = v.id
       WHERE i.archive_key = ?`,
      [archiveKey],
    );
    return rows.length ? this.toVersion(rows[0]) : undefined;
  }

  /** 列表 — 支持分页、按状态筛选 */
  async listVersions(archiveKey: string, opts: ArchiveListOptions = {}): Promise<ArchiveVersion[]> {
    const { status = 'active', offset = 0, limit = 100 } = opts;
    const [rows] = await this.pool.query<ArchiveVersionRow[]>(
      `SELECT * FROM archive_versions
       WHERE archive_key = ? AND status = ?
       ORDER BY version DESC
       LIMIT ? OFFSET ?`,
      [archiveKey, status, limit, offset],
    );
    return rows.map(r => this.toVersion(r));
  }

  /** 获取所有归档流的 key 列表 */
  async listStreamKeys(): Promise<string[]> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      'SELECT archive_key FROM archive_info ORDER BY updated_at DESC',
    );
    return rows.map(r => String(r.archive_key));
  }

  /**
   * 保留最新的 N 个版本（事务）
   * @returns 被软删除的版本数
   */
  async retain(archiveKey: string, keepCount: number): Promise<number> {
    if (keepCount < 1) throw new Error('keepCount 必须 >= 1');

    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();

      // 加行锁
      const [info] = await conn.query<ArchiveStreamRow[]>(
        'SELECT archive_key FROM archive_info WHERE archive_key = ? FOR UPDATE',
        [archiveKey],
      );
      if (!info.length) { await conn.commit(); return 0; }

      // 找到保留的第 keepCount 个版本的 version 号
      // OFFSET = keepCount - 1：第 1 个是 is_latest，第 2 个是 OFFSET 1，以此类推
      const [rows] = await conn.query<ArchiveVersionRow[]>(
        `SELECT version FROM archive_versions
         WHERE archive_key = ? AND status = 'active'
         ORDER BY version DESC
         LIMIT 1 OFFSET ?`,
        [archiveKey, keepCount - 1],
      );

      if (!rows.length) {
        // 总版本数 <= keepCount，不需要清理
        await conn.commit();
        return 0;
      }

      const cutoffVersion = rows[0].version;
      const [result] = await conn.query<any>(
        `UPDATE archive_versions
         SET status = 'soft_deleted', deleted_at = NOW()
         WHERE archive_key = ? AND status = 'active' AND is_latest = FALSE
           AND version < ?`,
        [archiveKey, cutoffVersion],
      );

      await conn.commit();
      return result.affectedRows ?? 0;
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }
  }

  /** 查找所有已软删除的版本，返回其文件路径列表 */
  async listSoftDeleted(): Promise<Array<{ id: string; storagePath: string }>> {
    const [rows] = await this.pool.query<ArchiveVersionRow[]>(
      "SELECT id, storage_path FROM archive_versions WHERE status = 'soft_deleted'",
    );
    return rows.map(r => ({ id: r.id, storagePath: r.storage_path }));
  }

  /** 物理删除 soft_deleted 的版本记录 */
  async hardDelete(ids: string[]): Promise<void> {
    if (!ids.length) return;
    const placeholders = ids.map(() => '?').join(',');
    await this.pool.query(
      `DELETE FROM archive_versions WHERE id IN (${placeholders})`,
      ids,
    );
  }

  /** 关闭连接池 */
  async close(): Promise<void> {
    await this.pool.end();
  }

  /** 获取同一 key 下的下一个版本号 */
  private async nextVersion(conn: Pick<Pool, 'query'>, archiveKey: string): Promise<number> {
    const [rows] = await conn.query<ArchiveVersionRow[]>(
      'SELECT COALESCE(MAX(version), 0) + 1 AS version FROM archive_versions WHERE archive_key = ? FOR UPDATE',
      [archiveKey],
    );
    return rows[0]?.version ?? 1;
  }

  private toStream(row: ArchiveStreamRow): ArchiveStream {
    const created = row.created_at as unknown;
    const updated = row.updated_at as unknown;
    return {
      archiveKey: row.archive_key,
      latestVersionId: row.latest_version_id,
      createdAt: created instanceof Date ? created.toISOString() : String(created ?? ''),
      updatedAt: updated instanceof Date ? updated.toISOString() : String(updated ?? ''),
    };
  }

  private toVersion(row: ArchiveVersionRow): ArchiveVersion {
    const created = row.created_at as unknown;
    const deleted = row.deleted_at as unknown;
    const meta = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata;
    return {
      id: row.id,
      archiveKey: row.archive_key,
      version: row.version,
      parentId: row.parent_id,
      isLatest: Boolean(row.is_latest),
      storagePath: row.storage_path,
      sizeBytes: Number(row.size_bytes),
      sha256: row.sha256,
      metadata: meta,
      status: row.status as 'active' | 'soft_deleted',
      createdAt: created instanceof Date ? created.toISOString() : String(created ?? ''),
      deletedAt: deleted instanceof Date ? deleted.toISOString() : (deleted ? String(deleted) : null),
    };
  }

  private mysqlNow(): string {
    return new Date().toISOString().slice(0, 23).replace('T', ' ');
  }
}