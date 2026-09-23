import { randomUUID } from 'node:crypto';
import { createPool, type Pool, type RowDataPacket, type ResultSetHeader } from 'mysql2/promise';
import type { ArchiveStream, ArchiveVersion, FileArchiveVersion, SnapshotArchiveVersion, CreateArchiveVersionInput, CreateResticVersionInput, ArchiveListOptions } from './types.js';
import { ARCHIVE_FORMAT } from './formats.js';

interface ArchiveVersionRow extends RowDataPacket {
  id: string;
  archive_key: string;
  version: number;
  parent_id: string | null;
  is_latest: number;
  format: string;
  storage_path: string | null;
  size_bytes: number | string | null;
  sha256: string | null;
  repository_id: string | null;
  snapshot_id: string | null;
  logical_size_bytes: number | string | null;
  bytes_added: number | string | null;
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

/** Archive persistence, including version transactions and schema upgrades. */
export class ArchiveDao {
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
        format VARCHAR(32) NOT NULL DEFAULT '${ARCHIVE_FORMAT.file}',
        storage_path VARCHAR(255) NULL,
        size_bytes BIGINT UNSIGNED NULL,
        sha256 CHAR(64) NULL,
        repository_id VARCHAR(255) NULL,
        snapshot_id CHAR(64) NULL,
        logical_size_bytes BIGINT UNSIGNED NULL,
        bytes_added BIGINT UNSIGNED NULL,
        metadata JSON NOT NULL,
        status ENUM('pending','active','failed','soft_deleted') NOT NULL DEFAULT 'active',
        created_at DATETIME(3) NOT NULL,
        deleted_at DATETIME(3) NULL,
        INDEX idx_versions_key_ver (archive_key, version DESC),
        INDEX idx_versions_key_latest (archive_key, is_latest)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);
    // Upgrade databases created by the earlier tar-only schema. Defaults label
    // every existing row as a file archive; no records or files are changed.
    await this.ensureVersionFormatColumns();
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

  /** Reserve a version without changing the stream's visible latest version. */
  async beginPendingVersion(id: string, archiveKey: string, format: ArchiveVersion['format'],
    storagePath: string | null, metadata: Record<string, unknown>): Promise<string> {
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query('INSERT IGNORE INTO archive_info (archive_key, latest_version_id, created_at, updated_at) VALUES (?, NULL, NOW(3), NOW(3))', [archiveKey]);
      const [streams] = await conn.query<ArchiveStreamRow[]>(
        'SELECT latest_version_id FROM archive_info WHERE archive_key = ? FOR UPDATE', [archiveKey]);
      const [pending] = await conn.query<ArchiveVersionRow[]>(
        "SELECT id FROM archive_versions WHERE archive_key = ? AND status = 'pending' LIMIT 1", [archiveKey]);
      if (pending.length) throw new Error('An archive backup is already pending');
      await conn.query(
        `INSERT INTO archive_versions (id, archive_key, version, parent_id, is_latest, format, storage_path,
          repository_id, metadata, status, created_at)
         VALUES (?, ?, ?, ?, FALSE, ?, ?, ?, CAST(? AS JSON), 'pending', NOW(3))`,
        [id, archiveKey, await this.nextVersion(conn, archiveKey), streams[0]?.latest_version_id ?? null,
          format, storagePath, format === ARCHIVE_FORMAT.snapshot ? archiveKey : null, JSON.stringify(metadata)]);
      await conn.commit();
      return id;
    } catch (error) { await conn.rollback(); throw error; }
    finally { conn.release(); }
  }

  async getPendingVersion(id: string): Promise<{ id: string; archiveKey: string;
    format: ArchiveVersion['format']; storagePath: string | null; repositoryId: string | null } | undefined> {
    const [rows] = await this.pool.query<ArchiveVersionRow[]>(
      "SELECT id, archive_key, format, storage_path, repository_id FROM archive_versions WHERE id = ? AND status = 'pending'", [id]);
    const row = rows[0];
    return row ? { id: row.id, archiveKey: row.archive_key, format: row.format as ArchiveVersion['format'],
      storagePath: row.storage_path, repositoryId: row.repository_id } : undefined;
  }

  async listPendingVersions(): Promise<Array<{ id: string; archiveKey: string; format: ArchiveVersion['format'] }>> {
    const [rows] = await this.pool.query<ArchiveVersionRow[]>(
      "SELECT id, archive_key, format FROM archive_versions WHERE status = 'pending' ORDER BY created_at");
    return rows.map(row => ({ id: row.id, archiveKey: row.archive_key,
      format: row.format as ArchiveVersion['format'] }));
  }

  async finishPendingVersion(id: string, artifact: { format: typeof ARCHIVE_FORMAT.file; sizeBytes: number; sha256: string }
    | { format: typeof ARCHIVE_FORMAT.snapshot; snapshotId: string; logicalSizeBytes: number; bytesAdded: number }): Promise<ArchiveVersion> {
    const pending = await this.getPendingVersion(id);
    if (!pending || pending.format !== artifact.format) throw new Error('Pending archive version not found');
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const [streams] = await conn.query<ArchiveStreamRow[]>(
        'SELECT latest_version_id FROM archive_info WHERE archive_key = ? FOR UPDATE', [pending.archiveKey]);
      const [rows] = await conn.query<ArchiveVersionRow[]>(
        'SELECT parent_id, status, format FROM archive_versions WHERE id = ? FOR UPDATE', [id]);
      const row = rows[0];
      if (!row || row.status !== 'pending' || row.format !== artifact.format
        || row.parent_id !== (streams[0]?.latest_version_id ?? null)) {
        throw new Error('Pending archive version changed before completion');
      }
      const fields = artifact.format === ARCHIVE_FORMAT.file
        ? { sql: 'size_bytes = ?, sha256 = ?', values: [artifact.sizeBytes, artifact.sha256] }
        : { sql: 'snapshot_id = ?, logical_size_bytes = ?, bytes_added = ?',
            values: [artifact.snapshotId, artifact.logicalSizeBytes, artifact.bytesAdded] };
      const [updated] = await conn.query<ResultSetHeader>(
        `UPDATE archive_versions SET ${fields.sql}, status = 'active', is_latest = TRUE WHERE id = ? AND status = 'pending'`,
        [...fields.values, id]);
      if (updated.affectedRows !== 1) throw new Error('Pending archive version changed before completion');
      if (streams[0]?.latest_version_id) await conn.query(
        'UPDATE archive_versions SET is_latest = FALSE WHERE id = ?', [streams[0].latest_version_id]);
      await conn.query('UPDATE archive_info SET latest_version_id = ?, updated_at = NOW(3) WHERE archive_key = ?',
        [id, pending.archiveKey]);
      await conn.commit();
    } catch (error) { await conn.rollback(); throw error; }
    finally { conn.release(); }
    const version = await this.getVersion(pending.archiveKey, id);
    if (!version) throw new Error('Completed archive version is missing');
    return version;
  }

  async failPendingVersion(id: string): Promise<void> {
    await this.pool.query("UPDATE archive_versions SET status = 'failed' WHERE id = ? AND status = 'pending'", [id]);
  }

  /** Insert a file-backed version after its archive file has been created. */
  async insertFileVersion(
    archiveKey: string,
    input: CreateArchiveVersionInput,
  ): Promise<FileArchiveVersion> {
    return this.insertVersion(archiveKey, { ...input, format: ARCHIVE_FORMAT.file });
  }

  /** Register a verified snapshot as a version. */
  async insertSnapshotVersion(
    archiveKey: string,
    input: CreateResticVersionInput,
  ): Promise<SnapshotArchiveVersion> {
    return this.insertVersion(archiveKey, { ...input, format: ARCHIVE_FORMAT.snapshot });
  }

  private async insertVersion(archiveKey: string, input: CreateArchiveVersionInput & { format: typeof ARCHIVE_FORMAT.file }): Promise<FileArchiveVersion>;
  private async insertVersion(archiveKey: string, input: CreateResticVersionInput & { format: typeof ARCHIVE_FORMAT.snapshot }): Promise<SnapshotArchiveVersion>;
  private async insertVersion(
    archiveKey: string,
    input: (CreateArchiveVersionInput & { format: typeof ARCHIVE_FORMAT.file })
      | (CreateResticVersionInput & { format: typeof ARCHIVE_FORMAT.snapshot }),
  ): Promise<ArchiveVersion> {
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const [info] = await conn.query<ArchiveStreamRow[]>(
        'SELECT archive_key, latest_version_id FROM archive_info WHERE archive_key = ? FOR UPDATE',
        [archiveKey],
      );
      if (!info.length) {
        const now = this.mysqlNow();
        await conn.query(
          'INSERT INTO archive_info (archive_key, latest_version_id, created_at, updated_at) VALUES (?, NULL, ?, ?)',
          [archiveKey, now, now],
        );
        info.push({ archive_key: archiveKey, latest_version_id: null, created_at: now, updated_at: now } as ArchiveStreamRow);
      }

      const prevLatestId = info[0].latest_version_id ?? null;
      const nextVersion = await this.nextVersion(conn, archiveKey);
      const id = input.format === ARCHIVE_FORMAT.file ? input.id : randomUUID();
      const now = this.mysqlNow();
      const file = input.format === ARCHIVE_FORMAT.file ? input : null;
      const snapshot = input.format === ARCHIVE_FORMAT.snapshot ? input : null;
      await conn.query(
        `INSERT INTO archive_versions
         (id, archive_key, version, parent_id, is_latest, format, storage_path, size_bytes, sha256,
          repository_id, snapshot_id, logical_size_bytes, bytes_added, metadata, status, created_at)
         VALUES (?, ?, ?, ?, TRUE, ?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS JSON), 'active', ?)`,
        [id, archiveKey, nextVersion, prevLatestId, input.format, file?.storagePath ?? null,
          file?.sizeBytes ?? null, file?.sha256 ?? null, snapshot?.repositoryId ?? null,
          snapshot?.snapshotId ?? null, snapshot?.logicalSizeBytes ?? null, snapshot?.bytesAdded ?? null,
          JSON.stringify(input.metadata), now],
      );
      await conn.query(
        'UPDATE archive_info SET latest_version_id = ?, updated_at = ? WHERE archive_key = ?',
        [id, now, archiveKey],
      );
      if (prevLatestId) {
        await conn.query('UPDATE archive_versions SET is_latest = FALSE WHERE id = ?', [prevLatestId]);
      }
      await conn.commit();
      const common = { id, archiveKey, version: nextVersion, parentId: prevLatestId, isLatest: true,
        metadata: input.metadata, status: 'active' as const, createdAt: now, deletedAt: null };
      if (input.format === ARCHIVE_FORMAT.file) {
        return { ...common, format: input.format, storagePath: input.storagePath, sizeBytes: input.sizeBytes,
          sha256: input.sha256, repositoryId: null, snapshotId: null, logicalSizeBytes: null, bytesAdded: null };
      }
      return { ...common, format: input.format, storagePath: null, sizeBytes: null, sha256: null,
        repositoryId: input.repositoryId, snapshotId: input.snapshotId,
        logicalSizeBytes: input.logicalSizeBytes, bytesAdded: input.bytesAdded };
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }
  }

  /** Undo an uncommitted migration cutover while retaining its snapshot row for repair/sweep. */
  async revertVersion(archiveKey: string, versionId: string): Promise<boolean> {
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const [streams] = await conn.query<ArchiveStreamRow[]>(
        'SELECT latest_version_id FROM archive_info WHERE archive_key = ? FOR UPDATE', [archiveKey],
      );
      const latestId = streams[0]?.latest_version_id;
      if (!latestId) { await conn.rollback(); return false; }
      const [rows] = await conn.query<ArchiveVersionRow[]>(
        'SELECT id, parent_id, format, snapshot_id FROM archive_versions WHERE id = ? FOR UPDATE', [latestId],
      );
      const latest = rows[0];
      if (!latest || latest.id !== versionId || latest.format !== ARCHIVE_FORMAT.snapshot || !latest.parent_id) {
        await conn.rollback(); return false;
      }
      await conn.query('UPDATE archive_info SET latest_version_id = ?, updated_at = ? WHERE archive_key = ?',
        [latest.parent_id, this.mysqlNow(), archiveKey]);
      await conn.query("UPDATE archive_versions SET is_latest = FALSE, status = 'soft_deleted', deleted_at = NOW() WHERE id = ?", [latest.id]);
      await conn.query('UPDATE archive_versions SET is_latest = TRUE WHERE id = ?', [latest.parent_id]);
      await conn.commit();
      return true;
    } catch (error) { await conn.rollback(); throw error; }
    finally { conn.release(); }
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

  async getVersion(archiveKey: string, id: string): Promise<ArchiveVersion | undefined> {
    const [rows] = await this.pool.query<ArchiveVersionRow[]>(
      "SELECT * FROM archive_versions WHERE archive_key = ? AND id = ? AND status = 'active'",
      [archiveKey, id],
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

  /** Apply automatic retention only to Restic snapshots; historical tar versions stay intact. */
  async retainRestic(archiveKey: string, keepCount: number): Promise<number> {
    if (!Number.isInteger(keepCount) || keepCount < 2) throw new Error('Restic keepCount must be at least 2');
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const [info] = await conn.query<ArchiveStreamRow[]>(
        'SELECT archive_key FROM archive_info WHERE archive_key = ? FOR UPDATE', [archiveKey],
      );
      if (!info.length) { await conn.commit(); return 0; }
      const [rows] = await conn.query<ArchiveVersionRow[]>(
        `SELECT version FROM archive_versions WHERE archive_key = ? AND format = ? AND status = 'active'
         ORDER BY version DESC LIMIT 1 OFFSET ?`, [archiveKey, ARCHIVE_FORMAT.snapshot, keepCount - 1],
      );
      if (!rows.length) { await conn.commit(); return 0; }
      const [result] = await conn.query<any>(
        `UPDATE archive_versions SET status = 'soft_deleted', deleted_at = NOW()
         WHERE archive_key = ? AND format = ? AND status = 'active'
           AND is_latest = FALSE AND version < ?`, [archiveKey, ARCHIVE_FORMAT.snapshot, rows[0].version],
      );
      await conn.commit();
      return result.affectedRows ?? 0;
    } catch (error) {
      await conn.rollback();
      throw error;
    } finally { conn.release(); }
  }

  /** 查找所有已软删除的版本，返回其文件路径列表 */
  async listSoftDeleted(): Promise<Array<{ id: string; storeId: string }>> {
    const [rows] = await this.pool.query<ArchiveVersionRow[]>(
      `SELECT v.id, v.archive_key FROM archive_versions v
       LEFT JOIN archive_info i ON i.latest_version_id = v.id
       WHERE v.status = 'soft_deleted' AND v.format = ? AND i.latest_version_id IS NULL`, [ARCHIVE_FORMAT.file],
    );
    return rows.map(row => ({ id: row.id, storeId: row.archive_key }));
  }

  async listSoftDeletedRestic(): Promise<Array<{ id: string; repositoryId: string; snapshotId: string }>> {
    const [rows] = await this.pool.query<ArchiveVersionRow[]>(
      "SELECT id, repository_id, snapshot_id FROM archive_versions WHERE status = 'soft_deleted' AND format = ?",
      [ARCHIVE_FORMAT.snapshot],
    );
    return rows.flatMap(row => row.repository_id && row.snapshot_id
      ? [{ id: row.id, repositoryId: row.repository_id, snapshotId: row.snapshot_id }] : []);
  }

  async isSnapshotReferenced(repositoryId: string, snapshotId: string): Promise<boolean> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT v.id FROM archive_versions v
       LEFT JOIN archive_info i ON i.latest_version_id = v.id
       WHERE v.repository_id = ? AND v.snapshot_id = ? AND (v.status = 'active' OR i.latest_version_id IS NOT NULL)
       LIMIT 1`, [repositoryId, snapshotId],
    );
    return rows.length > 0;
  }

  async listResticReferences(): Promise<Array<{ repositoryId: string; snapshotId: string }>> {
    const [rows] = await this.pool.query<ArchiveVersionRow[]>(
      'SELECT repository_id, snapshot_id FROM archive_versions WHERE format = ?', [ARCHIVE_FORMAT.snapshot],
    );
    return rows.flatMap(row => row.repository_id && row.snapshot_id
      ? [{ repositoryId: row.repository_id, snapshotId: row.snapshot_id }] : []);
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
      'SELECT COALESCE(MAX(version), 0) + 1 AS version FROM archive_versions WHERE archive_key = ?',
      [archiveKey],
    );
    return rows[0]?.version ?? 1;
  }

  /** Idempotently migrate pre-format archive_versions tables. */
  private async ensureVersionFormatColumns(): Promise<void> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT COLUMN_NAME, IS_NULLABLE FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'archive_versions'`,
    );
    const columns = new Set(rows.map(row => String(row.COLUMN_NAME)));
    const additions: Array<[string, string]> = [
      ['format', `VARCHAR(32) NOT NULL DEFAULT '${ARCHIVE_FORMAT.file}' AFTER is_latest`],
      ['repository_id', 'VARCHAR(255) NULL AFTER sha256'],
      ['snapshot_id', 'CHAR(64) NULL AFTER repository_id'],
      ['logical_size_bytes', 'BIGINT UNSIGNED NULL AFTER snapshot_id'],
      ['bytes_added', 'BIGINT UNSIGNED NULL AFTER logical_size_bytes'],
    ];
    for (const [name, definition] of additions) {
      if (!columns.has(name)) {
        await this.pool.query(`ALTER TABLE archive_versions ADD COLUMN ${name} ${definition}`);
      }
    }
    // Restic rows deliberately have no tar path, whole-archive size or hash.
    if (rows.some(row => ['storage_path', 'size_bytes', 'sha256'].includes(String(row.COLUMN_NAME)) && row.IS_NULLABLE === 'NO')) {
      await this.pool.query(`
        ALTER TABLE archive_versions
          MODIFY storage_path VARCHAR(255) NULL,
          MODIFY size_bytes BIGINT UNSIGNED NULL,
          MODIFY sha256 CHAR(64) NULL
      `);
    }
    const [statusRows] = await this.pool.query<RowDataPacket[]>(
      `SELECT COLUMN_TYPE FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'archive_versions' AND COLUMN_NAME = 'status'`);
    if (statusRows.length && !String(statusRows[0].COLUMN_TYPE).includes("'pending'")) {
      await this.pool.query("ALTER TABLE archive_versions MODIFY status ENUM('pending','active','failed','soft_deleted') NOT NULL DEFAULT 'active'");
    }
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
    const common = {
      id: row.id,
      archiveKey: row.archive_key,
      version: row.version,
      parentId: row.parent_id,
      isLatest: Boolean(row.is_latest),
      metadata: meta,
      status: row.status as 'active' | 'soft_deleted',
      createdAt: created instanceof Date ? created.toISOString() : String(created ?? ''),
      deletedAt: deleted instanceof Date ? deleted.toISOString() : (deleted ? String(deleted) : null),
    };
    if (row.format === ARCHIVE_FORMAT.file) {
      if (!row.storage_path || row.size_bytes == null || !row.sha256) throw new Error(`Incomplete tar archive version ${row.id}`);
      return { ...common, format: ARCHIVE_FORMAT.file, storagePath: row.storage_path,
        sizeBytes: Number(row.size_bytes), sha256: row.sha256,
        repositoryId: null, snapshotId: null, logicalSizeBytes: null, bytesAdded: null };
    }
    if (row.format === ARCHIVE_FORMAT.snapshot) {
      if (!row.repository_id || !row.snapshot_id || row.logical_size_bytes == null || row.bytes_added == null) {
        throw new Error(`Incomplete Restic archive version ${row.id}`);
      }
      return { ...common, format: ARCHIVE_FORMAT.snapshot, storagePath: null, sizeBytes: null, sha256: null,
        repositoryId: row.repository_id, snapshotId: row.snapshot_id,
        logicalSizeBytes: Number(row.logical_size_bytes), bytesAdded: Number(row.bytes_added) };
    }
    throw new Error(`Unsupported archive format ${row.format} for version ${row.id}`);
  }

  private mysqlNow(): string {
    return new Date().toISOString().slice(0, 23).replace('T', ' ');
  }
}
