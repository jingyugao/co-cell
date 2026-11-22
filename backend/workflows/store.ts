import { hasActiveSubmission, isDispatchable } from '../../packages/workflow/src/state.js';
import type { PoolConnection, Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import type { WorkflowRun, WorkflowSummary } from '../../protocol/workflow-types.js';
import { HttpError } from '../../util/errors.js';

export type StoredRun = WorkflowRun & {
  boxId: string;
  workspace: string;
  createDigest: string;
  requests: Record<string, { digest: string; revision: number }>;
  baseline?: Record<string, string>;
  wave?: string[];
};
export interface WorkflowStore {
  insert(run: StoredRun): Promise<void>;
  get(id: string): Promise<StoredRun | undefined>;
  atRevision(id: string, revision: number): Promise<boolean>;
  list(projectId?: string): Promise<WorkflowSummary[]>;
  pending(): Promise<string[]>;
  save(run: StoredRun, expected: number): Promise<void>;
}
export const terminal = (r: WorkflowRun) => r.status === 'completed' || r.status === 'cancelled';
export function needsWorker(r: StoredRun) {
  if (['paused', 'blocked'].includes(r.status))
    return (
      Boolean(r.wave?.length) ||
      r.jobs.some((j) => j.version === r.version && hasActiveSubmission(j.attempts.at(-1)?.status))
    );
  return r.status === 'cancelling' || isDispatchable(r.status);
}
const conflict = () => new HttpError(409, '工作台状态已变化，请刷新后重试');
export class MySqlWorkflowStore implements WorkflowStore {
  constructor(private pool: Pool) {}
  async init() {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS workflow_runs (
      id CHAR(36) PRIMARY KEY, project_id CHAR(36) NOT NULL, active_project CHAR(36) NULL UNIQUE,
      status VARCHAR(24) NOT NULL, needs_worker BOOLEAN NOT NULL, revision BIGINT UNSIGNED NOT NULL, document JSON NOT NULL,
      updated_at DATETIME(3) NOT NULL, INDEX workflow_pending(needs_worker,updated_at), INDEX workflow_project(project_id,updated_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    await this.pool.query(`CREATE TABLE IF NOT EXISTS workflow_events (
      run_id CHAR(36) NOT NULL, sequence BIGINT UNSIGNED NOT NULL, document JSON NOT NULL,
      PRIMARY KEY(run_id,sequence)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    await this.pool.query(`CREATE TABLE IF NOT EXISTS workflow_artifacts (
      run_id CHAR(36) NOT NULL,id CHAR(36) NOT NULL,revision BIGINT UNSIGNED NOT NULL,digest CHAR(64) NOT NULL,
      document JSON NOT NULL,PRIMARY KEY(run_id,id),INDEX workflow_artifact_revision(run_id,revision)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  }
  private async transaction<T>(action: (connection: PoolConnection) => Promise<T>) {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const value = await action(connection);
      await connection.commit();
      return value;
    } catch (error) {
      await connection.rollback().catch(() => undefined);
      throw error;
    } finally {
      connection.release();
    }
  }
  // The mutable snapshot keeps the identifiers of its immutable artifacts. A
  // read at revision N can join append-only evidence even after N+1 commits.
  private document({ events, artifacts, ...r }: StoredRun) {
    return JSON.stringify({ ...r, artifactIds: artifacts.map((a) => a.id) });
  }
  private async append(connection: PoolConnection, r: StoredRun, expected: number) {
    for (const event of r.events.filter((e) => e.sequence > expected))
      await connection.execute('INSERT INTO workflow_events(run_id,sequence,document) VALUES(?,?,?)', [
        r.id,
        event.sequence,
        JSON.stringify(event),
      ]);
    for (const artifact of r.artifacts.filter((a) => a.sequence !== undefined && a.sequence > expected))
      await connection.execute(
        'INSERT INTO workflow_artifacts(run_id,id,revision,digest,document) VALUES(?,?,?,?,?)',
        [r.id, artifact.id, artifact.sequence, artifact.digest, JSON.stringify(artifact)]
      );
  }
  async insert(r: StoredRun) {
    try {
      await this.transaction(async (connection) => {
        await connection.execute(
          'INSERT INTO workflow_runs(id,project_id,active_project,status,needs_worker,revision,document,updated_at) VALUES(?,?,?,?,?,?,?,?)',
          [
            r.id,
            r.projectId,
            r.projectId,
            r.status,
            needsWorker(r),
            r.revision,
            this.document(r),
            new Date(r.updatedAt),
          ]
        );
        await this.append(connection, r, 0);
      });
    } catch (error) {
      if ((error as { code?: string }).code === 'ER_DUP_ENTRY')
        throw new HttpError(409, '该项目已有未结束的工作流');
      throw error;
    }
  }
  async get(id: string): Promise<StoredRun | undefined> {
    const [rows] = await this.pool.execute<RowDataPacket[]>('SELECT document FROM workflow_runs WHERE id=?', [id]);
    if (!rows.length) return undefined;
    const decode = (row: RowDataPacket) =>
      typeof row.document === 'string' ? JSON.parse(row.document) : row.document;
    const { artifactIds, ...r } = decode(rows[0]) as Omit<StoredRun, 'artifacts' | 'events'> & {
      artifactIds: string[];
    };
    const [[events], [artifacts]] = await Promise.all([
      this.pool.execute<RowDataPacket[]>(
        'SELECT document FROM workflow_events WHERE run_id=? AND sequence<=? ORDER BY sequence',
        [id, r.revision]
      ),
      this.pool.execute<RowDataPacket[]>(
        'SELECT document FROM workflow_artifacts WHERE run_id=? AND revision<=? ORDER BY revision',
        [id, r.revision]
      ),
    ]);
    const values = artifacts.map(decode) as StoredRun['artifacts'];
    if (events.length !== r.revision || values.length !== artifactIds.length)
      throw Error('工作台审计或工件不完整');
    return { ...r, events: events.map(decode), artifacts: values };
  }
  async atRevision(id: string, revision: number) {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      'SELECT id FROM workflow_runs WHERE id=? AND revision=? AND active_project IS NOT NULL',
      [id, revision]
    );
    return rows.length === 1;
  }
  async list(projectId?: string) {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT id,project_id AS projectId,status,revision,
      JSON_UNQUOTE(JSON_EXTRACT(document,'$.requirement')) AS requirement,updated_at FROM workflow_runs
      ${projectId ? 'WHERE project_id=?' : ''} ORDER BY updated_at DESC,id LIMIT 100`,
      projectId ? [projectId] : []
    );
    return rows.map((r) => ({
      id: r.id,
      projectId: r.projectId,
      requirement: r.requirement,
      status: r.status,
      revision: Number(r.revision),
      updatedAt: new Date(r.updated_at).toISOString(),
    })) as WorkflowSummary[];
  }
  async pending() {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT id FROM workflow_runs WHERE needs_worker=1 ORDER BY updated_at,id`
    );
    return rows.map((row) => String(row.id));
  }
  async save(r: StoredRun, expected: number) {
    await this.transaction(async (connection) => {
      const [res] = await connection.execute<ResultSetHeader>(
        'UPDATE workflow_runs SET document=?,status=?,needs_worker=?,revision=?,active_project=?,updated_at=? WHERE id=? AND revision=?',
        [
          this.document(r),
          r.status,
          needsWorker(r),
          r.revision,
          terminal(r) ? null : r.projectId,
          new Date(r.updatedAt),
          r.id,
          expected,
        ]
      );
      if (res.affectedRows !== 1) throw conflict();
      await this.append(connection, r, expected);
    });
  }
}
export function publicRun({
  requests,
  baseline,
  wave,
  boxId,
  workspace,
  createDigest,
  ...run
}: StoredRun): WorkflowRun {
  return run;
}
