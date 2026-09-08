import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import type { ImprovementContext, ImprovementInput, ImprovementPage, ImprovementProposal, ImprovementReceipt } from '../../shared/improvement-types.js';
import { HttpError } from '../core/errors.js';

export const improvementSchema = z.object({
  category: z.string().trim().min(1).max(120),
  title: z.string().trim().min(1).max(200),
  observation: z.string().trim().min(1).max(8000),
  proposal: z.string().trim().min(1).max(16000),
  expected_benefit: z.string().trim().min(1).max(4000),
}).strict();
export interface ImprovementFilter { q?: string; category?: string; projectId?: string; limit?: number; offset?: number }
const columns = `id, category, title, observation, proposal, expected_benefit, created_at AS createdAt,
  project_id AS projectId, project_name AS projectName, session_id AS sessionId,
  session_title AS sessionTitle, turn_id AS turnId, sandbox_id AS sandboxId, status`;

/** Stores proposals on the host; tools cannot supply or modify source attribution. */
export class ImprovementStore {
  private db: DatabaseSync;
  constructor(public readonly path = fileURLToPath(new URL('../../data/improvements.sqlite', import.meta.url))) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec(`PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS improvement_proposals (
        id TEXT PRIMARY KEY, request_key TEXT NOT NULL UNIQUE,
        scope TEXT NOT NULL, payload_hash TEXT NOT NULL,
        category TEXT NOT NULL, title TEXT NOT NULL, observation TEXT NOT NULL,
        proposal TEXT NOT NULL, expected_benefit TEXT NOT NULL,
        project_id TEXT, project_name TEXT, session_id TEXT NOT NULL,
        session_title TEXT NOT NULL, turn_id TEXT NOT NULL, sandbox_id TEXT,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status = 'pending'),
        created_at TEXT NOT NULL, UNIQUE(scope, payload_hash)
      );
      CREATE INDEX IF NOT EXISTS improvement_created ON improvement_proposals(created_at DESC, id);
      CREATE INDEX IF NOT EXISTS improvement_project ON improvement_proposals(project_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS improvement_category ON improvement_proposals(category, created_at DESC);`);
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
    this.db.prepare(`INSERT INTO improvement_proposals
      (id, request_key, scope, payload_hash, category, title, observation, proposal, expected_benefit,
       project_id, project_name, session_id, session_title, turn_id, sandbox_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`)
      .run(id, requestKey, scope, hash, input.category, input.title, input.observation, input.proposal, input.expected_benefit,
        context.projectId, context.projectName, context.sessionId, context.sessionTitle, context.turnId, context.sandboxId, new Date().toISOString());
    const saved = this.db.prepare('SELECT id, payload_hash FROM improvement_proposals WHERE request_key = ? OR (scope = ? AND payload_hash = ?) ORDER BY request_key = ? DESC LIMIT 1')
      .get(requestKey, scope, hash, requestKey);
    if (!saved || saved.payload_hash !== hash) throw new HttpError(409, '建议提交冲突，请使用新的提交标识');
    return { id: saved.id as string, status: 'pending', duplicate: saved.id !== id };
  }

  get(id: string): ImprovementProposal {
    const result = this.db.prepare(`SELECT ${columns} FROM improvement_proposals WHERE id = ?`).get(id);
    if (!result) throw new HttpError(404, '建议不存在');
    return result as unknown as ImprovementProposal;
  }

  list(filter: ImprovementFilter = {}): ImprovementPage {
    const conditions: string[] = [], values: string[] = [];
    if (filter.category) { conditions.push('category = ?'); values.push(filter.category); }
    if (filter.projectId) { conditions.push('project_id = ?'); values.push(filter.projectId); }
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
