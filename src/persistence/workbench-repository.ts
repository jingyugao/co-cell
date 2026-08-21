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
} from "../contracts/workbench.js";
import type {
  AgentAssignmentResult,
  StartAgentRunResult,
} from "../contracts/requirements.js";

export interface AgentRunExecutionContext {
  runId: string;
  projectId: string;
  assignmentId: string;
  sourceUrl: string;
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
      thread_id: string;
      last_active_at: Date | null;
      created_at: Date;
      assignment_id: string | null;
      role: string | null;
      is_primary: boolean | null;
      bound_at: Date | null;
      project_id: string | null;
      source: string | null;
      external_project_id: string | null;
      external_url: string | null;
    }>(
      `SELECT ai.id, ai.spec_key, ai.spec_version, ai.status,
              ai.workspace_key, ai.thread_id, ai.last_active_at, ai.created_at,
              pai.id AS assignment_id, pai.role, pai.is_primary, pai.bound_at,
              p.id AS project_id, p.source, p.external_project_id, p.external_url
         FROM agent_staff.agent_instances ai
         LEFT JOIN agent_staff.project_agent_instances pai
           ON pai.agent_instance_id = ai.id AND pai.unbound_at IS NULL
         LEFT JOIN agent_staff.projects p ON p.id = pai.project_id
        WHERE ai.id = $1`,
      [agentInstanceId],
    );
    const row = instance.rows[0];
    if (!row) return null;

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
         FROM agent_staff.agent_instance_runs r
         LEFT JOIN agent_staff.inbox_events e ON e.id = r.trigger_event_id
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
    const activeRun = runs.rows.find((run) =>
      run.status === "queued" || run.status === "running" || run.status === "waiting_user"
    );
    const events = activeRun
      ? (await this.getRunEvents(activeRun.id, 0, 200)).items
      : [];
    return {
      agentInstance: {
        id: row.id,
        specKey: row.spec_key,
        specVersion: row.spec_version,
        status: row.status,
        workspaceKey: row.workspace_key,
        threadId: row.thread_id,
        lastActiveAt: row.last_active_at ? iso(row.last_active_at) : null,
        createdAt: iso(row.created_at),
      },
      assignment:
        row.assignment_id && row.role && row.bound_at && row.project_id &&
        row.source && row.external_project_id
          ? {
              id: row.assignment_id,
              role: row.role,
              isPrimary: Boolean(row.is_primary),
              boundAt: iso(row.bound_at),
              project: {
                id: row.project_id,
                source: row.source,
                externalProjectId: row.external_project_id,
                externalUrl: row.external_url,
              },
            }
          : null,
      currentRun: activeRun
        ? {
            id: activeRun.id,
            status: activeRun.status,
            taskSummary: activeRun.task_summary,
            startedAt: activeRun.started_at ? iso(activeRun.started_at) : null,
            events,
          }
        : null,
      recentRuns,
    };
  }

  async projectExists(projectId: string): Promise<boolean> {
    const result = await this.pool.query("SELECT 1 FROM agent_staff.projects WHERE id = $1", [projectId]);
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
         FROM agent_staff.projects p
         LEFT JOIN agent_staff.project_agent_instances pai
           ON pai.project_id = p.id AND pai.unbound_at IS NULL AND pai.is_primary
         LEFT JOIN agent_staff.agent_instances ai ON ai.id = pai.agent_instance_id
         LEFT JOIN LATERAL (
           SELECT r.id, r.status, r.task_summary
             FROM agent_staff.agent_instance_runs r
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
           FROM agent_staff.projects
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
        status: NonNullable<ProjectWorkbench["primaryAgentInstance"]>["status"];
        workspace_key: string;
        thread_id: string;
        last_active_at: Date | null;
      }>(
        `SELECT ai.id, ai.spec_key, ai.spec_version, ai.status,
                ai.workspace_key, ai.thread_id, ai.last_active_at
           FROM agent_staff.project_agent_instances pai
           JOIN agent_staff.agent_instances ai ON ai.id = pai.agent_instance_id
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
           FROM agent_staff.agent_instance_runs
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
           FROM agent_staff.agent_instance_runs r
           LEFT JOIN agent_staff.inbox_events e ON e.id = r.trigger_event_id
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
           FROM agent_staff.agent_instance_runs r
           LEFT JOIN agent_staff.inbox_events e ON e.id = r.trigger_event_id
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
           FROM agent_staff.inbox_events
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
        primaryAgentInstance: instanceRow
          ? {
              id: instanceRow.id,
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
         FROM agent_staff.agent_instance_runs r
         LEFT JOIN agent_staff.inbox_events e ON e.id = r.trigger_event_id
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
         FROM agent_staff.agent_instance_runs r
         LEFT JOIN agent_staff.inbox_events e ON e.id = r.trigger_event_id
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
         FROM agent_staff.inbox_events
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
         FROM agent_staff.agent_instance_runs r
         JOIN agent_staff.projects p ON p.id = r.project_id
         LEFT JOIN agent_staff.inbox_events e ON e.id = r.trigger_event_id
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
         FROM agent_staff.inbox_events e
         LEFT JOIN agent_staff.projects p ON p.id = e.project_id
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
                count(*) FILTER (WHERE status = 'running')::text AS running_instances
           FROM agent_staff.agent_instances
          WHERE spec_key = $1`,
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
                ai.workspace_key, ai.last_active_at,
                active_run.id AS run_id, active_run.status AS run_status,
                active_run.task_summary
           FROM agent_staff.agent_instances ai
           JOIN agent_staff.project_agent_instances pai
             ON pai.agent_instance_id = ai.id AND pai.unbound_at IS NULL
           JOIN agent_staff.projects p
             ON p.id = pai.project_id AND p.status = 'active'
           LEFT JOIN LATERAL (
             SELECT r.id, r.status, r.task_summary
               FROM agent_staff.agent_instance_runs r
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
        associationId: row.association_id,
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

  async createAgentAssignment(input: {
    sourceUrl: string;
    externalProjectKey: string;
    externalWorkItemType: string;
    externalWorkItemId: string;
    specKey: string;
    specVersion: number;
    role: string;
    threadId: string;
    workspaceKey: string;
  }): Promise<AgentAssignmentResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const project = await client.query<{ id: string }>(
        `INSERT INTO agent_staff.projects(
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
      const instance = await client.query<{ id: string }>(
        `INSERT INTO agent_staff.agent_instances(
           spec_key, spec_version, thread_id, workspace_key, status
         ) VALUES ($1, $2, $3, $4, 'idle')
         RETURNING id`,
        [input.specKey, input.specVersion, input.threadId, input.workspaceKey],
      );
      const agentInstanceId = instance.rows[0]?.id;
      if (!agentInstanceId) throw new Error("Agent Instance was not created");
      const assignment = await client.query<{ id: string }>(
        `INSERT INTO agent_staff.project_agent_instances(
           project_id, agent_instance_id, role, is_primary
         ) VALUES (
           $1, $2, $3,
           NOT EXISTS (
             SELECT 1 FROM agent_staff.project_agent_instances
              WHERE project_id = $1 AND unbound_at IS NULL AND is_primary
           )
         )
         RETURNING id`,
        [projectId, agentInstanceId, input.role],
      );
      const assignmentId = assignment.rows[0]?.id;
      if (!assignmentId) throw new Error("Agent Assignment was not created");
      await client.query("COMMIT");
      return {
        projectId,
        assignmentId,
        agentInstance: {
          id: agentInstanceId,
          specKey: input.specKey,
          specVersion: input.specVersion,
          role: input.role,
          workspaceKey: input.workspaceKey,
          threadId: input.threadId,
          status: "idle",
        },
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async listAgentAssignments(input: {
    externalProjectKey: string;
    externalWorkItemType: string;
    externalWorkItemId: string;
  }): Promise<AgentAssignmentResult[]> {
    const result = await this.pool.query<{
      project_id: string;
      assignment_id: string;
      agent_instance_id: string;
      spec_key: string;
      spec_version: number;
      role: string;
      workspace_key: string;
      thread_id: string;
      status: AgentAssignmentResult["agentInstance"]["status"];
    }>(
      `SELECT p.id AS project_id, pai.id AS assignment_id,
              ai.id AS agent_instance_id, ai.spec_key, ai.spec_version,
              pai.role,
              ai.workspace_key, ai.thread_id, ai.status
         FROM agent_staff.projects p
         JOIN agent_staff.project_agent_instances pai
           ON pai.project_id = p.id AND pai.unbound_at IS NULL
         JOIN agent_staff.agent_instances ai ON ai.id = pai.agent_instance_id
        WHERE p.source = 'feishu_project'
          AND p.external_project_key = $1
          AND p.external_work_item_type = $2
          AND p.external_project_id = $3
        ORDER BY pai.bound_at ASC`,
      [input.externalProjectKey, input.externalWorkItemType, input.externalWorkItemId],
    );
    return result.rows.map((row) => ({
        projectId: row.project_id,
        assignmentId: row.assignment_id,
        agentInstance: {
          id: row.agent_instance_id,
          specKey: row.spec_key,
          specVersion: row.spec_version,
          role: row.role,
          workspaceKey: row.workspace_key,
          threadId: row.thread_id,
          status: row.status,
        },
      }));
  }

  async createAgentRun(assignmentId: string): Promise<StartAgentRunResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const assignment = await client.query<{
        project_id: string;
        agent_instance_id: string;
        work_item_id: string;
      }>(
        `SELECT pai.project_id, pai.agent_instance_id,
                p.external_project_id AS work_item_id
           FROM agent_staff.project_agent_instances pai
           JOIN agent_staff.projects p ON p.id = pai.project_id
          WHERE pai.id = $1 AND pai.unbound_at IS NULL
          FOR UPDATE`,
        [assignmentId],
      );
      const row = assignment.rows[0];
      if (!row) throw new Error("Agent Assignment was not found");
      const event = await client.query<{ id: string }>(
        `INSERT INTO agent_staff.inbox_events(
           source, external_event_id, project_id, event_type, status, processed_at
         ) VALUES ('agent_staff_ui', $1, $2, 'development_requested', 'completed', now())
         RETURNING id`,
        [`development-${randomUUID()}`, row.project_id],
      );
      const run = await client.query<{ id: string }>(
        `INSERT INTO agent_staff.agent_instance_runs(
           project_id, agent_instance_id, trigger_event_id, status, task_summary
         ) VALUES ($1, $2, $3, 'queued', $4)
         RETURNING id`,
        [
          row.project_id,
          row.agent_instance_id,
          event.rows[0]?.id,
          `开发飞书需求 ${row.work_item_id}`,
        ],
      );
      const runId = run.rows[0]?.id;
      if (!runId) throw new Error("Agent Run was not created");
      await client.query(
        `UPDATE agent_staff.agent_instances SET status = 'queued', last_active_at = now()
          WHERE id = $1`,
        [row.agent_instance_id],
      );
      await client.query("COMMIT");
      return {
        runId,
        projectId: row.project_id,
        agentInstanceId: row.agent_instance_id,
        status: "queued",
      };
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
      external_url: string;
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
      `SELECT r.id AS run_id, r.project_id, pai.id AS assignment_id,
              p.external_url, p.external_project_key, p.external_work_item_type,
              p.external_project_id, ai.id AS agent_instance_id,
              ai.spec_key, ai.spec_version, pai.role,
              ai.thread_id, ai.workspace_key
         FROM agent_staff.agent_instance_runs r
         JOIN agent_staff.agent_instances ai ON ai.id = r.agent_instance_id
         JOIN agent_staff.project_agent_instances pai
           ON pai.project_id = r.project_id
          AND pai.agent_instance_id = r.agent_instance_id
          AND pai.unbound_at IS NULL
         JOIN agent_staff.projects p ON p.id = r.project_id
        WHERE r.id = $1`,
      [runId],
    );
    const row = result.rows[0];
    if (!row?.external_url) return null;
    return {
      runId: row.run_id,
      projectId: row.project_id,
      assignmentId: row.assignment_id,
      sourceUrl: row.external_url,
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

  async updateAgentRun(input: {
    runId: string;
    status: "running" | "waiting_user" | "succeeded" | "failed";
    resultSummary?: string;
    mergeRequestUrl?: string;
    errorCode?: string;
    errorMessage?: string;
  }): Promise<void> {
    const instanceStatus = input.status === "running"
      ? "running"
      : input.status === "waiting_user"
        ? "waiting"
        : input.status === "failed" ? "failed" : "idle";
    await this.pool.query(
      `WITH updated_run AS (
         UPDATE agent_staff.agent_instance_runs
            SET status = $2,
                result_summary = coalesce($3, result_summary),
                merge_request_url = coalesce($4, merge_request_url),
                error_code = $5,
                error_message = $6,
                started_at = CASE WHEN $2 = 'running' THEN coalesce(started_at, now()) ELSE started_at END,
                finished_at = CASE WHEN $2 IN ('succeeded','failed') THEN now() ELSE NULL END
          WHERE id = $1
          RETURNING agent_instance_id
       )
       UPDATE agent_staff.agent_instances
          SET status = $7, last_active_at = now()
        WHERE id = (SELECT agent_instance_id FROM updated_run)`,
      [
        input.runId,
        input.status,
        input.resultSummary ?? null,
        input.mergeRequestUrl ?? null,
        input.errorCode ?? null,
        input.errorMessage ?? null,
        instanceStatus,
      ],
    );
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
      `INSERT INTO agent_staff.agent_instance_run_events(
         agent_instance_run_id, sequence_no, event_type, level, title, detail, data
       )
       SELECT $1, coalesce(max(sequence_no), 0) + 1, $2, $3, $4, $5, $6::jsonb
         FROM agent_staff.agent_instance_run_events
        WHERE agent_instance_run_id = $1`,
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

  async runExists(runId: string): Promise<boolean> {
    const result = await this.pool.query("SELECT 1 FROM agent_staff.agent_instance_runs WHERE id = $1", [runId]);
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
         FROM agent_staff.agent_instance_run_events
        WHERE agent_instance_run_id = $1 AND sequence_no > $2 AND visible_to_user
        ORDER BY sequence_no ASC LIMIT $3`,
      [runId, afterSequence, limit],
    );
    const items = result.rows.map(mapRunEvent);
    return { items, lastSequence: items.at(-1)?.sequenceNo ?? afterSequence };
  }
}
