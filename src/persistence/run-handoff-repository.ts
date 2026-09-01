import type { Pool } from "pg";

import {
  buildRunHandoff,
  type RunHandoffSource,
} from "../application/run-handoff.js";

export interface AgentRunHandoff {
  sourceRunId: string;
  content: string;
  createdAt: string;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export class PostgresRunHandoffRepository {
  constructor(private readonly pool: Pool) {}

  async getOrCreatePreviousForRun(runId: string): Promise<AgentRunHandoff | null> {
    const previous = await this.pool.query<{ id: string }>(
      `SELECT previous.id
         FROM swarm_hive.agent_runs current
         JOIN swarm_hive.agent_sessions current_session
           ON current_session.id = current.agent_session_id
         JOIN LATERAL (
           SELECT candidate.id
             FROM swarm_hive.agent_runs candidate
             JOIN swarm_hive.agent_sessions candidate_session
               ON candidate_session.id = candidate.agent_session_id
            WHERE candidate_session.agent_seat_id = current_session.agent_seat_id
              AND (candidate.created_at, candidate.id) < (current.created_at, current.id)
              AND candidate.status IN ('succeeded', 'failed', 'cancelled')
            ORDER BY candidate.created_at DESC, candidate.id DESC
            LIMIT 1
         ) previous ON true
        WHERE current.id = $1`,
      [runId],
    );
    const sourceRunId = previous.rows[0]?.id;
    return sourceRunId ? this.getOrCreateForRun(sourceRunId) : null;
  }

  async getOrCreateForRun(sourceRunId: string): Promise<AgentRunHandoff> {
    const existing = await this.getForRun(sourceRunId);
    if (existing) return existing;
    const source = await this.loadSource(sourceRunId);
    if (!source) throw new Error("Run handoff source was not found");
    const content = buildRunHandoff(source);
    const saved = await this.pool.query<{
      source_run_id: string;
      content: string;
      created_at: Date | string;
    }>(
      `INSERT INTO swarm_hive.agent_run_handoffs(
         agent_seat_id, source_run_id, content, metadata
       )
       SELECT session.agent_seat_id, run.id, $2,
              jsonb_build_object('generator', 'deterministic-v1')
         FROM swarm_hive.agent_runs run
         JOIN swarm_hive.agent_sessions session ON session.id = run.agent_session_id
        WHERE run.id = $1
       ON CONFLICT (source_run_id) DO UPDATE SET
         content = excluded.content,
         metadata = excluded.metadata
       RETURNING source_run_id, content, created_at`,
      [sourceRunId, content],
    );
    const row = saved.rows[0];
    if (!row) throw new Error("Run handoff was not saved");
    return {
      sourceRunId: row.source_run_id,
      content: row.content,
      createdAt: iso(row.created_at),
    };
  }

  private async getForRun(sourceRunId: string): Promise<AgentRunHandoff | null> {
    const result = await this.pool.query<{
      source_run_id: string;
      content: string;
      created_at: Date | string;
    }>(
      `SELECT source_run_id, content, created_at
         FROM swarm_hive.agent_run_handoffs
        WHERE source_run_id = $1`,
      [sourceRunId],
    );
    const row = result.rows[0];
    return row ? {
      sourceRunId: row.source_run_id,
      content: row.content,
      createdAt: iso(row.created_at),
    } : null;
  }

  private async loadSource(sourceRunId: string): Promise<RunHandoffSource | null> {
    const run = await this.pool.query<{
      id: string;
      project_id: string;
      status: string;
      task_summary: string | null;
      result_summary: string | null;
      merge_request_url: string | null;
      finished_at: Date | null;
    }>(
      `SELECT id, project_id, status, task_summary, result_summary,
              merge_request_url, finished_at
         FROM swarm_hive.agent_runs WHERE id = $1`,
      [sourceRunId],
    );
    const row = run.rows[0];
    if (!row) return null;
    const cutoff = row.finished_at;
    const [tasks, publications, events] = await Promise.all([
      this.pool.query<{
        id: string;
        title: string;
        status: string;
        assignee_agent_seat_id: string | null;
        blocked_reason: string | null;
        result: string | null;
      }>(
        `SELECT id, title, status, assignee_agent_seat_id, blocked_reason, result
         FROM swarm_hive.project_tasks
          WHERE project_id = $1
            AND ($2::timestamptz IS NULL OR updated_at <= $2)
          ORDER BY updated_at DESC, id DESC LIMIT 16`,
        [row.project_id, cutoff],
      ),
      this.pool.query<{
        kind: string;
        version: number;
        summary: string;
        relative_path: string;
      }>(
        `SELECT kind, version, summary, relative_path
         FROM swarm_hive.project_publications
          WHERE project_id = $1
            AND ($2::timestamptz IS NULL OR created_at <= $2)
          ORDER BY created_at DESC, id DESC LIMIT 10`,
        [row.project_id, cutoff],
      ),
      this.pool.query<{
        event_type: string;
        title: string;
        detail: string | null;
      }>(
        `SELECT event_type, title, detail
           FROM swarm_hive.agent_run_events
          WHERE agent_run_id = $1 AND visible_to_user
          ORDER BY sequence_no DESC LIMIT 12`,
        [sourceRunId],
      ),
    ]);
    return {
      runId: row.id,
      status: row.status,
      taskSummary: row.task_summary,
      resultSummary: row.result_summary,
      mergeRequestUrl: row.merge_request_url,
      finishedAt: row.finished_at ? row.finished_at.toISOString() : null,
      tasks: tasks.rows.map((item) => ({
        id: item.id,
        title: item.title,
        status: item.status,
        assigneeSeatId: item.assignee_agent_seat_id,
        blockedReason: item.blocked_reason,
        result: item.result,
      })),
      publications: publications.rows.map((item) => ({
        kind: item.kind,
        version: item.version,
        summary: item.summary,
        relativePath: item.relative_path,
      })),
      events: events.rows.map((item) => ({
        eventType: item.event_type,
        title: item.title,
        detail: item.detail,
      })),
    };
  }
}
