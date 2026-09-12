import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { IMPROVEMENT_STATUSES, type ImprovementContext, type ImprovementInput, type ImprovementPage, type ImprovementProposal, type ImprovementReceipt, type ImprovementStatus, type ImprovementStatusChange } from '../../protocol/improvement-types.js';
import { HttpError } from '../../util/errors.js';

export const improvementSchema = z.object({
  category: z.string().trim().min(1).max(120),
  title: z.string().trim().min(1).max(200),
  observation: z.string().trim().min(1).max(8000),
  proposal: z.string().trim().min(1).max(16000),
  expected_benefit: z.string().trim().min(1).max(4000),
}).strict();
export const improvementStatusSchema = z.object({
  status: z.enum(IMPROVEMENT_STATUSES),
  expectedStatus: z.enum(IMPROVEMENT_STATUSES),
  note: z.string().trim().max(2000).optional(),
}).strict();
export interface ImprovementFilter { q?: string; category?: string; projectId?: string; status?: ImprovementStatus; limit?: number; offset?: number }
const columns = `id, category, title, observation, proposal, expected_benefit, created_at AS createdAt,
  project_id AS projectId, project_name AS projectName, session_id AS sessionId,
  session_title AS sessionTitle, turn_id AS turnId, sandbox_id AS sandboxId, status,
  updated_at AS updatedAt, status_note AS statusNote`;
const tableDefinition = `(
  id TEXT PRIMARY KEY, request_key TEXT NOT NULL UNIQUE,
  scope TEXT NOT NULL, payload_hash TEXT NOT NULL,
  category TEXT NOT NULL, title TEXT NOT NULL, observation TEXT NOT NULL,
  proposal TEXT NOT NULL, expected_benefit TEXT NOT NULL,
  project_id TEXT, project_name TEXT, session_id TEXT NOT NULL,
  session_title TEXT NOT NULL, turn_id TEXT NOT NULL, sandbox_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'deferred', 'completed')),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, status_note TEXT,
  UNIQUE(scope, payload_hash)
)`;
const allowedTransitions: Record<ImprovementStatus, readonly ImprovementStatus[]> = {
  pending: ['deferred', 'completed'], deferred: ['pending', 'completed'], completed: ['pending'],
};

/** Stores proposals on the host; tools cannot supply or modify source attribution. */
export class ImprovementStore {
  private db: DatabaseSync;
  constructor(public readonly path = fileURLToPath(new URL('../../data/improvements.sqlite', import.meta.url))) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec(`CREATE TABLE IF NOT EXISTS improvement_proposals ${tableDefinition}`);
      const tableColumns = this.db.prepare('PRAGMA table_info(improvement_proposals)').all();
      if (!tableColumns.some(column => column.name === 'updated_at')) {
        // SQLite cannot alter a CHECK constraint. Copy all existing fields and deduplication
        // keys before replacing the table; the transaction makes the migration atomic.
        this.db.exec(`CREATE TABLE improvement_proposals_migrating ${tableDefinition};
          INSERT INTO improvement_proposals_migrating
            (id, request_key, scope, payload_hash, category, title, observation, proposal,
             expected_benefit, project_id, project_name, session_id, session_title, turn_id,
             sandbox_id, status, created_at, updated_at, status_note)
          SELECT id, request_key, scope, payload_hash, category, title, observation, proposal,
             expected_benefit, project_id, project_name, session_id, session_title, turn_id,
             sandbox_id, status, created_at, created_at, NULL FROM improvement_proposals;
          DROP TABLE improvement_proposals;
          ALTER TABLE improvement_proposals_migrating RENAME TO improvement_proposals;`);
      }
      this.db.exec(`CREATE INDEX IF NOT EXISTS improvement_created ON improvement_proposals(created_at DESC, id);
        CREATE INDEX IF NOT EXISTS improvement_project ON improvement_proposals(project_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS improvement_category ON improvement_proposals(category, created_at DESC);
        CREATE INDEX IF NOT EXISTS improvement_status ON improvement_proposals(status, created_at DESC, id);
        CREATE TABLE IF NOT EXISTS improvement_status_history (
          id TEXT PRIMARY KEY, proposal_id TEXT NOT NULL REFERENCES improvement_proposals(id),
          from_status TEXT NOT NULL CHECK(from_status IN ('pending', 'deferred', 'completed')),
          to_status TEXT NOT NULL CHECK(to_status IN ('pending', 'deferred', 'completed')),
          note TEXT, created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS improvement_history_proposal ON improvement_status_history(proposal_id);
        COMMIT;`);
    } catch (error) {
      this.db.exec('ROLLBACK');
      this.db.close();
      throw error;
    }
  }

  submit(context: ImprovementContext, raw: unknown, requestId: string): ImprovementReceipt {
    const parsed = improvementSchema.safeParse(raw);
    if (!parsed.success) throw new HttpError(400, parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; '));
    const input: ImprovementInput = parsed.data;
    if (!/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(requestId)) throw new HttpError(400, '建议提交标识无效');
    const hash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    const scope = context.projectId ? `project:${context.projectId}` : `session:${context.sessionId}`;
    const requestKey = JSON.stringify([context.sessionId, context.turnId, requestId]);
    const old = this.db.prepare('SELECT id, payload_hash FROM improvement_proposals WHERE request_key = ?').get(requestKey);
    if (old && old.payload_hash !== hash) throw new HttpError(409, '同一提交标识不能用于不同的建议');
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO improvement_proposals
      (id, request_key, scope, payload_hash, category, title, observation, proposal, expected_benefit,
       project_id, project_name, session_id, session_title, turn_id, sandbox_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`)
      .run(id, requestKey, scope, hash, input.category, input.title, input.observation, input.proposal, input.expected_benefit,
        context.projectId, context.projectName, context.sessionId, context.sessionTitle, context.turnId, context.sandboxId, now, now);
    const saved = this.db.prepare('SELECT id, payload_hash, status FROM improvement_proposals WHERE request_key = ? OR (scope = ? AND payload_hash = ?) ORDER BY request_key = ? DESC LIMIT 1')
      .get(requestKey, scope, hash, requestKey);
    if (!saved || saved.payload_hash !== hash) throw new HttpError(409, '建议提交冲突，请使用新的提交标识');
    return { id: saved.id as string, status: saved.status as ImprovementStatus, duplicate: saved.id !== id };
  }

  get(id: string): ImprovementProposal {
    const result = this.db.prepare(`SELECT ${columns} FROM improvement_proposals WHERE id = ?`).get(id);
    if (!result) throw new HttpError(404, '建议不存在');
    const statusHistory = this.db.prepare(`SELECT id, from_status AS fromStatus, to_status AS toStatus,
      note, created_at AS createdAt FROM improvement_status_history WHERE proposal_id = ? ORDER BY rowid`).all(id) as unknown as ImprovementStatusChange[];
    return { ...result, statusHistory } as unknown as ImprovementProposal;
  }

  updateStatus(id: string, raw: z.input<typeof improvementStatusSchema>): ImprovementProposal {
    const input = improvementStatusSchema.parse(raw);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.get(id);
      if (current.status !== input.expectedStatus) throw new HttpError(409, '建议状态已更新，请刷新后重试');
      if (current.status !== input.status) {
        if (!allowedTransitions[current.status].includes(input.status)) throw new HttpError(409, '不支持此状态转换，请先重新打开建议');
        const now = new Date().toISOString();
        const note = input.note || null;
        this.db.prepare('UPDATE improvement_proposals SET status = ?, updated_at = ?, status_note = ? WHERE id = ?')
          .run(input.status, now, note, id);
        this.db.prepare(`INSERT INTO improvement_status_history
          (id, proposal_id, from_status, to_status, note, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
          .run(randomUUID(), id, current.status, input.status, note, now);
      }
      const result = this.get(id);
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  list(filter: ImprovementFilter = {}): ImprovementPage {
    const conditions: string[] = [], values: string[] = [];
    if (filter.category) { conditions.push('category = ?'); values.push(filter.category); }
    if (filter.projectId) { conditions.push('project_id = ?'); values.push(filter.projectId); }
    if (filter.status) { conditions.push('status = ?'); values.push(filter.status); }
    if (filter.q) {
      conditions.push("(title || ' ' || category || ' ' || observation || ' ' || proposal || ' ' || expected_benefit || ' ' || coalesce(project_name, '')) LIKE ? ESCAPE '\\'");
      values.push(`%${filter.q.replace(/[\\%_]/g, value => '\\' + value)}%`);
    }
    const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
    const total = Number(this.db.prepare(`SELECT count(*) AS total FROM improvement_proposals${where}`).get(...values)!.total);
    const items = this.db.prepare(`SELECT ${columns} FROM improvement_proposals${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`)
      .all(...values, filter.limit ?? 30, filter.offset ?? 0) as unknown as ImprovementProposal[];
    const categories = this.db.prepare('SELECT DISTINCT category FROM improvement_proposals ORDER BY category').all().map(row => row.category as string);
    const projects = this.db.prepare('SELECT project_id AS id, max(project_name) AS name FROM improvement_proposals WHERE project_id IS NOT NULL GROUP BY project_id ORDER BY name').all() as unknown as Array<{ id: string; name: string }>;
    return { items, total, categories, projects };
  }
  close() { this.db.close(); }
}
