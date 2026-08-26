import { randomUUID } from "node:crypto";

import type { Pool, PoolClient } from "pg";

import type {
  ProjectListResponse,
  ProjectRunsResponse,
  ProjectSummary,
  ProjectWorkbench,
  RunDetail,
  RunEventDto,
  RunEventsResponse,
  InboxEventsResponse,
  GlobalRunsResponse,
  GlobalInboxEventsResponse,
  AgentSpecUsage,
  AgentInstanceDetail,
  ProjectRunListItem,
  RunStatus,
} from "../contracts/workbench.js";
import type {
  AgentForkResult,
  CancelAgentRunResult,
  StartAgentRunResult,
} from "../contracts/requirements.js";
import { ConflictError } from "../application/errors.js";
import { PostgresWorkflowCoordinationRepository } from "./workflow-coordination-repository.js";

export interface AgentRunExecutionContext {
  runId: string;
  projectId: string;
  forkId: string;
  sessionId: string;
  sourceUrl: string;
  source: string;
  projectKey: string;
  workItemType: string;
  workItemId: string;
  agentInstanceId: string;
  specKey: string;
  specVersion: number;
  role: string;
  threadId: string;
  workspaceKey: string;
}

export interface AgentSessionMemorySnapshot {
  content: string;
  sha256: string;
}

interface CursorValue {
  updatedAt: string;
  id: string;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function encodeCursor(value: CursorValue): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

export function decodeProjectCursor(cursor: string): CursorValue {
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Partial<CursorValue>;
    if (!value.updatedAt || !value.id || Number.isNaN(Date.parse(value.updatedAt))) {
      throw new Error("invalid cursor fields");
    }
    return { updatedAt: value.updatedAt, id: value.id };
  } catch {
    throw new Error("Invalid project cursor");
  }
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function numberValue(value: unknown): number {
  return typeof value === "number" ? value : Number(value);
}

function mapRunEvent(row: {
  sequence_no: string | number;
  event_type: string;
  level: RunEventDto["level"];
  title: string;
  detail: string | null;
  data: unknown;
  created_at: Date | string;
}): RunEventDto {
  return {
    sequenceNo: numberValue(row.sequence_no),
    eventType: row.event_type,
    level: row.level,
    title: row.title,
    detail: row.detail,
    data: record(row.data),
    createdAt: iso(row.created_at),
  };
}

export class PostgresWorkbenchRepository {
  constructor(private readonly pool: Pool) {}

  async ping(): Promise<void> {
    await this.pool.query("SELECT 1");
  }

  async getAgentInstanceDetail(agentInstanceId: string): Promise<AgentInstanceDetail | null> {
    const instance = await this.pool.query<{
      id: string;
      spec_key: string;
      spec_version: number;
      status: AgentInstanceDetail["agentInstance"]["status"];
      workspace_key: string;
      last_active_at: Date | null;
      created_at: Date;
    }>(
      `SELECT ai.id, ai.spec_key, ai.spec_version, ai.status,
              ai.workspace_key, ai.last_active_at, ai.created_at
         FROM swarm_hive.agent_instances ai
        WHERE ai.id = $1`,
      [agentInstanceId],
    );
    const row = instance.rows[0];
    if (!row) return null;

    const forks = await this.pool.query<{
      id: string;
      role: string;
      is_primary: boolean;
      workspace_key: string;
      bound_at: Date;
      project_id: string;
      source: string;
      external_project_id: string;
      external_url: string | null;
      session_id: string;
      session_status: AgentInstanceDetail["forks"][number]["session"]["status"];
      thread_id: string;
      session_last_active_at: Date | null;
      run_id: string | null;
      run_status: RunStatus | null;
      task_summary: string | null;
      started_at: Date | null;
    }>(
      `SELECT fork.id, fork.role, fork.is_primary, fork.workspace_key,
              fork.bound_at, project.id AS project_id, project.source,
              project.external_project_id, project.external_url,
              session.id AS session_id, session.status AS session_status,
              session.thread_id, session.last_active_at AS session_last_active_at,
              active_run.id AS run_id, active_run.status AS run_status,
              active_run.task_summary, active_run.started_at
         FROM swarm_hive.agent_forks fork
         JOIN swarm_hive.projects project ON project.id = fork.project_id
         JOIN swarm_hive.agent_sessions session
           ON session.agent_fork_id = fork.id
          AND session.status IN ('active', 'waiting')
         LEFT JOIN LATERAL (
           SELECT run.id, run.status, run.task_summary, run.started_at
             FROM swarm_hive.agent_runs run
            WHERE run.agent_session_id = session.id
              AND run.status IN ('queued', 'running', 'waiting_user')
            ORDER BY run.created_at DESC LIMIT 1
         ) active_run ON true
        WHERE fork.agent_instance_id = $1 AND fork.unbound_at IS NULL
        ORDER BY fork.bound_at DESC`,
      [agentInstanceId],
    );

    const runs = await this.pool.query<{
      id: string;
      status: ProjectRunListItem["status"];
      task_summary: string | null;
      result_summary: string | null;
      merge_request_url: string | null;
      started_at: Date | null;
      finished_at: Date | null;
      created_at: Date;
      duration_seconds: string;
      trigger_source: string | null;
      trigger_event_type: string | null;
    }>(
      `SELECT r.id, r.status, r.task_summary, r.result_summary,
              r.merge_request_url, r.started_at, r.finished_at, r.created_at,
              greatest(0, extract(epoch FROM (
                coalesce(r.finished_at, now()) - coalesce(r.started_at, r.created_at)
              )))::bigint::text AS duration_seconds,
              e.source AS trigger_source, e.event_type AS trigger_event_type
         FROM swarm_hive.agent_runs r
         LEFT JOIN swarm_hive.inbox_events e ON e.id = r.trigger_event_id
        WHERE r.agent_instance_id = $1
        ORDER BY r.created_at DESC, r.id DESC
        LIMIT 50`,
      [agentInstanceId],
    );
    const recentRuns: ProjectRunListItem[] = runs.rows.map((run) => ({
      id: run.id,
      status: run.status,
      taskSummary: run.task_summary,
      resultSummary: run.result_summary,
      mergeRequestUrl: run.merge_request_url,
      trigger: run.trigger_source && run.trigger_event_type
        ? { source: run.trigger_source, eventType: run.trigger_event_type }
        : null,
      durationSeconds: Number(run.duration_seconds),
      startedAt: run.started_at ? iso(run.started_at) : null,
      finishedAt: run.finished_at ? iso(run.finished_at) : null,
      createdAt: iso(run.created_at),
    }));
    return {
      agentInstance: {
        id: row.id,
        specKey: row.spec_key,
        specVersion: row.spec_version,
        status: row.status,
        workspaceKey: row.workspace_key,
        lastActiveAt: row.last_active_at ? iso(row.last_active_at) : null,
        createdAt: iso(row.created_at),
      },
      forks: forks.rows.map((fork) => ({
        id: fork.id,
        role: fork.role,
        isPrimary: fork.is_primary,
        workspaceKey: fork.workspace_key,
        boundAt: iso(fork.bound_at),
        project: {
          id: fork.project_id,
          source: fork.source,
          externalProjectId: fork.external_project_id,
          externalUrl: fork.external_url,
        },
        session: {
          id: fork.session_id,
          status: fork.session_status,
          threadId: fork.thread_id,
          lastActiveAt: fork.session_last_active_at
            ? iso(fork.session_last_active_at)
            : null,
        },
        currentRun: fork.run_id && fork.run_status
          ? {
              id: fork.run_id,
              status: fork.run_status,
              taskSummary: fork.task_summary,
              startedAt: fork.started_at ? iso(fork.started_at) : null,
            }
          : null,
      })),
      recentRuns,
    };
  }

  async getAgentSessionThreadId(agentSessionId: string): Promise<string | null> {
    const result = await this.pool.query<{ thread_id: string }>(
      "SELECT thread_id FROM swarm_hive.agent_sessions WHERE id = $1",
      [agentSessionId],
    );
    return result.rows[0]?.thread_id ?? null;
  }

  async projectExists(projectId: string): Promise<boolean> {
    const result = await this.pool.query("SELECT 1 FROM swarm_hive.projects WHERE id = $1", [projectId]);
    return result.rowCount === 1;
  }

  async listProjects(options: {
    limit: number;
    cursor?: CursorValue;
    status?: ProjectSummary["status"];
  }): Promise<ProjectListResponse> {
    const values: unknown[] = [options.limit + 1];
    const filters: string[] = [];
    if (options.status) {
      values.push(options.status);
      filters.push(`p.status = $${values.length}`);
    }
    if (options.cursor) {
      values.push(options.cursor.updatedAt);
      const timestampParameter = values.length;
      values.push(options.cursor.id);
      filters.push(
        `(p.updated_at, p.id) < ($${timestampParameter}::timestamptz, $${values.length}::uuid)`,
      );
    }
    const where = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";

    const result = await this.pool.query<{
      id: string;
      source: string;
      external_project_id: string;
      external_url: string | null;
      name: string | null;
      status: ProjectSummary["status"];
      updated_at: Date;
      agent_instance_id: string | null;
      agent_instance_status: NonNullable<ProjectSummary["agentInstance"]>["status"] | null;
      spec_key: string | null;
      run_id: string | null;
      run_status: NonNullable<ProjectSummary["currentRun"]>["status"] | null;
      task_summary: string | null;
    }>(
      `SELECT p.id, p.source, p.external_project_id, p.external_url,
              p.name, p.status, p.updated_at,
              ai.id AS agent_instance_id, ai.status AS agent_instance_status,
              ai.spec_key, active_run.id AS run_id,
              active_run.status AS run_status, active_run.task_summary
         FROM swarm_hive.projects p
         LEFT JOIN swarm_hive.agent_forks pai
           ON pai.project_id = p.id AND pai.unbound_at IS NULL AND pai.is_primary
         LEFT JOIN swarm_hive.agent_instances ai ON ai.id = pai.agent_instance_id
         LEFT JOIN LATERAL (
           SELECT r.id, r.status, r.task_summary
             FROM swarm_hive.agent_runs r
            WHERE r.project_id = p.id
              AND r.status IN ('queued', 'running', 'waiting_user')
            ORDER BY r.created_at DESC
            LIMIT 1
         ) active_run ON true
        ${where}
        ORDER BY p.updated_at DESC, p.id DESC
        LIMIT $1`,
      values,
    );

    const hasMore = result.rows.length > options.limit;
    const rows = result.rows.slice(0, options.limit);
    const items = rows.map((row): ProjectSummary => ({
      id: row.id,
      source: row.source,
      externalProjectId: row.external_project_id,
      externalUrl: row.external_url,
      name: row.name,
      status: row.status,
      agentInstance:
        row.agent_instance_id && row.agent_instance_status && row.spec_key
          ? {
              id: row.agent_instance_id,
              status: row.agent_instance_status,
              specKey: row.spec_key,
            }
          : null,
      currentRun:
        row.run_id && row.run_status
          ? { id: row.run_id, status: row.run_status, taskSummary: row.task_summary }
          : null,
      updatedAt: iso(row.updated_at),
    }));
    const last = rows.at(-1);
    return {
      items,
      nextCursor:
        hasMore && last
          ? encodeCursor({ updatedAt: iso(last.updated_at), id: last.id })
          : null,
    };
  }

  async getProjectWorkbench(projectId: string): Promise<Omit<ProjectWorkbench, "runtime"> | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const projectResult = await client.query<{
        id: string;
        source: string;
        external_project_id: string;
        name: string | null;
        status: ProjectWorkbench["project"]["status"];
        owner: string | null;
        updated_at: Date;
      }>(
        `SELECT id, source, external_project_id, name, status,
                metadata->>'owner' AS owner, updated_at
           FROM swarm_hive.projects
          WHERE id = $1`,
        [projectId],
      );
      const projectRow = projectResult.rows[0];
      if (!projectRow) {
        await client.query("COMMIT");
        return null;
      }

      const instanceResult = await client.query<{
        id: string;
        spec_key: string;
        spec_version: number;
        agent_instance_id: string;
        session_id: string;
        role: string;
        status: NonNullable<ProjectWorkbench["primaryAgentFork"]>["status"];
        workspace_key: string;
        thread_id: string;
        last_active_at: Date | null;
      }>(
        `SELECT pai.id, ai.id AS agent_instance_id, session.id AS session_id,
                pai.role, ai.spec_key, ai.spec_version, ai.status,
                pai.workspace_key, session.thread_id, ai.last_active_at
           FROM swarm_hive.agent_forks pai
           JOIN swarm_hive.agent_instances ai ON ai.id = pai.agent_instance_id
           JOIN swarm_hive.agent_sessions session
             ON session.agent_fork_id = pai.id
            AND session.status IN ('active', 'waiting')
          WHERE pai.project_id = $1 AND pai.unbound_at IS NULL AND pai.is_primary
          LIMIT 1`,
        [projectId],
      );
      const statisticsResult = await client.query<{
        active_runs: string;
        total_runs: string;
        completed_runs: string;
        succeeded_runs: string;
      }>(
        `SELECT count(*) FILTER (WHERE status IN ('queued','running','waiting_user'))::text AS active_runs,
                count(*)::text AS total_runs,
                count(*) FILTER (WHERE status IN ('succeeded','failed'))::text AS completed_runs,
                count(*) FILTER (WHERE status = 'succeeded')::text AS succeeded_runs
           FROM swarm_hive.agent_runs
          WHERE project_id = $1`,
        [projectId],
      );
      const currentRunResult = await client.query<{
        id: string;
        status: NonNullable<ProjectWorkbench["currentRun"]>["status"];
        task_summary: string | null;
        started_at: Date | null;
        created_at: Date;
        elapsed_seconds: string;
        trigger_source: string | null;
        trigger_event_type: string | null;
      }>(
        `SELECT r.id, r.status, r.task_summary, r.started_at, r.created_at,
                greatest(0, extract(epoch FROM (now() - coalesce(r.started_at, r.created_at))))::bigint::text AS elapsed_seconds,
                e.source AS trigger_source, e.event_type AS trigger_event_type
           FROM swarm_hive.agent_runs r
           LEFT JOIN swarm_hive.inbox_events e ON e.id = r.trigger_event_id
          WHERE r.project_id = $1 AND r.status IN ('queued','running','waiting_user')
          ORDER BY r.created_at DESC LIMIT 1`,
        [projectId],
      );
      const recentRunsResult = await client.query<{
        id: string;
        status: ProjectWorkbench["recentRuns"][number]["status"];
        task_summary: string | null;
        created_at: Date;
        duration_seconds: string;
        trigger_source: string | null;
        trigger_event_type: string | null;
      }>(
        `SELECT r.id, r.status, r.task_summary, r.created_at,
                greatest(0, extract(epoch FROM (
                  coalesce(r.finished_at, now()) - coalesce(r.started_at, r.created_at)
                )))::bigint::text AS duration_seconds,
                e.source AS trigger_source, e.event_type AS trigger_event_type
           FROM swarm_hive.agent_runs r
           LEFT JOIN swarm_hive.inbox_events e ON e.id = r.trigger_event_id
          WHERE r.project_id = $1
          ORDER BY r.created_at DESC LIMIT 3`,
        [projectId],
      );
      const inboxResult = await client.query<{
        id: string;
        source: string;
        external_event_id: string;
        event_type: string;
        status: NonNullable<ProjectWorkbench["latestInboxEvent"]>["status"];
        received_at: Date;
      }>(
        `SELECT id, source, external_event_id, event_type, status, received_at
           FROM swarm_hive.inbox_events
          WHERE project_id = $1
          ORDER BY received_at DESC LIMIT 1`,
        [projectId],
      );

      const currentRunRow = currentRunResult.rows[0];
      const events = currentRunRow
        ? await this.getRunEventsWithClient(client, currentRunRow.id, 0, 100)
        : { items: [], lastSequence: 0 };
      await client.query("COMMIT");

      const statistics = statisticsResult.rows[0] ?? {
        active_runs: "0",
        total_runs: "0",
        completed_runs: "0",
        succeeded_runs: "0",
      };
      const completedRuns = Number(statistics.completed_runs);
      const progressEvent = [...events.items]
        .reverse()
        .find((event) => typeof event.data.progressPercent === "number");
      const progressData = progressEvent?.data ?? {};
      const instanceRow = instanceResult.rows[0];
      const inboxRow = inboxResult.rows[0];

      return {
        project: {
          id: projectRow.id,
          source: projectRow.source,
          externalProjectId: projectRow.external_project_id,
          name: projectRow.name,
          status: projectRow.status,
          owner: projectRow.owner,
          updatedAt: iso(projectRow.updated_at),
        },
        statistics: {
          activeRuns: Number(statistics.active_runs),
          totalRuns: Number(statistics.total_runs),
          completedRuns,
          successRate:
            completedRuns === 0
              ? null
              : Number((Number(statistics.succeeded_runs) / completedRuns).toFixed(4)),
        },
        primaryAgentFork: instanceRow
          ? {
              id: instanceRow.id,
              agentInstanceId: instanceRow.agent_instance_id,
              sessionId: instanceRow.session_id,
              role: instanceRow.role,
              specKey: instanceRow.spec_key,
              specVersion: instanceRow.spec_version,
              status: instanceRow.status,
              workspaceKey: instanceRow.workspace_key,
              threadId: instanceRow.thread_id,
              lastActiveAt: instanceRow.last_active_at ? iso(instanceRow.last_active_at) : null,
            }
          : null,
        currentRun: currentRunRow
          ? {
              id: currentRunRow.id,
              status: currentRunRow.status,
              taskSummary: currentRunRow.task_summary,
              trigger:
                currentRunRow.trigger_source && currentRunRow.trigger_event_type
                  ? { source: currentRunRow.trigger_source, eventType: currentRunRow.trigger_event_type }
                  : null,
              startedAt: currentRunRow.started_at ? iso(currentRunRow.started_at) : null,
              elapsedSeconds: Number(currentRunRow.elapsed_seconds),
              progress: {
                phase: typeof progressData.phase === "string" ? progressData.phase : null,
                percent:
                  typeof progressData.progressPercent === "number"
                    ? Math.max(0, Math.min(100, progressData.progressPercent))
                    : null,
                summary: progressEvent?.title ?? "等待运行事件",
                command: typeof progressData.command === "string" ? progressData.command : null,
              },
              events: events.items,
            }
          : null,
        recentRuns: recentRunsResult.rows.map((row) => ({
          id: row.id,
          status: row.status,
          taskSummary: row.task_summary,
          trigger:
            row.trigger_source && row.trigger_event_type
              ? { source: row.trigger_source, eventType: row.trigger_event_type }
              : null,
          durationSeconds: Number(row.duration_seconds),
          createdAt: iso(row.created_at),
        })),
        latestInboxEvent: inboxRow
          ? {
              id: inboxRow.id,
              source: inboxRow.source,
              externalEventId: inboxRow.external_event_id,
              eventType: inboxRow.event_type,
              status: inboxRow.status,
              receivedAt: iso(inboxRow.received_at),
            }
          : null,
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async getRunEvents(runId: string, afterSequence: number, limit: number): Promise<RunEventsResponse> {
    return this.getRunEventsWithClient(this.pool, runId, afterSequence, limit);
  }

  async getRun(runId: string): Promise<RunDetail | null> {
    const result = await this.pool.query<{
      id: string;
      project_id: string;
      agent_instance_id: string;
      status: RunDetail["status"];
      task_summary: string | null;
      result_summary: string | null;
      merge_request_url: string | null;
      error_code: string | null;
      error_message: string | null;
      started_at: Date | null;
      finished_at: Date | null;
      created_at: Date;
      updated_at: Date;
      trigger_id: string | null;
      trigger_source: string | null;
      trigger_event_type: string | null;
    }>(
      `SELECT r.id, r.project_id, r.agent_instance_id, r.status,
              r.task_summary, r.result_summary, r.merge_request_url,
              r.error_code, r.error_message, r.started_at, r.finished_at,
              r.created_at, r.updated_at, e.id AS trigger_id,
              e.source AS trigger_source, e.event_type AS trigger_event_type
         FROM swarm_hive.agent_runs r
         LEFT JOIN swarm_hive.inbox_events e ON e.id = r.trigger_event_id
        WHERE r.id = $1`,
      [runId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      id: row.id,
      projectId: row.project_id,
      agentInstanceId: row.agent_instance_id,
      status: row.status,
      taskSummary: row.task_summary,
      resultSummary: row.result_summary,
      mergeRequestUrl: row.merge_request_url,
      error:
        row.error_code || row.error_message
          ? { code: row.error_code, message: row.error_message }
          : null,
      trigger:
        row.trigger_id && row.trigger_source && row.trigger_event_type
          ? {
              id: row.trigger_id,
              source: row.trigger_source,
              eventType: row.trigger_event_type,
            }
          : null,
      startedAt: row.started_at ? iso(row.started_at) : null,
      finishedAt: row.finished_at ? iso(row.finished_at) : null,
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
    };
  }

  async listProjectRuns(options: {
    projectId: string;
    limit: number;
    cursor?: CursorValue;
  }): Promise<ProjectRunsResponse> {
    const values: unknown[] = [options.projectId];
    let cursorWhere = "";
    if (options.cursor) {
      values.push(options.cursor.updatedAt, options.cursor.id);
      cursorWhere = "AND (r.created_at, r.id) < ($2::timestamptz, $3::uuid)";
    }
    values.push(options.limit + 1);
    const result = await this.pool.query<{
      id: string;
      status: ProjectRunsResponse["items"][number]["status"];
      task_summary: string | null;
      result_summary: string | null;
      merge_request_url: string | null;
      started_at: Date | null;
      finished_at: Date | null;
      created_at: Date;
      duration_seconds: string;
      trigger_source: string | null;
      trigger_event_type: string | null;
    }>(
      `SELECT r.id, r.status, r.task_summary, r.result_summary,
              r.merge_request_url, r.started_at, r.finished_at, r.created_at,
              greatest(0, extract(epoch FROM (
                coalesce(r.finished_at, now()) - coalesce(r.started_at, r.created_at)
              )))::bigint::text AS duration_seconds,
              e.source AS trigger_source, e.event_type AS trigger_event_type
         FROM swarm_hive.agent_runs r
         LEFT JOIN swarm_hive.inbox_events e ON e.id = r.trigger_event_id
        WHERE r.project_id = $1 ${cursorWhere}
        ORDER BY r.created_at DESC, r.id DESC
        LIMIT $${values.length}`,
      values,
    );
    const hasMore = result.rows.length > options.limit;
    const rows = result.rows.slice(0, options.limit);
    const last = rows.at(-1);
    return {
      items: rows.map((row) => ({
        id: row.id,
        status: row.status,
        taskSummary: row.task_summary,
        resultSummary: row.result_summary,
        mergeRequestUrl: row.merge_request_url,
        trigger:
          row.trigger_source && row.trigger_event_type
            ? { source: row.trigger_source, eventType: row.trigger_event_type }
            : null,
        durationSeconds: Number(row.duration_seconds),
        startedAt: row.started_at ? iso(row.started_at) : null,
        finishedAt: row.finished_at ? iso(row.finished_at) : null,
        createdAt: iso(row.created_at),
      })),
      nextCursor:
        hasMore && last
          ? encodeCursor({ updatedAt: iso(last.created_at), id: last.id })
          : null,
    };
  }

  async listInboxEvents(options: {
    projectId: string;
    limit: number;
    cursor?: CursorValue;
  }): Promise<InboxEventsResponse> {
    const values: unknown[] = [options.projectId];
    let cursorWhere = "";
    if (options.cursor) {
      values.push(options.cursor.updatedAt, options.cursor.id);
      cursorWhere = "AND (received_at, id) < ($2::timestamptz, $3::uuid)";
    }
    values.push(options.limit + 1);
    const result = await this.pool.query<{
      id: string;
      source: string;
      external_event_id: string;
      event_type: string;
      status: InboxEventsResponse["items"][number]["status"];
      retry_count: number;
      error_message: string | null;
      received_at: Date;
      processed_at: Date | null;
    }>(
      `SELECT id, source, external_event_id, event_type, status, retry_count,
              error_message, received_at, processed_at
         FROM swarm_hive.inbox_events
        WHERE project_id = $1 ${cursorWhere}
        ORDER BY received_at DESC, id DESC
        LIMIT $${values.length}`,
      values,
    );
    const hasMore = result.rows.length > options.limit;
    const rows = result.rows.slice(0, options.limit);
    const last = rows.at(-1);
    return {
      items: rows.map((row) => ({
        id: row.id,
        source: row.source,
        externalEventId: row.external_event_id,
        eventType: row.event_type,
        status: row.status,
        retryCount: row.retry_count,
        errorMessage: row.error_message,
        receivedAt: iso(row.received_at),
        processedAt: row.processed_at ? iso(row.processed_at) : null,
      })),
      nextCursor:
        hasMore && last
          ? encodeCursor({ updatedAt: iso(last.received_at), id: last.id })
          : null,
    };
  }

  async listRuns(options: {
    limit: number;
    cursor?: CursorValue;
  }): Promise<GlobalRunsResponse> {
    const values: unknown[] = [];
    let cursorWhere = "";
    if (options.cursor) {
      values.push(options.cursor.updatedAt, options.cursor.id);
      cursorWhere = "WHERE (r.created_at, r.id) < ($1::timestamptz, $2::uuid)";
    }
    values.push(options.limit + 1);
    const result = await this.pool.query<{
      id: string;
      status: GlobalRunsResponse["items"][number]["status"];
      task_summary: string | null;
      result_summary: string | null;
      merge_request_url: string | null;
      started_at: Date | null;
      finished_at: Date | null;
      created_at: Date;
      duration_seconds: string;
      trigger_source: string | null;
      trigger_event_type: string | null;
      project_id: string;
      project_name: string | null;
      external_project_id: string;
    }>(
      `SELECT r.id, r.status, r.task_summary, r.result_summary,
              r.merge_request_url, r.started_at, r.finished_at, r.created_at,
              greatest(0, extract(epoch FROM (
                coalesce(r.finished_at, now()) - coalesce(r.started_at, r.created_at)
              )))::bigint::text AS duration_seconds,
              e.source AS trigger_source, e.event_type AS trigger_event_type,
              p.id AS project_id, p.name AS project_name, p.external_project_id
         FROM swarm_hive.agent_runs r
         JOIN swarm_hive.projects p ON p.id = r.project_id
         LEFT JOIN swarm_hive.inbox_events e ON e.id = r.trigger_event_id
        ${cursorWhere}
        ORDER BY r.created_at DESC, r.id DESC
        LIMIT $${values.length}`,
      values,
    );
    const hasMore = result.rows.length > options.limit;
    const rows = result.rows.slice(0, options.limit);
    const last = rows.at(-1);
    return {
      items: rows.map((row) => ({
        id: row.id,
        status: row.status,
        taskSummary: row.task_summary,
        resultSummary: row.result_summary,
        mergeRequestUrl: row.merge_request_url,
        trigger:
          row.trigger_source && row.trigger_event_type
            ? { source: row.trigger_source, eventType: row.trigger_event_type }
            : null,
        durationSeconds: Number(row.duration_seconds),
        startedAt: row.started_at ? iso(row.started_at) : null,
        finishedAt: row.finished_at ? iso(row.finished_at) : null,
        createdAt: iso(row.created_at),
        project: {
          id: row.project_id,
          name: row.project_name,
          externalProjectId: row.external_project_id,
        },
      })),
      nextCursor:
        hasMore && last
          ? encodeCursor({ updatedAt: iso(last.created_at), id: last.id })
          : null,
    };
  }

  async listAllInboxEvents(options: {
    limit: number;
    cursor?: CursorValue;
  }): Promise<GlobalInboxEventsResponse> {
    const values: unknown[] = [];
    let cursorWhere = "";
    if (options.cursor) {
      values.push(options.cursor.updatedAt, options.cursor.id);
      cursorWhere = "WHERE (e.received_at, e.id) < ($1::timestamptz, $2::uuid)";
    }
    values.push(options.limit + 1);
    const result = await this.pool.query<{
      id: string;
      source: string;
      external_event_id: string;
      event_type: string;
      status: GlobalInboxEventsResponse["items"][number]["status"];
      retry_count: number;
      error_message: string | null;
      received_at: Date;
      processed_at: Date | null;
      project_id: string | null;
      project_name: string | null;
      external_project_id: string | null;
    }>(
      `SELECT e.id, e.source, e.external_event_id, e.event_type, e.status,
              e.retry_count, e.error_message, e.received_at, e.processed_at,
              p.id AS project_id, p.name AS project_name, p.external_project_id
         FROM swarm_hive.inbox_events e
         LEFT JOIN swarm_hive.projects p ON p.id = e.project_id
        ${cursorWhere}
        ORDER BY e.received_at DESC, e.id DESC
        LIMIT $${values.length}`,
      values,
    );
    const hasMore = result.rows.length > options.limit;
    const rows = result.rows.slice(0, options.limit);
    const last = rows.at(-1);
    return {
      items: rows.map((row) => ({
        id: row.id,
        source: row.source,
        externalEventId: row.external_event_id,
        eventType: row.event_type,
        status: row.status,
        retryCount: row.retry_count,
        errorMessage: row.error_message,
        receivedAt: iso(row.received_at),
        processedAt: row.processed_at ? iso(row.processed_at) : null,
        project:
          row.project_id && row.external_project_id
            ? {
                id: row.project_id,
                name: row.project_name,
                externalProjectId: row.external_project_id,
              }
            : null,
      })),
      nextCursor:
        hasMore && last
          ? encodeCursor({ updatedAt: iso(last.received_at), id: last.id })
          : null,
    };
  }

  async getAgentSpecUsage(specKey: string): Promise<AgentSpecUsage> {
    const [statisticsResult, requirementsResult] = await Promise.all([
      this.pool.query<{ instances: string; running_instances: string }>(
        `SELECT count(*)::text AS instances,
                count(*) FILTER (WHERE EXISTS (
                  SELECT 1 FROM swarm_hive.agent_runs run
                   WHERE run.agent_instance_id = instance.id
                     AND run.status = 'running'
                ))::text AS running_instances
           FROM swarm_hive.agent_instances instance
          WHERE instance.spec_key = $1`,
        [specKey],
      ),
      this.pool.query<{
        association_id: string;
        role: string;
        is_primary: boolean;
        bound_at: Date;
        project_id: string;
        project_name: string | null;
        external_project_id: string;
        project_status: AgentSpecUsage["activeRequirements"][number]["project"]["status"];
        instance_id: string;
        spec_version: number;
        instance_status: AgentSpecUsage["activeRequirements"][number]["agentInstance"]["status"];
        workspace_key: string;
        last_active_at: Date | null;
        run_id: string | null;
        run_status: NonNullable<AgentSpecUsage["activeRequirements"][number]["currentRun"]>["status"] | null;
        task_summary: string | null;
      }>(
        `SELECT pai.id AS association_id, pai.role, pai.is_primary, pai.bound_at,
                p.id AS project_id, p.name AS project_name,
                p.external_project_id, p.status AS project_status,
                ai.id AS instance_id, ai.spec_version, ai.status AS instance_status,
                pai.workspace_key, ai.last_active_at,
                active_run.id AS run_id, active_run.status AS run_status,
                active_run.task_summary
           FROM swarm_hive.agent_instances ai
           JOIN swarm_hive.agent_forks pai
             ON pai.agent_instance_id = ai.id AND pai.unbound_at IS NULL
           JOIN swarm_hive.projects p
             ON p.id = pai.project_id AND p.status = 'active'
           LEFT JOIN LATERAL (
             SELECT r.id, r.status, r.task_summary
               FROM swarm_hive.agent_runs r
              WHERE r.agent_instance_id = ai.id
                AND r.project_id = p.id
                AND r.status IN ('queued', 'running', 'waiting_user')
              ORDER BY r.created_at DESC LIMIT 1
           ) active_run ON true
          WHERE ai.spec_key = $1
          ORDER BY p.updated_at DESC, pai.is_primary DESC, pai.bound_at ASC`,
        [specKey],
      ),
    ]);
    const statistics = statisticsResult.rows[0] ?? {
      instances: "0",
      running_instances: "0",
    };
    return {
      statistics: {
        instances: Number(statistics.instances),
        activeRequirements: requirementsResult.rows.length,
        runningInstances: Number(statistics.running_instances),
      },
      activeRequirements: requirementsResult.rows.map((row) => ({
        forkId: row.association_id,
        role: row.role,
        isPrimary: row.is_primary,
        boundAt: iso(row.bound_at),
        project: {
          id: row.project_id,
          name: row.project_name,
          externalProjectId: row.external_project_id,
          status: row.project_status,
        },
        agentInstance: {
          id: row.instance_id,
          specVersion: row.spec_version,
          status: row.instance_status,
          workspaceKey: row.workspace_key,
          lastActiveAt: row.last_active_at ? iso(row.last_active_at) : null,
        },
        currentRun:
          row.run_id && row.run_status
            ? {
                id: row.run_id,
                status: row.run_status,
                taskSummary: row.task_summary,
              }
            : null,
      })),
    };
  }

  async createAgentFork(input: {
    sourceUrl: string;
    externalProjectKey: string;
    externalWorkItemType: string;
    externalWorkItemId: string;
    specKey: string;
    specVersion: number;
    role: string;
    threadId: string;
    workspaceKey: string;
  }): Promise<AgentForkResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const project = await client.query<{ id: string }>(
        `INSERT INTO swarm_hive.projects(
           source, external_project_id, external_url, external_project_key,
           external_work_item_type, name, status
         ) VALUES ('feishu_project', $1, $2, $3, $4, NULL, 'active')
         ON CONFLICT (
           source, external_project_key, external_work_item_type, external_project_id
         ) WHERE external_project_key IS NOT NULL AND external_work_item_type IS NOT NULL
         DO UPDATE SET external_url = excluded.external_url
         RETURNING id`,
        [
          input.externalWorkItemId,
          input.sourceUrl,
          input.externalProjectKey,
          input.externalWorkItemType,
        ],
      );
      const projectId = project.rows[0]?.id;
      if (!projectId) throw new Error("External work item reference was not created");
      await client.query(
        "SELECT id FROM swarm_hive.projects WHERE id = $1 FOR UPDATE",
        [projectId],
      );
      const activeAssignment = await client.query<{ id: string }>(
        `SELECT id
           FROM swarm_hive.agent_forks
          WHERE project_id = $1 AND unbound_at IS NULL
          LIMIT 1`,
        [projectId],
      );
      if (activeAssignment.rowCount) {
        throw new ConflictError("This requirement already has an active Agent");
      }
      const instance = await client.query<{ id: string }>(
        `INSERT INTO swarm_hive.agent_instances(
           spec_key, spec_version, instance_key, workspace_key, status
         ) VALUES ($1, $2, $1, $1, 'active')
         ON CONFLICT (spec_key) DO UPDATE
           SET spec_version = excluded.spec_version
         RETURNING id`,
        [input.specKey, input.specVersion],
      );
      const agentInstanceId = instance.rows[0]?.id;
      if (!agentInstanceId) throw new Error("Agent Instance was not created");
      const fork = await client.query<{ id: string }>(
        `INSERT INTO swarm_hive.agent_forks(
           project_id, agent_instance_id, role, is_primary, workspace_key
         ) VALUES ($1, $2, $3, true, $4)
         RETURNING id`,
        [projectId, agentInstanceId, input.role, input.workspaceKey],
      );
      const forkId = fork.rows[0]?.id;
      if (!forkId) throw new Error("Agent Fork was not created");
      const session = await client.query<{ id: string }>(
        `INSERT INTO swarm_hive.agent_sessions(agent_fork_id, thread_id)
         VALUES ($1, $2)
         RETURNING id`,
        [forkId, input.threadId],
      );
      const sessionId = session.rows[0]?.id;
      if (!sessionId) throw new Error("Agent Session was not created");
      await client.query("COMMIT");
      return {
        projectId,
        forkId,
        role: input.role,
        agentInstance: {
          id: agentInstanceId,
          specKey: input.specKey,
          specVersion: input.specVersion,
          status: "active",
        },
        session: {
          id: sessionId,
          threadId: input.threadId,
          workspaceKey: input.workspaceKey,
          status: "active",
        },
        currentRun: null,
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async listAgentForks(input: {
    externalProjectKey: string;
    externalWorkItemType: string;
    externalWorkItemId: string;
  }): Promise<AgentForkResult[]> {
    const result = await this.pool.query<{
      project_id: string;
      fork_id: string;
      session_id: string;
      agent_instance_id: string;
      spec_key: string;
      spec_version: number;
      role: string;
      workspace_key: string;
      thread_id: string;
      status: AgentForkResult["agentInstance"]["status"];
      session_status: AgentForkResult["session"]["status"];
      run_id: string | null;
      run_status: NonNullable<AgentForkResult["currentRun"]>["status"] | null;
      task_summary: string | null;
    }>(
      `SELECT p.id AS project_id, pai.id AS fork_id, session.id AS session_id,
              ai.id AS agent_instance_id, ai.spec_key, ai.spec_version,
              pai.role,
              pai.workspace_key, session.thread_id, session.status AS session_status,
              ai.status,
              active_run.id AS run_id, active_run.status AS run_status,
              active_run.task_summary
         FROM swarm_hive.projects p
         JOIN swarm_hive.agent_forks pai
           ON pai.project_id = p.id AND pai.unbound_at IS NULL
         JOIN swarm_hive.agent_instances ai ON ai.id = pai.agent_instance_id
         JOIN swarm_hive.agent_sessions session
           ON session.agent_fork_id = pai.id
          AND session.status IN ('active', 'waiting')
         LEFT JOIN LATERAL (
           SELECT r.id, r.status, r.task_summary
             FROM swarm_hive.agent_runs r
            WHERE r.project_id = p.id
              AND r.agent_instance_id = ai.id
              AND r.status IN ('queued', 'running', 'waiting_user')
            ORDER BY r.created_at DESC LIMIT 1
         ) active_run ON true
        WHERE p.source = 'feishu_project'
          AND p.external_project_key = $1
          AND p.external_work_item_type = $2
          AND p.external_project_id = $3
        ORDER BY pai.bound_at ASC`,
      [input.externalProjectKey, input.externalWorkItemType, input.externalWorkItemId],
    );
    return result.rows.map((row) => ({
        projectId: row.project_id,
        forkId: row.fork_id,
        role: row.role,
        agentInstance: {
          id: row.agent_instance_id,
          specKey: row.spec_key,
          specVersion: row.spec_version,
          status: row.status,
        },
        session: {
          id: row.session_id,
          threadId: row.thread_id,
          workspaceKey: row.workspace_key,
          status: row.session_status,
        },
        currentRun: row.run_id && row.run_status
          ? { id: row.run_id, status: row.run_status, taskSummary: row.task_summary }
          : null,
      }));
  }

  async createAgentRun(forkId: string): Promise<StartAgentRunResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const assignment = await client.query<{
        project_id: string;
        agent_instance_id: string;
        work_item_id: string;
        instance_status: AgentForkResult["agentInstance"]["status"];
      }>(
        `SELECT pai.project_id, pai.agent_instance_id,
                p.external_project_id AS work_item_id,
                ai.status AS instance_status
           FROM swarm_hive.agent_forks pai
           JOIN swarm_hive.projects p ON p.id = pai.project_id
           JOIN swarm_hive.agent_instances ai ON ai.id = pai.agent_instance_id
          WHERE pai.id = $1 AND pai.unbound_at IS NULL
          FOR UPDATE OF pai, ai`,
        [forkId],
      );
      const row = assignment.rows[0];
      if (!row) throw new Error("Agent Fork was not found");
      if (row.instance_status === "disabled") {
        throw new ConflictError("Agent Instance is disabled");
      }
      const event = await client.query<{ id: string }>(
        `INSERT INTO swarm_hive.inbox_events(
           source, external_event_id, project_id, event_type, status, processed_at
         ) VALUES ('swarm_hive_ui', $1, $2, 'development_requested', 'completed', now())
         RETURNING id`,
        [`development-${randomUUID()}`, row.project_id],
      );
      const run = await client.query<{ id: string; session_id: string }>(
        `INSERT INTO swarm_hive.agent_runs(
           project_id, agent_instance_id, agent_session_id,
           trigger_event_id, status, task_summary
         ) SELECT $1, $2, session.id, $3, 'queued', $4
             FROM swarm_hive.agent_sessions session
            WHERE session.agent_fork_id = $5
              AND session.status IN ('active', 'waiting')
            ORDER BY session.created_at DESC LIMIT 1
         RETURNING id, agent_session_id AS session_id`,
        [
          row.project_id,
          row.agent_instance_id,
          event.rows[0]?.id,
          `开发飞书需求 ${row.work_item_id}`,
          forkId,
        ],
      );
      const runId = run.rows[0]?.id;
      if (!runId) throw new Error("Agent Run was not created");
      await client.query(
        `UPDATE swarm_hive.agent_instances SET last_active_at = now() WHERE id = $1`,
        [row.agent_instance_id],
      );
      await client.query("COMMIT");
      return {
        runId,
        projectId: row.project_id,
        agentInstanceId: row.agent_instance_id,
        forkId,
        sessionId: run.rows[0]!.session_id,
        status: "queued",
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async cancelAgentRun(runId: string): Promise<CancelAgentRunResult | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const cancelled = await client.query<{ agent_instance_id: string }>(
        `WITH cancelled_run AS (
           UPDATE swarm_hive.agent_runs
              SET status = 'cancelled', finished_at = now()
            WHERE id = $1
              AND status IN ('queued', 'running', 'waiting_user')
            RETURNING agent_instance_id
         ), touched_instance AS (
           UPDATE swarm_hive.agent_instances
              SET last_active_at = now()
            WHERE id = (SELECT agent_instance_id FROM cancelled_run)
            RETURNING id
         )
         SELECT agent_instance_id FROM cancelled_run`,
        [runId],
      );
      const agentInstanceId = cancelled.rows[0]?.agent_instance_id;
      if (!agentInstanceId) {
        await client.query("ROLLBACK");
        return null;
      }
      await client.query("COMMIT");
      await this.appendAgentRunEvent({
        runId,
        eventType: "agent_cancelled",
        level: "warning",
        title: "用户结束了本次运行",
        detail: "可以重新启动 Agent；新 Run 将使用全新的对话，工作区内容保持不变",
        data: { state: "completed" },
      }).catch(() => undefined);
      return { runId, agentInstanceId, status: "cancelled" };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async getAgentRunExecutionContext(runId: string): Promise<AgentRunExecutionContext | null> {
    const result = await this.pool.query<{
      run_id: string;
      project_id: string;
      assignment_id: string;
      session_id: string;
      external_url: string;
      source: string;
      external_project_key: string;
      external_work_item_type: string;
      external_project_id: string;
      agent_instance_id: string;
      spec_key: string;
      spec_version: number;
      role: string;
      thread_id: string;
      workspace_key: string;
    }>(
      `SELECT r.id AS run_id, r.project_id, fork.id AS assignment_id,
              session.id AS session_id,
              p.source, p.external_url, p.external_project_key, p.external_work_item_type,
              p.external_project_id, ai.id AS agent_instance_id,
              ai.spec_key, ai.spec_version, fork.role,
              session.thread_id, fork.workspace_key
         FROM swarm_hive.agent_runs r
         JOIN swarm_hive.agent_sessions session ON session.id = r.agent_session_id
         JOIN swarm_hive.agent_forks fork ON fork.id = session.agent_fork_id
         JOIN swarm_hive.agent_instances ai ON ai.id = r.agent_instance_id
         JOIN swarm_hive.projects p ON p.id = r.project_id
        WHERE r.id = $1`,
      [runId],
    );
    const row = result.rows[0];
    if (!row?.external_url) return null;
    return {
      runId: row.run_id,
      projectId: row.project_id,
      forkId: row.assignment_id,
      sessionId: row.session_id,
      sourceUrl: row.external_url,
      source: row.source,
      projectKey: row.external_project_key,
      workItemType: row.external_work_item_type,
      workItemId: row.external_project_id,
      agentInstanceId: row.agent_instance_id,
      specKey: row.spec_key,
      specVersion: row.spec_version,
      role: row.role,
      threadId: row.thread_id,
      workspaceKey: row.workspace_key,
    };
  }

  async getAgentSessionMemory(
    sessionId: string,
  ): Promise<AgentSessionMemorySnapshot | null> {
    const result = await this.pool.query<{
      memory_snapshot: string | null;
      memory_sha256: string | null;
    }>(
      `SELECT memory_snapshot, memory_sha256
         FROM swarm_hive.agent_sessions
        WHERE id = $1`,
      [sessionId],
    );
    const row = result.rows[0];
    if (!row) throw new Error("Agent Session was not found");
    return row.memory_snapshot !== null && row.memory_sha256 !== null
      ? { content: row.memory_snapshot, sha256: row.memory_sha256 }
      : null;
  }

  /** Pin the first observed Instance memory as immutable context for a Session. */
  async pinAgentSessionMemory(
    sessionId: string,
    candidate: AgentSessionMemorySnapshot,
  ): Promise<AgentSessionMemorySnapshot> {
    const pinned = await this.pool.query<{
      memory_snapshot: string;
      memory_sha256: string;
    }>(
      `UPDATE swarm_hive.agent_sessions
          SET memory_snapshot = $2, memory_sha256 = $3, updated_at = now()
        WHERE id = $1 AND memory_snapshot IS NULL
        RETURNING memory_snapshot, memory_sha256`,
      [sessionId, candidate.content, candidate.sha256],
    );
    const row = pinned.rows[0];
    if (row) return { content: row.memory_snapshot, sha256: row.memory_sha256 };
    const existing = await this.getAgentSessionMemory(sessionId);
    if (!existing) throw new Error("Agent Session memory could not be pinned");
    return existing;
  }

  async updateAgentRun(input: {
    runId: string;
    status: "running" | "waiting_user" | "succeeded" | "failed";
    resultSummary?: string;
    mergeRequestUrl?: string;
    errorCode?: string;
    errorMessage?: string;
  }): Promise<boolean> {
    const updated = await this.pool.query(
      `WITH updated_run AS (
         UPDATE swarm_hive.agent_runs run
            SET status = $2,
                result_summary = coalesce($3, result_summary),
                merge_request_url = coalesce($4, merge_request_url),
                error_code = $5,
                error_message = $6,
                started_at = CASE WHEN $2 = 'running' THEN coalesce(started_at, now()) ELSE started_at END,
                finished_at = CASE WHEN $2 IN ('succeeded','failed') THEN now() ELSE NULL END
          WHERE id = $1
            AND status IN ('queued', 'running', 'waiting_user')
          RETURNING agent_instance_id, agent_session_id
       ), updated_session AS (
         UPDATE swarm_hive.agent_sessions session
            SET status = CASE WHEN $2 = 'waiting_user' THEN 'waiting' ELSE 'active' END,
                last_active_at = now()
          WHERE session.id = (SELECT agent_session_id FROM updated_run)
          RETURNING id
       )
       UPDATE swarm_hive.agent_instances
          SET last_active_at = now()
        WHERE id = (SELECT agent_instance_id FROM updated_run)
        RETURNING id`,
      [
        input.runId,
        input.status,
        input.resultSummary ?? null,
        input.mergeRequestUrl ?? null,
        input.errorCode ?? null,
        input.errorMessage ?? null,
      ],
    );
    return updated.rowCount === 1;
  }

  async resumeWaitingAgentRun(runId: string): Promise<boolean> {
    const updated = await this.pool.query(
      `WITH updated_run AS (
         UPDATE swarm_hive.agent_runs run
            SET status = 'running', finished_at = NULL,
                error_code = NULL, error_message = NULL
          WHERE run.id = $1 AND run.status = 'waiting_user'
            AND EXISTS (
              SELECT 1 FROM swarm_hive.agent_instances instance
               WHERE instance.id = run.agent_instance_id
                 AND instance.status = 'active'
            )
          RETURNING agent_instance_id, agent_session_id
       ), updated_session AS (
         UPDATE swarm_hive.agent_sessions session
            SET status = 'active', last_active_at = now()
          WHERE session.id = (SELECT agent_session_id FROM updated_run)
          RETURNING id
       )
       UPDATE swarm_hive.agent_instances
          SET last_active_at = now()
        WHERE id = (SELECT agent_instance_id FROM updated_run)
          AND status = 'active'
        RETURNING id`,
      [runId],
    );
    return updated.rowCount === 1;
  }

  async resumeAgentRunForEvents(
    runId: string,
  ): Promise<"running" | "waiting_user" | "failed" | null> {
    const updated = await this.pool.query<{
      previous_status: "running" | "waiting_user" | "failed";
    }>(
      `WITH candidate AS (
         SELECT run.id, run.agent_instance_id, run.status AS previous_status
           FROM swarm_hive.agent_runs run
           JOIN swarm_hive.agent_instances instance
             ON instance.id = run.agent_instance_id
            AND instance.status = 'active'
          WHERE run.id = $1
            AND run.status IN ('running', 'waiting_user', 'failed')
          FOR UPDATE
       ), updated_run AS (
         UPDATE swarm_hive.agent_runs run
            SET status = 'running', finished_at = NULL,
                error_code = NULL, error_message = NULL
           FROM candidate
          WHERE run.id = candidate.id
         RETURNING run.agent_instance_id, candidate.previous_status
       ), updated_instance AS (
         UPDATE swarm_hive.agent_instances instance
            SET last_active_at = now()
           WHERE instance.id = (SELECT agent_instance_id FROM updated_run)
         RETURNING instance.id
       )
       SELECT previous_status FROM updated_run
        WHERE EXISTS (SELECT 1 FROM updated_instance)`,
      [runId],
    );
    return updated.rows[0]?.previous_status ?? null;
  }

  async appendAgentRunEvent(input: {
    runId: string;
    eventType: string;
    level?: "debug" | "info" | "warning" | "error";
    title: string;
    detail?: string;
    data?: Record<string, unknown>;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO swarm_hive.agent_run_events(
         agent_run_id, sequence_no, event_type, level, title, detail, data
       )
       SELECT $1, coalesce(max(sequence_no), 0) + 1, $2, $3, $4, $5, $6::jsonb
         FROM swarm_hive.agent_run_events
        WHERE agent_run_id = $1`,
      [
        input.runId,
        input.eventType,
        input.level ?? "info",
        input.title,
        input.detail ?? null,
        JSON.stringify(input.data ?? {}),
      ],
    );
  }

  getReportFileContext(reportId: string) {
    return new PostgresWorkflowCoordinationRepository(this.pool)
      .getReportFileContext(reportId);
  }

  async runExists(runId: string): Promise<boolean> {
    const result = await this.pool.query("SELECT 1 FROM swarm_hive.agent_runs WHERE id = $1", [runId]);
    return result.rowCount === 1;
  }

  private async getRunEventsWithClient(
    queryable: Pick<PoolClient, "query">,
    runId: string,
    afterSequence: number,
    limit: number,
  ): Promise<RunEventsResponse> {
    const result = await queryable.query<{
      sequence_no: string;
      event_type: string;
      level: RunEventDto["level"];
      title: string;
      detail: string | null;
      data: unknown;
      created_at: Date;
    }>(
      `SELECT sequence_no, event_type, level, title, detail, data, created_at
         FROM swarm_hive.agent_run_events
        WHERE agent_run_id = $1 AND sequence_no > $2 AND visible_to_user
        ORDER BY sequence_no ASC LIMIT $3`,
      [runId, afterSequence, limit],
    );
    const items = result.rows.map(mapRunEvent);
    return { items, lastSequence: items.at(-1)?.sequenceNo ?? afterSequence };
  }
}
