import type { Pool } from "pg";

import type {
  ConfirmationBlockingScope,
  ConfirmationOption,
  ConfirmationStatus,
  DeferredItemReportPolicy,
  DeferredItemStatus,
  ProjectConfirmation,
  ProjectDeferredItem,
  ProjectReport,
} from "../contracts/workflow.js";

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function options(value: unknown): ConfirmationOption[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const candidate = object(item);
    return typeof candidate.label === "string" && typeof candidate.description === "string"
      ? [{ label: candidate.label, description: candidate.description }]
      : [];
  });
}

type ConfirmationRow = {
  id: string;
  confirmation_key: string;
  phase: string;
  question: string;
  options: unknown;
  blocking_scope: ConfirmationBlockingScope;
  status: ConfirmationStatus;
  artifact_url: string | null;
  artifact_revision: number | null;
  answer: string | null;
  answer_source: string | null;
  evidence: unknown;
  created_at: Date | string;
  updated_at: Date | string;
  resolved_at: Date | string | null;
};

function mapConfirmation(row: ConfirmationRow): ProjectConfirmation {
  return {
    id: row.id,
    key: row.confirmation_key,
    phase: row.phase,
    question: row.question,
    options: options(row.options),
    blockingScope: row.blocking_scope,
    status: row.status,
    artifactUrl: row.artifact_url,
    artifactRevision: row.artifact_revision,
    answer: row.answer,
    answerSource: row.answer_source,
    evidence: object(row.evidence),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    resolvedAt: row.resolved_at ? iso(row.resolved_at) : null,
  };
}

type DeferredRow = {
  id: string;
  item_key: string;
  phase: string;
  title: string;
  detail: string | null;
  status: DeferredItemStatus;
  report_policy: DeferredItemReportPolicy;
  evidence: unknown;
  created_at: Date | string;
  updated_at: Date | string;
  completed_at: Date | string | null;
};

function mapDeferredItem(row: DeferredRow): ProjectDeferredItem {
  return {
    id: row.id,
    key: row.item_key,
    phase: row.phase,
    title: row.title,
    detail: row.detail,
    status: row.status,
    reportPolicy: row.report_policy,
    evidence: object(row.evidence),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    completedAt: row.completed_at ? iso(row.completed_at) : null,
  };
}

export class PostgresWorkflowCoordinationRepository {
  constructor(private readonly pool: Pool) {}

  async upsertConfirmation(input: {
    projectId: string;
    agentForkId: string;
    runId: string;
    key: string;
    phase: string;
    question: string;
    options: ConfirmationOption[];
    blockingScope: ConfirmationBlockingScope;
    artifactUrl?: string;
    artifactRevision?: number;
  }): Promise<ProjectConfirmation> {
    const result = await this.pool.query<ConfirmationRow>(
      `INSERT INTO swarm_hive.project_confirmations(
         project_id, agent_fork_id, run_id, confirmation_key, phase,
         question, options, blocking_scope, artifact_url, artifact_revision
       ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10)
       ON CONFLICT (project_id, confirmation_key) DO UPDATE SET
         agent_fork_id = excluded.agent_fork_id,
         run_id = excluded.run_id,
         phase = excluded.phase,
         question = excluded.question,
         options = excluded.options,
         blocking_scope = excluded.blocking_scope,
         artifact_url = coalesce(excluded.artifact_url, swarm_hive.project_confirmations.artifact_url),
         artifact_revision = coalesce(excluded.artifact_revision, swarm_hive.project_confirmations.artifact_revision),
         status = CASE
           WHEN swarm_hive.project_confirmations.status = 'cancelled' THEN 'open'
           ELSE swarm_hive.project_confirmations.status
         END
       RETURNING *`,
      [
        input.projectId,
        input.agentForkId,
        input.runId,
        input.key,
        input.phase,
        input.question,
        JSON.stringify(input.options),
        input.blockingScope,
        input.artifactUrl ?? null,
        input.artifactRevision ?? null,
      ],
    );
    const row = result.rows[0];
    if (!row) throw new Error("Confirmation was not saved");
    return mapConfirmation(row);
  }

  async listConfirmations(input: {
    projectId: string;
    statuses?: ConfirmationStatus[];
  }): Promise<ProjectConfirmation[]> {
    const statuses = input.statuses?.length ? input.statuses : undefined;
    const result = await this.pool.query<ConfirmationRow>(
      `SELECT * FROM swarm_hive.project_confirmations
        WHERE project_id = $1
          AND ($2::text[] IS NULL OR status = ANY($2::text[]))
        ORDER BY created_at, id`,
      [input.projectId, statuses ?? null],
    );
    return result.rows.map(mapConfirmation);
  }

  async resolveConfirmation(input: {
    projectId: string;
    key: string;
    answer: string;
    source: string;
    evidence?: Record<string, unknown>;
  }): Promise<ProjectConfirmation | null> {
    const result = await this.pool.query<ConfirmationRow>(
      `UPDATE swarm_hive.project_confirmations
          SET status = 'resolved', answer = $3, answer_source = $4,
              evidence = evidence || $5::jsonb, resolved_at = now()
        WHERE project_id = $1 AND confirmation_key = $2
          AND status IN ('open', 'answer_received')
      RETURNING *`,
      [input.projectId, input.key, input.answer, input.source, JSON.stringify(input.evidence ?? {})],
    );
    return result.rows[0] ? mapConfirmation(result.rows[0]) : null;
  }

  async cancelConfirmation(input: {
    projectId: string;
    key: string;
    reason: string;
  }): Promise<ProjectConfirmation | null> {
    const result = await this.pool.query<ConfirmationRow>(
      `UPDATE swarm_hive.project_confirmations
          SET status = 'cancelled', answer = $3, answer_source = 'agent',
              resolved_at = now()
        WHERE project_id = $1 AND confirmation_key = $2
          AND status IN ('open', 'answer_received')
      RETURNING *`,
      [input.projectId, input.key, input.reason],
    );
    return result.rows[0] ? mapConfirmation(result.rows[0]) : null;
  }

  async receiveConfirmationAnswers(input: {
    runId: string;
    answers: Record<string, { answers: string[] }>;
    source: string;
  }): Promise<number> {
    let updated = 0;
    for (const [key, value] of Object.entries(input.answers)) {
      const answer = value.answers.map((item) => item.trim()).filter(Boolean).join("；");
      if (!answer) continue;
      const result = await this.pool.query(
        `UPDATE swarm_hive.project_confirmations c
            SET status = 'answer_received', answer = $3, answer_source = $4,
                evidence = evidence || jsonb_build_object('run_id', $1)
           FROM swarm_hive.agent_runs r
          WHERE r.id = $1 AND c.project_id = r.project_id
            AND c.confirmation_key = $2
            AND c.status IN ('open', 'answer_received')`,
        [input.runId, key, answer, input.source],
      );
      updated += result.rowCount ?? 0;
    }
    return updated;
  }

  async hasBlockingConfirmations(projectId: string): Promise<boolean> {
    const result = await this.pool.query(
      `SELECT 1 FROM swarm_hive.project_confirmations
        WHERE project_id = $1
          AND status IN ('open', 'answer_received')
          AND blocking_scope = 'current_phase'
        LIMIT 1`,
      [projectId],
    );
    return result.rowCount === 1;
  }

  async upsertDeferredItem(input: {
    projectId: string;
    agentForkId: string;
    runId: string;
    key: string;
    phase: string;
    title: string;
    detail?: string;
    reportPolicy: DeferredItemReportPolicy;
    evidence?: Record<string, unknown>;
  }): Promise<ProjectDeferredItem> {
    const result = await this.pool.query<DeferredRow>(
      `INSERT INTO swarm_hive.project_deferred_items(
         project_id, agent_fork_id, run_id, item_key, phase, title,
         detail, report_policy, evidence
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
       ON CONFLICT (project_id, item_key) DO UPDATE SET
         agent_fork_id = excluded.agent_fork_id,
         run_id = excluded.run_id,
         phase = excluded.phase,
         title = excluded.title,
         detail = excluded.detail,
         report_policy = excluded.report_policy,
         evidence = swarm_hive.project_deferred_items.evidence || excluded.evidence,
         status = CASE
           WHEN swarm_hive.project_deferred_items.status = 'cancelled' THEN 'open'
           ELSE swarm_hive.project_deferred_items.status
         END
       RETURNING *`,
      [
        input.projectId,
        input.agentForkId,
        input.runId,
        input.key,
        input.phase,
        input.title,
        input.detail ?? null,
        input.reportPolicy,
        JSON.stringify(input.evidence ?? {}),
      ],
    );
    const row = result.rows[0];
    if (!row) throw new Error("Deferred item was not saved");
    return mapDeferredItem(row);
  }

  async listDeferredItems(input: {
    projectId: string;
    statuses?: DeferredItemStatus[];
  }): Promise<ProjectDeferredItem[]> {
    const statuses = input.statuses?.length ? input.statuses : undefined;
    const result = await this.pool.query<DeferredRow>(
      `SELECT * FROM swarm_hive.project_deferred_items
        WHERE project_id = $1
          AND ($2::text[] IS NULL OR status = ANY($2::text[]))
        ORDER BY created_at, id`,
      [input.projectId, statuses ?? null],
    );
    return result.rows.map(mapDeferredItem);
  }

  async completeDeferredItem(input: {
    projectId: string;
    key: string;
    evidence?: Record<string, unknown>;
  }): Promise<ProjectDeferredItem | null> {
    const result = await this.pool.query<DeferredRow>(
      `UPDATE swarm_hive.project_deferred_items
          SET status = 'completed', completed_at = now(),
              evidence = evidence || $3::jsonb
        WHERE project_id = $1 AND item_key = $2 AND status = 'open'
      RETURNING *`,
      [input.projectId, input.key, JSON.stringify(input.evidence ?? {})],
    );
    return result.rows[0] ? mapDeferredItem(result.rows[0]) : null;
  }

  async nextReportVersion(projectId: string, phase: string): Promise<number> {
    const result = await this.pool.query<{ version: number }>(
      `SELECT coalesce(max(version), 0) + 1 AS version
         FROM swarm_hive.project_reports
        WHERE project_id = $1 AND phase = $2`,
      [projectId, phase],
    );
    return Number(result.rows[0]?.version ?? 1);
  }

  async saveReport(input: {
    projectId: string;
    agentForkId: string;
    runId: string;
    reportType: string;
    phase: string;
    version: number;
    status: string;
    conclusion: string;
    relativePath: string;
    sha256: string;
    metadata?: Record<string, unknown>;
  }): Promise<ProjectReport> {
    const result = await this.pool.query<{
      id: string;
      report_type: string;
      phase: string;
      version: number;
      status: string;
      conclusion: string;
      relative_path: string;
      sha256: string;
      metadata: unknown;
      created_at: Date;
    }>(
      `INSERT INTO swarm_hive.project_reports(
         project_id, agent_fork_id, run_id, report_type, phase, version,
         status, conclusion, relative_path, sha256, metadata
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
       RETURNING *`,
      [
        input.projectId,
        input.agentForkId,
        input.runId,
        input.reportType,
        input.phase,
        input.version,
        input.status,
        input.conclusion,
        input.relativePath,
        input.sha256,
        JSON.stringify(input.metadata ?? {}),
      ],
    );
    const row = result.rows[0];
    if (!row) throw new Error("Report was not saved");
    return {
      id: row.id,
      reportType: row.report_type,
      phase: row.phase,
      version: row.version,
      status: row.status,
      conclusion: row.conclusion,
      relativePath: row.relative_path,
      sha256: row.sha256,
      metadata: object(row.metadata),
      createdAt: iso(row.created_at),
    };
  }

  async listReports(projectId: string): Promise<ProjectReport[]> {
    const result = await this.pool.query<{
      id: string;
      report_type: string;
      phase: string;
      version: number;
      status: string;
      conclusion: string;
      relative_path: string;
      sha256: string;
      metadata: unknown;
      created_at: Date;
    }>(
      `SELECT * FROM swarm_hive.project_reports
        WHERE project_id = $1 ORDER BY created_at DESC, id DESC`,
      [projectId],
    );
    return result.rows.map((row) => ({
      id: row.id,
      reportType: row.report_type,
      phase: row.phase,
      version: row.version,
      status: row.status,
      conclusion: row.conclusion,
      relativePath: row.relative_path,
      sha256: row.sha256,
      metadata: object(row.metadata),
      createdAt: iso(row.created_at),
    }));
  }

  async getReportFileContext(reportId: string): Promise<{
    projectId: string;
    specKey: string;
    relativePath: string;
  } | null> {
    const result = await this.pool.query<{
      project_id: string;
      spec_key: string;
      relative_path: string;
    }>(
      `SELECT r.project_id, ai.spec_key, r.relative_path
         FROM swarm_hive.project_reports r
         JOIN swarm_hive.agent_instances ai ON ai.id = r.agent_instance_id
        WHERE r.id = $1`,
      [reportId],
    );
    const row = result.rows[0];
    return row
      ? { projectId: row.project_id, specKey: row.spec_key, relativePath: row.relative_path }
      : null;
  }
}
