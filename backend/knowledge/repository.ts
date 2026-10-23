import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import type { KnowledgeJob, KnowledgeSettings } from '../../protocol/knowledge-types.js';
import { HttpError } from '../../util/errors.js';

export interface StoredKnowledgeJob extends KnowledgeJob {
  target: string;
  inputHash: string;
  operationId: string;
  requestHash?: string;
  documents: string[];
}

export interface KnowledgeRepository {
  settings(): Promise<KnowledgeSettings | undefined>;
  saveSettings(settings: KnowledgeSettings, expectedRevision: number): Promise<boolean>;
  find(memoryId: string, target: string, inputHash: string): Promise<StoredKnowledgeJob | undefined>;
  get(id: string): Promise<StoredKnowledgeJob | undefined>;
  insert(job: StoredKnowledgeJob): Promise<void>;
  save(job: StoredKnowledgeJob): Promise<void>;
  pending(target: string): Promise<StoredKnowledgeJob[]>;
  recent(target: string): Promise<KnowledgeJob[]>;
  applied(sessionId: string, target: string): Promise<StoredKnowledgeJob | undefined>;
}

const parse = <T>(value: T | string): T => typeof value === 'string' ? JSON.parse(value) : value;
const iso = (value: unknown) => new Date(value as string | Date).toISOString();
const select = `SELECT j.*,m.project_name,m.session_title,m.session_id,m.source_updated_at
  FROM knowledge_sync_jobs j JOIN memory_records m ON m.id=j.memory_id`;

function fromRow(row: RowDataPacket): StoredKnowledgeJob {
  const documents = parse<string[]>(row.documents_json);
  return { id: row.id, memoryId: row.memory_id, projectName: row.project_name, sessionTitle: row.session_title,
    sessionId: row.session_id, sourceUpdatedAt: iso(row.source_updated_at), status: row.status,
    documentCount: documents.length, error: row.error ?? undefined, updatedAt: iso(row.updated_at),
    target: row.target, inputHash: row.input_hash, operationId: row.operation_id,
    requestHash: row.request_hash ?? undefined, documents };
}

export function knowledgeJob(job: StoredKnowledgeJob): KnowledgeJob {
  const { target, inputHash, operationId, requestHash, documents, ...view } = job;
  return view;
}

export class MySqlKnowledgeRepository implements KnowledgeRepository {
  constructor(private readonly pool: Pool) {}

  async init() {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS knowledge_settings (
      id TINYINT UNSIGNED PRIMARY KEY,revision BIGINT UNSIGNED NOT NULL,document JSON NOT NULL,CHECK(id=1)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    await this.pool.query(`CREATE TABLE IF NOT EXISTS knowledge_sync_jobs (
      id CHAR(36) PRIMARY KEY,memory_id CHAR(36) NOT NULL,target CHAR(64) NOT NULL,input_hash CHAR(64) NOT NULL,
      operation_id CHAR(36) NOT NULL,request_hash CHAR(64) NULL,documents_json JSON NOT NULL,
      status ENUM('queued','syncing','succeeded','failed') NOT NULL,error TEXT NULL,
      created_at DATETIME(3) NOT NULL,updated_at DATETIME(3) NOT NULL,
      UNIQUE KEY knowledge_source(memory_id,target,input_hash),INDEX knowledge_pending(target,status,created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  }

  async settings() {
    const [rows] = await this.pool.query<RowDataPacket[]>('SELECT revision,document FROM knowledge_settings WHERE id=1');
    if (!rows[0]) return undefined;
    return { ...parse<Omit<KnowledgeSettings, 'revision'>>(rows[0].document), revision: Number(rows[0].revision) };
  }

  async saveSettings(settings: KnowledgeSettings, expectedRevision: number) {
    const document = JSON.stringify({ enabled: settings.enabled, prompts: settings.prompts });
    if (!expectedRevision) {
      try {
        await this.pool.query('INSERT INTO knowledge_settings(id,revision,document) VALUES(1,?,CAST(? AS JSON))', [settings.revision, document]);
        return true;
      } catch (error) { if ((error as { code?: string }).code === 'ER_DUP_ENTRY') return false; throw error; }
    }
    const [result] = await this.pool.query<ResultSetHeader>('UPDATE knowledge_settings SET revision=?,document=CAST(? AS JSON) WHERE id=1 AND revision=?',
      [settings.revision, document, expectedRevision]);
    return result.affectedRows === 1;
  }

  private async rows(where: string, values: unknown[]) {
    const [rows] = await this.pool.query<RowDataPacket[]>(`${select} ${where}`, values);
    return rows.map(fromRow);
  }
  async get(id: string) { return (await this.rows('WHERE j.id=?', [id]))[0]; }
  async find(memoryId: string, target: string, inputHash: string) {
    return (await this.rows('WHERE j.memory_id=? AND j.target=? AND j.input_hash=?', [memoryId, target, inputHash]))[0];
  }
  pending(target: string) { return this.rows("WHERE j.target=? AND j.status IN ('queued','syncing') ORDER BY j.created_at,j.id", [target]); }
  async recent(target: string) {
    return (await this.rows('WHERE j.target=? ORDER BY j.created_at DESC,j.id DESC LIMIT 50', [target])).map(knowledgeJob);
  }
  async applied(sessionId: string, target: string) {
    return (await this.rows("WHERE m.session_id=? AND j.target=? AND j.status='succeeded' ORDER BY m.source_updated_at DESC,j.created_at DESC LIMIT 1", [sessionId, target]))[0];
  }
  async insert(job: StoredKnowledgeJob) {
    await this.pool.query(`INSERT INTO knowledge_sync_jobs
      (id,memory_id,target,input_hash,operation_id,documents_json,status,created_at,updated_at)
      VALUES(?,?,?,?,?,CAST(? AS JSON),'queued',?,?)`,
    [job.id, job.memoryId, job.target, job.inputHash, job.operationId, '[]', new Date(job.updatedAt), new Date(job.updatedAt)]);
  }
  async save(job: StoredKnowledgeJob) {
    const now = new Date(Math.max(Date.now(), Date.parse(job.updatedAt) + 1));
    const [result] = await this.pool.query<ResultSetHeader>(`UPDATE knowledge_sync_jobs SET status=?,error=?,
      request_hash=?,documents_json=CAST(? AS JSON),updated_at=? WHERE id=? AND updated_at=?`,
    [job.status, job.error ?? null, job.requestHash ?? null, JSON.stringify(job.documents), now, job.id, new Date(job.updatedAt)]);
    if (result.affectedRows !== 1) throw new HttpError(409, '同步任务已变化，请刷新后重试');
    job.updatedAt = now.toISOString();
  }
}
