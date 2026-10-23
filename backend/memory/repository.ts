import { randomUUID } from 'node:crypto';
import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import type { MemoryFile, MemoryList, MemoryRecord } from '../../protocol/memory-types.js';
import { HttpError } from '../../util/errors.js';

export interface StoredMemory extends MemoryRecord {
  sourceThreadId: string;
  sourceBoxId: string;
  volumeId?: string;
  volumePath?: string;
  exportOperationId?: string;
  exportId?: string;
  exportRequestedAt?: string;
  artifactId?: string;
  files: MemoryFile[];
}

export interface MemoryRepository {
  list(offset: number, limit: number): Promise<MemoryList>;
  get(id: string): Promise<StoredMemory | undefined>;
  pending(): Promise<StoredMemory[]>;
  latestReady(): Promise<StoredMemory[]>;
  enqueue(input: Pick<StoredMemory, 'projectId' | 'projectName' | 'sessionId' | 'sessionTitle' | 'sourceUpdatedAt' | 'sourceThreadId' | 'sourceBoxId'>): Promise<void>;
  save(record: StoredMemory): Promise<void>;
}

const iso = (value: unknown) => new Date(value as string | Date).toISOString();
const optional = (value: unknown) => value == null ? undefined : String(value);
const publicColumns = `id,project_id,project_name,session_id,session_title,first_message,source_updated_at,
  status,file_count,encrypted_count,error,cleaned_at,created_at,updated_at`;

function publicRow(row: RowDataPacket): MemoryRecord {
  return { id: row.id, projectId: row.project_id, projectName: row.project_name, sessionId: row.session_id,
    sessionTitle: row.session_title, firstMessage: row.first_message, sourceUpdatedAt: iso(row.source_updated_at),
    status: row.status, fileCount: Number(row.file_count), encryptedCount: Number(row.encrypted_count),
    error: optional(row.error), cleanedAt: row.cleaned_at == null ? undefined : iso(row.cleaned_at),
    createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) };
}

function fromRow(row: RowDataPacket): StoredMemory {
  return { ...publicRow(row), sourceThreadId: row.source_thread_id, sourceBoxId: row.source_box_id,
    volumeId: optional(row.volume_id), volumePath: optional(row.volume_path),
    exportOperationId: optional(row.export_operation_id), exportId: optional(row.export_id),
    exportRequestedAt: row.export_requested_at == null ? undefined : iso(row.export_requested_at),
    artifactId: optional(row.artifact_id),
    files: typeof row.files_json === 'string' ? JSON.parse(row.files_json) : row.files_json ?? [] };
}

export function memoryRecord(record: StoredMemory): MemoryRecord {
  const { sourceThreadId, sourceBoxId, volumeId, volumePath, exportOperationId, exportId, exportRequestedAt, artifactId, files, ...view } = record;
  return view;
}

/** One metadata row per source version; Markdown stays in the shared data directory. */
export class MySqlMemoryRepository implements MemoryRepository {
  constructor(private pool: Pool) {}

  async init() {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS memory_records (
      id CHAR(36) PRIMARY KEY,
      project_id CHAR(36) NOT NULL,project_name VARCHAR(100) NOT NULL,
      session_id CHAR(36) NOT NULL,session_title VARCHAR(255) NOT NULL,first_message TEXT NOT NULL,
      source_updated_at DATETIME(3) NOT NULL,source_thread_id VARCHAR(191) NOT NULL,source_box_id VARCHAR(200) NOT NULL,
      status ENUM('queued','exporting','cleaning','ready','failed','skipped') NOT NULL,
      file_count INT UNSIGNED NOT NULL DEFAULT 0,encrypted_count INT UNSIGNED NOT NULL DEFAULT 0,
      files_json JSON NULL,artifact_id CHAR(36) NULL,error TEXT NULL,cleaned_at DATETIME(3) NULL,
      volume_id VARCHAR(200) NULL,volume_path TEXT NULL,export_operation_id VARCHAR(100) NULL,
      export_id VARCHAR(100) NULL,export_requested_at DATETIME(3) NULL,
      created_at DATETIME(3) NOT NULL,updated_at DATETIME(3) NOT NULL,
      UNIQUE KEY memory_source(session_id,source_updated_at),
      INDEX memory_recent(source_updated_at,id),INDEX memory_pending(status,created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
  }

  async list(offset: number, limit: number): Promise<MemoryList> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT ${publicColumns} FROM memory_records ORDER BY source_updated_at DESC,id DESC LIMIT ? OFFSET ?`, [limit + 1, offset]);
    return { items: rows.slice(0, limit).map(publicRow), hasMore: rows.length > limit };
  }

  async get(id: string) {
    const [rows] = await this.pool.query<RowDataPacket[]>('SELECT * FROM memory_records WHERE id=?', [id]);
    return rows[0] ? fromRow(rows[0]) : undefined;
  }

  async pending() {
    const [rows] = await this.pool.query<RowDataPacket[]>(`SELECT * FROM memory_records
      WHERE status IN ('queued','exporting','cleaning') OR export_operation_id IS NOT NULL OR export_id IS NOT NULL
      ORDER BY created_at,id`);
    return rows.map(fromRow);
  }

  async latestReady() {
    const [rows] = await this.pool.query<RowDataPacket[]>(`SELECT m.* FROM memory_records m WHERE m.status='ready'
      AND NOT EXISTS (SELECT 1 FROM memory_records newer WHERE newer.session_id=m.session_id
        AND newer.status='ready' AND newer.source_updated_at>m.source_updated_at)
      ORDER BY m.source_updated_at,m.id`);
    return rows.map(fromRow);
  }

  async enqueue(input: Parameters<MemoryRepository['enqueue']>[0]) {
    const now = new Date();
    await this.pool.query(`INSERT INTO memory_records
      (id,project_id,project_name,session_id,session_title,first_message,source_updated_at,source_thread_id,source_box_id,status,created_at,updated_at)
      VALUES (?,?,?,?,?,'',?,?,?,'queued',?,?) ON DUPLICATE KEY UPDATE id=memory_records.id`,
    [randomUUID(), input.projectId, input.projectName, input.sessionId, input.sessionTitle,
      new Date(input.sourceUpdatedAt), input.sourceThreadId, input.sourceBoxId, now, now]);
  }

  async save(record: StoredMemory) {
    const previous = record.updatedAt;
    const next = new Date(Math.max(Date.now(), Date.parse(previous) + 1));
    const [result] = await this.pool.query<ResultSetHeader>(`UPDATE memory_records SET
      first_message=?,status=?,file_count=?,encrypted_count=?,files_json=?,artifact_id=?,error=?,cleaned_at=?,
      volume_id=?,volume_path=?,export_operation_id=?,export_id=?,export_requested_at=?,updated_at=?
      WHERE id=? AND updated_at=?`,
    [record.firstMessage, record.status, record.fileCount, record.encryptedCount, JSON.stringify(record.files), record.artifactId ?? null,
      record.error ?? null, record.cleanedAt ? new Date(record.cleanedAt) : null, record.volumeId ?? null,
      record.volumePath ?? null, record.exportOperationId ?? null, record.exportId ?? null,
      record.exportRequestedAt ? new Date(record.exportRequestedAt) : null, next, record.id, new Date(previous)]);
    if (result.affectedRows !== 1) throw new HttpError(409, '清洗任务状态已变化，请刷新后重试');
    record.updatedAt = next.toISOString();
  }
}
