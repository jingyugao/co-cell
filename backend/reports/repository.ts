import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import type { ReportKind, ReportSettings, ReportSource, ReportUsage, WorkReport } from '../../protocol/report-types.js';
import { HttpError } from '../../util/errors.js';
import { publicReport, type StoredWorkReport } from './types.js';

export interface ReportRepository {
  settings(): Promise<ReportSettings | undefined>;
  saveSettings(settings: ReportSettings, expectedRevision: number): Promise<boolean>;
  cursor(): Promise<string | undefined>;
  saveCursor(value: string, revision?: number): Promise<void>;
  list(offset: number, limit: number): Promise<{ reports: WorkReport[]; hasMore: boolean }>;
  get(id: string): Promise<StoredWorkReport | undefined>;
  find(kind: ReportKind, periodStart: string): Promise<StoredWorkReport | undefined>;
  pending(): Promise<StoredWorkReport[]>;
  insert(record: StoredWorkReport): Promise<StoredWorkReport>;
  save(record: StoredWorkReport): Promise<void>;
  summary(cacheKey: string): Promise<{ sessionId: string; usage: ReportUsage } | undefined>;
  saveSummary(cacheKey: string, value: { sessionId: string; usage: ReportUsage }): Promise<void>;
}

const parse = <T>(value: T | string): T => typeof value === 'string' ? JSON.parse(value) : value;
const iso = (value: unknown) => new Date(value as string | Date).toISOString();
const withoutSourceSummaries = (record: StoredWorkReport): StoredWorkReport => ({
  ...record,
  sources: record.sources.map(({ summary: _summary, ...source }: ReportSource) => source),
});

function fromRow(row: RowDataPacket): StoredWorkReport {
  const record = parse<StoredWorkReport>(row.document);
  return { ...record, status: row.status as WorkReport['status'], periodStart: String(row.period_start).slice(0, 10),
    createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
    sources: (record.sources ?? []).map(({ summary: _summary, ...source }) => source) };
}

const document = (record: StoredWorkReport) => JSON.stringify(withoutSourceSummaries(record));

/** Report metadata is stored in MySQL; report bodies and cached summaries stay in files. */
export class MySqlReportRepository implements ReportRepository {
  constructor(private readonly pool: Pool) {}

  async init() {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS work_report_settings (
      id TINYINT UNSIGNED PRIMARY KEY,revision BIGINT UNSIGNED NOT NULL,document JSON NOT NULL,
      scanned_at DATETIME(3) NOT NULL,CHECK(id=1)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    await this.pool.query(`CREATE TABLE IF NOT EXISTS work_reports (
      id CHAR(36) PRIMARY KEY,kind ENUM('daily','weekly','weekly-preview') NOT NULL,period_start DATE NOT NULL,
      document JSON NOT NULL,status ENUM('queued','collecting','summarizing','generating','ready','failed') NOT NULL,
      created_at DATETIME(3) NOT NULL,updated_at DATETIME(3) NOT NULL,
      UNIQUE KEY work_report_period(kind,period_start),INDEX work_report_pending(status,created_at),
      INDEX work_report_recent(period_start,kind)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
    await this.pool.query(`CREATE TABLE IF NOT EXISTS work_report_summaries (
      cache_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,document JSON NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  }

  async settings() {
    const [rows] = await this.pool.query<RowDataPacket[]>('SELECT revision,document FROM work_report_settings WHERE id=1');
    const row = rows[0];
    if (!row) return undefined;
    return { ...parse<Omit<ReportSettings, 'revision'>>(row.document), revision: Number(row.revision) };
  }

  async saveSettings(settings: ReportSettings, expectedRevision: number) {
    const encoded = JSON.stringify(settings);
    if (!expectedRevision) {
      try {
        const [result] = await this.pool.query<ResultSetHeader>(`INSERT INTO work_report_settings(id,revision,document,scanned_at)
          VALUES(1,?,CAST(? AS JSON),?)`, [settings.revision, encoded, new Date()]);
        return result.affectedRows === 1;
      } catch (error) {
        if ((error as { code?: string }).code === 'ER_DUP_ENTRY') return false;
        throw error;
      }
    }
    const [result] = await this.pool.query<ResultSetHeader>(`UPDATE work_report_settings SET revision=?,document=CAST(? AS JSON),scanned_at=?
      WHERE id=1 AND revision=?`, [settings.revision, encoded, new Date(), expectedRevision]);
    return result.affectedRows === 1;
  }

  async cursor() {
    const [rows] = await this.pool.query<RowDataPacket[]>('SELECT scanned_at FROM work_report_settings WHERE id=1');
    return rows[0] ? iso(rows[0].scanned_at) : undefined;
  }

  async saveCursor(value: string, revision?: number) {
    const cursor = new Date(value);
    if (!Number.isFinite(cursor.getTime())) throw new Error('无效的报告扫描游标');
    const [result] = await this.pool.query<ResultSetHeader>(`UPDATE work_report_settings SET scanned_at=? WHERE id=1${revision === undefined ? '' : ' AND revision=?'}`,
      revision === undefined ? [cursor] : [cursor, revision]);
    if (!result.affectedRows) {
      const [rows] = await this.pool.query<RowDataPacket[]>('SELECT id FROM work_report_settings WHERE id=1');
      if (!rows[0]) throw new Error('报告设置尚未初始化，无法保存扫描游标');
    }
  }

  async list(offset: number, limit: number) {
    const start = Math.max(0, Math.floor(offset));
    const count = Math.max(1, Math.min(100, Math.floor(limit)));
    const [rows] = await this.pool.query<RowDataPacket[]>(`SELECT id,kind,DATE_FORMAT(period_start,'%Y-%m-%d') AS period_start,
      document,status,created_at,updated_at FROM work_reports
      ORDER BY period_start DESC,kind LIMIT ? OFFSET ?`, [count + 1, start]);
    return { reports: rows.slice(0, count).map(row => publicReport(fromRow(row))), hasMore: rows.length > count };
  }

  private async one(where: string, values: unknown[]) {
    const [rows] = await this.pool.query<RowDataPacket[]>(`SELECT id,kind,DATE_FORMAT(period_start,'%Y-%m-%d') AS period_start,
      document,status,created_at,updated_at FROM work_reports WHERE ${where} LIMIT 1`, values);
    return rows[0] ? fromRow(rows[0]) : undefined;
  }

  get(id: string) { return this.one('id=?', [id]); }
  find(kind: ReportKind, periodStart: string) { return this.one('kind=? AND period_start=?', [kind, periodStart]); }

  async pending() {
    const [rows] = await this.pool.query<RowDataPacket[]>(`SELECT id,kind,DATE_FORMAT(period_start,'%Y-%m-%d') AS period_start,
      document,status,created_at,updated_at FROM work_reports WHERE status NOT IN ('ready','failed')
      OR JSON_UNQUOTE(JSON_EXTRACT(document,'$.scheduledAsOf')) IS NOT NULL
      ORDER BY created_at,id LIMIT 10`);
    return rows.map(fromRow);
  }

  async insert(record: StoredWorkReport) {
    const safe = withoutSourceSummaries(record);
    // A current-week snapshot must never occupy the complete weekly report's deduplication key.
    const kind = safe.kind === 'weekly' && safe.asOf ? 'weekly-preview' : safe.kind;
    await this.pool.query(`INSERT IGNORE INTO work_reports(id,kind,period_start,document,status,created_at,updated_at)
      VALUES(?,?,?,CAST(? AS JSON),?,?,?)`, [safe.id, kind, safe.periodStart, document(safe), safe.status,
      new Date(safe.createdAt), new Date(safe.updatedAt)]);
    const stored = await this.one('kind=? AND period_start=?', [kind, safe.periodStart]);
    if (!stored) throw new Error('报告记录插入后未能读取');
    return stored;
  }

  async save(record: StoredWorkReport) {
    const previous = record.updatedAt;
    const next = new Date(Math.max(Date.now(), Date.parse(previous) + 1));
    const safe = withoutSourceSummaries({ ...record, updatedAt: next.toISOString() });
    const [result] = await this.pool.query<ResultSetHeader>(`UPDATE work_reports SET status=?,document=CAST(? AS JSON),updated_at=?
      WHERE id=? AND updated_at=?`, [safe.status, document(safe), next, safe.id, new Date(previous)]);
    if (result.affectedRows !== 1) throw new HttpError(409, '报告任务状态已变化，请刷新后重试');
    record.updatedAt = next.toISOString();
    record.sources = safe.sources;
  }

  async summary(cacheKey: string) {
    const [rows] = await this.pool.query<RowDataPacket[]>('SELECT document FROM work_report_summaries WHERE cache_key=?', [cacheKey]);
    return rows[0] ? parse<{ sessionId: string; usage: ReportUsage }>(rows[0].document) : undefined;
  }

  async saveSummary(cacheKey: string, value: { sessionId: string; usage: ReportUsage }) {
    await this.pool.query(`INSERT INTO work_report_summaries(cache_key,document) VALUES(?,CAST(? AS JSON))
      ON DUPLICATE KEY UPDATE document=VALUES(document)`, [cacheKey, JSON.stringify(value)]);
  }
}
