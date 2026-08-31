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
  AgentSeatResult,
  CancelAgentRunResult,
  StartAgentRunResult,
} from "../contracts/projects.js";
import { ConflictError } from "../application/errors.js";

export interface AgentRunExecutionContext {
  runId: string;
  projectId: string;
  seatId: string;
  sessionId: string;
  sourceUrl: string;
  source: string;
  projectKey: string;
  workItemType: string;
  workItemId: string;
  agentInstanceId: string;
  specKey: string;
  specVersion: number;
  responsibility: string;
  isCoordinator: boolean;
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
      instance_key: string;
      status: AgentInstanceDetail["agentInstance"]["status"];
      home_key: string;
      last_active_at: Date | null;
      created_at: Date;
    }>(
      `SELECT ai.id, ai.spec_key, ai.spec_version, ai.instance_key, ai.status,
              ai.home_key, ai.last_active_at, ai.created_at
         FROM swarm_hive.agent_instances ai
        WHERE ai.id = $1`,
      [agentInstanceId],
    );
    const row = instance.rows[0];
    if (!row) return null;

    const seats = await this.pool.query<{
      id: string;
      responsibility: string;
      is_coordinator: boolean;
      workspace_key: string;
      assigned_at: Date;
      project_id: string;
      source: string;
      external_project_id: string;
      external_url: string | null;
      session_id: string;
      session_status: AgentInstanceDetail["seats"][number]["session"]["status"];
      thread_id: string;
      session_last_active_at: Date | null;
      run_id: string | null;
      run_status: RunStatus | null;
      task_summary: string | null;
      started_at: Date | null;
    }>(
      `SELECT seat.id, seat.responsibility, seat.is_coordinator, seat.workspace_key,
              seat.assigned_at, project.id AS project_id, project.source,
              project.external_project_id, project.external_url,
              session.id AS session_id, session.status AS session_status,
              session.thread_id, session.last_active_at AS session_last_active_at,
              active_run.id AS run_id, active_run.status AS run_status,
              active_run.task_summary, active_run.started_at
         FROM swarm_hive.agent_seats seat
         JOIN swarm_hive.projects project ON project.id = seat.project_id
         JOIN swarm_hive.agent_sessions session
           ON session.agent_seat_id = seat.id
          AND session.status IN ('active', 'waiting')
         LEFT JOIN LATERAL (
           SELECT run.id, run.status, run.task_summary, run.started_at
             FROM swarm_hive.agent_runs run
            WHERE run.agent_session_id = session.id
              AND run.status IN ('queued', 'running', 'waiting_user')
            ORDER BY run.created_at DESC LIMIT 1
         ) active_run ON true
        WHERE seat.agent_instance_id = $1 AND seat.released_at IS NULL
        ORDER BY seat.assigned_at DESC`,
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
    const tasks = await this.pool.query<{
      id: string;
      title: string;
      status: AgentInstanceDetail["tasks"][number]["status"];
      blocked_reason: string | null;
      result: string | null;
      updated_at: Date;
      seat_id: string;
      responsibility: string;
      project_id: string;
      project_name: string | null;
      external_project_id: string;
    }>(
      `SELECT task.id, task.title, task.status, task.blocked_reason, task.result,
              task.updated_at, seat.id AS seat_id, seat.responsibility,
              project.id AS project_id, project.name AS project_name,
              project.external_project_id
         FROM swarm_hive.project_tasks task
         JOIN swarm_hive.agent_seats seat ON seat.id = task.assignee_agent_seat_id
         JOIN swarm_hive.projects project ON project.id = task.project_id
        WHERE seat.agent_instance_id = $1
        ORDER BY task.updated_at DESC, task.id DESC
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
        instanceKey: row.instance_key,
        status: row.status,
        homeKey: row.home_key,
        lastActiveAt: row.last_active_at ? iso(row.last_active_at) : null,
        createdAt: iso(row.created_at),
      },
      seats: seats.rows.map((seat) => ({
        id: seat.id,
        responsibility: seat.responsibility,
        isCoordinator: seat.is_coordinator,
        workspaceKey: seat.workspace_key,
        assignedAt: iso(seat.assigned_at),
        project: {
          id: seat.project_id,
          source: seat.source,
          externalProjectId: seat.external_project_id,
          externalUrl: seat.external_url,
        },
        session: {
          id: seat.session_id,
          status: seat.session_status,
          threadId: seat.thread_id,
          lastActiveAt: seat.session_last_active_at
            ? iso(seat.session_last_active_at)
            : null,
        },
        currentRun: seat.run_id && seat.run_status
          ? {
              id: seat.run_id,
              status: seat.run_status,
              taskSummary: seat.task_summary,
              startedAt: seat.started_at ? iso(seat.started_at) : null,
            }
          : null,
      })),
      tasks: tasks.rows.map((task) => ({
        id: task.id,
        title: task.title,
        status: task.status,
        blockedReason: task.blocked_reason,
        result: task.result,
        updatedAt: iso(task.updated_at),
        seat: { id: task.seat_id, responsibility: task.responsibility },
        project: {
          id: task.project_id,
          name: task.project_name,
          externalProjectId: task.external_project_id,
        },
      })),
      recentRuns,
    };
  }

  async listAgentInstanceDetailsBySpec(specKey: string): Promise<AgentInstanceDetail[]> {
    const result = await this.pool.query<{ id: string }>(
      `SELECT id
         FROM swarm_hive.agent_instances
        WHERE spec_key = $1
        ORDER BY created_at ASC, id ASC`,
      [specKey],
    );
    const details = await Promise.all(result.rows.map((row) => this.getAgentInstanceDetail(row.id)));
    return details.filter((detail): detail is AgentInstanceDetail => detail !== null);
  }

  async getAgentSeatDetail(agentSeatId: string): Promise<AgentInstanceDetail | null> {
    const result = await this.pool.query<{ agent_instance_id: string }>(
      `SELECT agent_instance_id
         FROM swarm_hive.agent_seats
        WHERE id = $1 AND released_at IS NULL`,
      [agentSeatId],
    );
    const agentInstanceId = result.rows[0]?.agent_instance_id;
    return agentInstanceId ? this.getAgentInstanceDetail(agentInstanceId) : null;
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
      agent_seat_id: string | null;
      responsibility: string | null;
      agent_instance_id: string | null;
      agent_instance_status:
        NonNullable<ProjectSummary["coordinatorSeat"]>["agentInstance"]["status"] | null;
      spec_key: string | null;
      instance_key: string | null;
      run_id: string | null;
      run_status: NonNullable<ProjectSummary["currentRun"]>["status"] | null;
      task_summary: string | null;
    }>(
      `SELECT p.id, p.source, p.external_project_id, p.external_url,
              p.name, p.status, p.updated_at,
              seat.id AS agent_seat_id, seat.responsibility,
              ai.id AS agent_instance_id, ai.status AS agent_instance_status,
              ai.spec_key, ai.instance_key, active_run.id AS run_id,
              active_run.status AS run_status, active_run.task_summary
         FROM swarm_hive.projects p
         LEFT JOIN swarm_hive.agent_seats seat
           ON seat.project_id = p.id AND seat.released_at IS NULL AND seat.is_coordinator
         LEFT JOIN swarm_hive.agent_instances ai ON ai.id = seat.agent_instance_id
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
      coordinatorSeat:
        row.agent_seat_id && row.responsibility && row.agent_instance_id &&
        row.agent_instance_status && row.spec_key && row.instance_key
          ? {
              id: row.agent_seat_id,
              responsibility: row.responsibility,
              agentInstance: {
                id: row.agent_instance_id,
                status: row.agent_instance_status,
                specKey: row.spec_key,
                instanceKey: row.instance_key,
              },
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
        instance_key: string;
        home_key: string;
        agent_instance_id: string;
        session_id: string;
        responsibility: string;
        status:
          NonNullable<ProjectWorkbench["coordinatorSeat"]>["agentInstance"]["status"];
        workspace_key: string;
        thread_id: string;
        last_active_at: Date | null;
      }>(
        `SELECT seat.id, ai.id AS agent_instance_id, session.id AS session_id,
                seat.responsibility, ai.spec_key, ai.spec_version,
                ai.instance_key, ai.home_key, ai.status,
                seat.workspace_key, session.thread_id, ai.last_active_at
           FROM swarm_hive.agent_seats seat
           JOIN swarm_hive.agent_instances ai ON ai.id = seat.agent_instance_id
           JOIN swarm_hive.agent_sessions session
             ON session.agent_seat_id = seat.id
            AND session.status IN ('active', 'waiting')
          WHERE seat.project_id = $1 AND seat.released_at IS NULL AND seat.is_coordinator
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
        coordinatorSeat: instanceRow
          ? {
              id: instanceRow.id,
              responsibility: instanceRow.responsibility,
              workspaceKey: instanceRow.workspace_key,
              agentInstance: {
                id: instanceRow.agent_instance_id,
                instanceKey: instanceRow.instance_key,
                specKey: instanceRow.spec_key,
                specVersion: instanceRow.spec_version,
                status: instanceRow.status,
                homeKey: instanceRow.home_key,
                lastActiveAt: instanceRow.last_active_at
                  ? iso(instanceRow.last_active_at)
                  : null,
              },
              session: {
                id: instanceRow.session_id,
                threadId: instanceRow.thread_id,
              },
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
    const [statisticsResult, seatsResult] = await Promise.all([
      this.pool.query<{ instances: string }>(
        `SELECT count(*)::text AS instances
           FROM swarm_hive.agent_instances instance
          WHERE instance.spec_key = $1`,
        [specKey],
      ),
      this.pool.query<{
        seat_id: string;
        responsibility: string;
        is_coordinator: boolean;
        assigned_at: Date;
        project_id: string;
        project_name: string | null;
        external_project_id: string;
        project_status: AgentSpecUsage["activeSeats"][number]["project"]["status"];
        instance_id: string;
        instance_key: string;
        spec_version: number;
        instance_status: AgentSpecUsage["activeSeats"][number]["agentInstance"]["status"];
        home_key: string;
        workspace_key: string;
        last_active_at: Date | null;
        run_id: string | null;
        run_status: NonNullable<AgentSpecUsage["activeSeats"][number]["currentRun"]>["status"] | null;
        task_summary: string | null;
      }>(
        `SELECT seat.id AS seat_id, seat.responsibility, seat.is_coordinator, seat.assigned_at,
                p.id AS project_id, p.name AS project_name,
                p.external_project_id, p.status AS project_status,
                ai.id AS instance_id, ai.instance_key, ai.spec_version,
                ai.status AS instance_status, ai.home_key,
                seat.workspace_key, ai.last_active_at,
                active_run.id AS run_id, active_run.status AS run_status,
                active_run.task_summary
           FROM swarm_hive.agent_instances ai
           JOIN swarm_hive.agent_seats seat
             ON seat.agent_instance_id = ai.id AND seat.released_at IS NULL
           JOIN swarm_hive.projects p
             ON p.id = seat.project_id AND p.status = 'active'
           JOIN swarm_hive.agent_sessions session
             ON session.agent_seat_id = seat.id
            AND session.status IN ('active', 'waiting')
           LEFT JOIN LATERAL (
             SELECT r.id, r.status, r.task_summary
               FROM swarm_hive.agent_runs r
              WHERE r.agent_session_id = session.id
                AND r.status IN ('queued', 'running', 'waiting_user')
              ORDER BY r.created_at DESC LIMIT 1
           ) active_run ON true
          WHERE ai.spec_key = $1
          ORDER BY p.updated_at DESC, seat.is_coordinator DESC, seat.assigned_at ASC`,
        [specKey],
      ),
    ]);
    const statistics = statisticsResult.rows[0] ?? {
      instances: "0",
    };
    return {
      statistics: {
        instances: Number(statistics.instances),
        activeSeats: seatsResult.rows.length,
        runningSeats: seatsResult.rows.filter((row) => row.run_status === "running").length,
      },
      activeSeats: seatsResult.rows.map((row) => ({
        seatId: row.seat_id,
        responsibility: row.responsibility,
        isCoordinator: row.is_coordinator,
        assignedAt: iso(row.assigned_at),
        project: {
          id: row.project_id,
          name: row.project_name,
          externalProjectId: row.external_project_id,
          status: row.project_status,
        },
        agentInstance: {
          id: row.instance_id,
          instanceKey: row.instance_key,
          specVersion: row.spec_version,
          status: row.instance_status,
          homeKey: row.home_key,
          lastActiveAt: row.last_active_at ? iso(row.last_active_at) : null,
        },
        workspaceKey: row.workspace_key,
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

  async createAgentSeat(input: {
    sourceUrl: string;
    externalProjectKey: string;
    externalWorkItemType: string;
    externalWorkItemId: string;
    specKey: string;
    specVersion: number;
    responsibility: string;
    isCoordinator?: boolean;
  }): Promise<AgentSeatResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const isCoordinator = input.isCoordinator ?? true;
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
      const existingCoordinator = await client.query<{ id: string }>(
        `SELECT id FROM swarm_hive.agent_seats
          WHERE project_id = $1 AND released_at IS NULL AND is_coordinator
          LIMIT 1`,
        [projectId],
      );
      if (!isCoordinator && existingCoordinator.rows.length === 0) {
        throw new ConflictError("The first Agent Seat in a Project must be the Coordinator");
      }
      const instanceKey = "default";
      const homeKey = `${input.specKey}:${instanceKey}`;
      const instance = await client.query<{ id: string; status: AgentSeatResult["agentInstance"]["status"] }>(
        `INSERT INTO swarm_hive.agent_instances(
           spec_key, spec_version, instance_key, home_key, status
         ) VALUES ($1, $2, $3, $4, 'active')
         ON CONFLICT (spec_key, instance_key) DO UPDATE
           SET spec_version = excluded.spec_version
         RETURNING id, status`,
        [input.specKey, input.specVersion, instanceKey, homeKey],
      );
      const agentInstanceId = instance.rows[0]?.id;
      if (!agentInstanceId) throw new Error("Agent Instance was not created");
      if (instance.rows[0]?.status === "disabled") {
        throw new ConflictError("Agent Instance is disabled");
      }
      if (isCoordinator) {
        await client.query(
          `UPDATE swarm_hive.agent_seats SET is_coordinator = false, updated_at = now()
            WHERE project_id = $1 AND released_at IS NULL AND is_coordinator`,
          [projectId],
        );
      }
      const seatId = randomUUID();
      const workspaceKey = `seat:${seatId}`;
      const threadId = `agent-seat:${seatId}`;
      const seat = await client.query<{ id: string }>(
        `INSERT INTO swarm_hive.agent_seats(
           id, project_id, agent_instance_id, responsibility, is_coordinator, workspace_key
         ) VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id`,
        [seatId, projectId, agentInstanceId, input.responsibility, isCoordinator, workspaceKey],
      );
      if (!seat.rows[0]?.id) throw new Error("Agent Seat was not created");
      const session = await client.query<{ id: string }>(
        `INSERT INTO swarm_hive.agent_sessions(agent_seat_id, thread_id)
         VALUES ($1, $2)
         RETURNING id`,
        [seatId, threadId],
      );
      const sessionId = session.rows[0]?.id;
      if (!sessionId) throw new Error("Agent Session was not created");
      await client.query("COMMIT");
      return {
        projectId,
        seatId,
        responsibility: input.responsibility,
        isCoordinator,
        workspaceKey,
        agentInstance: {
          id: agentInstanceId,
          specKey: input.specKey,
          specVersion: input.specVersion,
          instanceKey,
          status: "active",
        },
        session: {
          id: sessionId,
          threadId,
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

  async listAgentSeats(input: {
    externalProjectKey: string;
    externalWorkItemType: string;
    externalWorkItemId: string;
  }): Promise<AgentSeatResult[]> {
    const result = await this.pool.query<{
      project_id: string;
      seat_id: string;
      session_id: string;
      agent_instance_id: string;
      spec_key: string;
      spec_version: number;
      instance_key: string;
      responsibility: string;
      is_coordinator: boolean;
      workspace_key: string;
      thread_id: string;
      status: AgentSeatResult["agentInstance"]["status"];
      session_status: AgentSeatResult["session"]["status"];
      run_id: string | null;
      run_status: NonNullable<AgentSeatResult["currentRun"]>["status"] | null;
      task_summary: string | null;
    }>(
      `SELECT p.id AS project_id, seat.id AS seat_id, session.id AS session_id,
              ai.id AS agent_instance_id, ai.spec_key, ai.spec_version, ai.instance_key,
              seat.responsibility, seat.is_coordinator,
              seat.workspace_key, session.thread_id, session.status AS session_status,
              ai.status,
              active_run.id AS run_id, active_run.status AS run_status,
              active_run.task_summary
         FROM swarm_hive.projects p
         JOIN swarm_hive.agent_seats seat
           ON seat.project_id = p.id AND seat.released_at IS NULL
         JOIN swarm_hive.agent_instances ai ON ai.id = seat.agent_instance_id
         JOIN swarm_hive.agent_sessions session
           ON session.agent_seat_id = seat.id
          AND session.status IN ('active', 'waiting')
         LEFT JOIN LATERAL (
           SELECT r.id, r.status, r.task_summary
             FROM swarm_hive.agent_runs r
            WHERE r.agent_session_id = session.id
              AND r.status IN ('queued', 'running', 'waiting_user')
            ORDER BY r.created_at DESC LIMIT 1
         ) active_run ON true
        WHERE p.source = 'feishu_project'
          AND p.external_project_key = $1
          AND p.external_work_item_type = $2
          AND p.external_project_id = $3
        ORDER BY seat.assigned_at ASC`,
      [input.externalProjectKey, input.externalWorkItemType, input.externalWorkItemId],
    );
    return result.rows.map((row) => ({
        projectId: row.project_id,
        seatId: row.seat_id,
        responsibility: row.responsibility,
        isCoordinator: row.is_coordinator,
        workspaceKey: row.workspace_key,
        agentInstance: {
          id: row.agent_instance_id,
          specKey: row.spec_key,
          specVersion: row.spec_version,
          instanceKey: row.instance_key,
          status: row.status,
        },
        session: {
          id: row.session_id,
          threadId: row.thread_id,
          status: row.session_status,
        },
        currentRun: row.run_id && row.run_status
          ? { id: row.run_id, status: row.run_status, taskSummary: row.task_summary }
          : null,
      }));
  }

  async getCoordinatorSeat(projectId: string): Promise<{
    seatId: string;
    agentInstanceId: string;
  } | null> {
    const result = await this.pool.query<{
      seat_id: string;
      agent_instance_id: string;
    }>(
      `SELECT seat.id AS seat_id, seat.agent_instance_id
         FROM swarm_hive.agent_seats seat
         JOIN swarm_hive.agent_instances instance ON instance.id = seat.agent_instance_id
        WHERE seat.project_id = $1 AND seat.released_at IS NULL
          AND seat.is_coordinator AND instance.status = 'active'
        LIMIT 1`,
      [projectId],
    );
    const row = result.rows[0];
    return row ? { seatId: row.seat_id, agentInstanceId: row.agent_instance_id } : null;
  }

  async listProjectAgentSeats(projectId: string): Promise<Array<{
    seatId: string;
    specKey: string;
    responsibility: string;
    isCoordinator: boolean;
    status: string;
  }>> {
    const result = await this.pool.query<{
      seat_id: string;
      spec_key: string;
      responsibility: string;
      is_coordinator: boolean;
      status: string;
    }>(
      `SELECT seat.id AS seat_id, instance.spec_key, seat.responsibility, seat.is_coordinator,
              instance.status
         FROM swarm_hive.agent_seats seat
         JOIN swarm_hive.agent_instances instance ON instance.id = seat.agent_instance_id
        WHERE seat.project_id = $1 AND seat.released_at IS NULL
        ORDER BY seat.is_coordinator DESC, seat.assigned_at`,
      [projectId],
    );
    return result.rows.map((row) => ({
      seatId: row.seat_id,
      specKey: row.spec_key,
      responsibility: row.responsibility,
      isCoordinator: row.is_coordinator,
      status: row.status,
    }));
  }

  async getProjectToolContext(projectId: string, agentSeatId: string): Promise<{
    project: {
      id: string;
      source: string;
      sourceUrl: string | null;
      externalProjectId: string;
      status: string;
    };
    seat: {
      id: string;
      specKey: string;
      responsibility: string;
      isCoordinator: boolean;
    };
  } | null> {
    const result = await this.pool.query<{
      project_id: string;
      source: string;
      external_url: string | null;
      external_project_id: string;
      project_status: string;
      seat_id: string;
      spec_key: string;
      responsibility: string;
      is_coordinator: boolean;
    }>(
      `SELECT project.id AS project_id, project.source, project.external_url,
              project.external_project_id, project.status AS project_status,
              seat.id AS seat_id, instance.spec_key, seat.responsibility,
              seat.is_coordinator
         FROM swarm_hive.projects project
         JOIN swarm_hive.agent_seats seat ON seat.project_id = project.id
         JOIN swarm_hive.agent_instances instance ON instance.id = seat.agent_instance_id
        WHERE project.id = $1 AND seat.id = $2 AND seat.released_at IS NULL`,
      [projectId, agentSeatId],
    );
    const row = result.rows[0];
    return row ? {
      project: {
        id: row.project_id,
        source: row.source,
        sourceUrl: row.external_url,
        externalProjectId: row.external_project_id,
        status: row.project_status,
      },
      seat: {
        id: row.seat_id,
        specKey: row.spec_key,
        responsibility: row.responsibility,
        isCoordinator: row.is_coordinator,
      },
    } : null;
  }

  async bindProjectAgentSeat(input: {
    projectId: string;
    requestedBySeatId: string;
    specKey: string;
    specVersion: number;
    responsibility: string;
  }): Promise<AgentSeatResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const project = await client.query<{ id: string }>(
        `SELECT project.id
           FROM swarm_hive.projects project
           JOIN swarm_hive.agent_seats requester
             ON requester.project_id = project.id
            AND requester.id = $2
            AND requester.released_at IS NULL
            AND requester.is_coordinator
          WHERE project.id = $1 AND project.status = 'active'
          FOR UPDATE OF project`,
        [input.projectId, input.requestedBySeatId],
      );
      if (!project.rows[0]) {
        throw new ConflictError("Only the active Project Coordinator can bind an Agent");
      }
      const instanceKey = "default";
      const instance = await client.query<{
        id: string;
        status: AgentSeatResult["agentInstance"]["status"];
      }>(
        `INSERT INTO swarm_hive.agent_instances(
           spec_key, spec_version, instance_key, home_key, status
         ) VALUES ($1, $2, $3, $4, 'active')
         ON CONFLICT (spec_key, instance_key) DO UPDATE
           SET spec_version = excluded.spec_version
         RETURNING id, status`,
        [input.specKey, input.specVersion, instanceKey, `${input.specKey}:${instanceKey}`],
      );
      const agentInstance = instance.rows[0];
      if (!agentInstance) throw new Error("Agent Instance was not created");
      if (agentInstance.status === "disabled") {
        throw new ConflictError("Agent Instance is disabled");
      }
      const seatId = randomUUID();
      const workspaceKey = `seat:${seatId}`;
      await client.query(
        `INSERT INTO swarm_hive.agent_seats(
           id, project_id, agent_instance_id, responsibility, is_coordinator, workspace_key
         ) VALUES ($1, $2, $3, $4, false, $5)`,
        [seatId, input.projectId, agentInstance.id, input.responsibility, workspaceKey],
      );
      const threadId = `agent-seat:${seatId}`;
      const session = await client.query<{ id: string }>(
        `INSERT INTO swarm_hive.agent_sessions(agent_seat_id, thread_id)
         VALUES ($1, $2)
         RETURNING id`,
        [seatId, threadId],
      );
      const sessionId = session.rows[0]?.id;
      if (!sessionId) throw new Error("Agent Session was not created");
      await client.query("COMMIT");
      return {
        projectId: input.projectId,
        seatId,
        responsibility: input.responsibility,
        isCoordinator: false,
        workspaceKey,
        agentInstance: {
          id: agentInstance.id,
          specKey: input.specKey,
          specVersion: input.specVersion,
          instanceKey,
          status: agentInstance.status,
        },
        session: { id: sessionId, threadId, status: "active" },
        currentRun: null,
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async releaseProjectAgentSeat(input: {
    projectId: string;
    requestedBySeatId: string;
    seatId: string;
    reason: string;
  }): Promise<{ seatId: string; status: "released"; reason: string }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const target = await client.query<{ is_coordinator: boolean }>(
        `SELECT target.is_coordinator
           FROM swarm_hive.agent_seats target
           JOIN swarm_hive.agent_seats requester
             ON requester.project_id = target.project_id
            AND requester.id = $2
            AND requester.released_at IS NULL
            AND requester.is_coordinator
          WHERE target.project_id = $1 AND target.id = $3
            AND target.released_at IS NULL
          FOR UPDATE OF target`,
        [input.projectId, input.requestedBySeatId, input.seatId],
      );
      const seat = target.rows[0];
      if (!seat) {
        throw new ConflictError("Only the active Project Coordinator can release this Agent Seat");
      }
      if (seat.is_coordinator) {
        throw new ConflictError("The Project Coordinator Seat cannot release itself");
      }
      const activeRuns = await client.query(
        `SELECT 1
           FROM swarm_hive.agent_runs run
           JOIN swarm_hive.agent_sessions session ON session.id = run.agent_session_id
          WHERE session.agent_seat_id = $1
            AND run.status IN ('queued', 'running', 'waiting_user')
          LIMIT 1`,
        [input.seatId],
      );
      if (activeRuns.rowCount) {
        throw new ConflictError("Agent Seat has an active Run");
      }
      const unfinishedTasks = await client.query(
        `SELECT 1
           FROM swarm_hive.project_tasks task
          WHERE task.project_id = $1 AND task.assignee_agent_seat_id = $2
            AND task.status IN ('pending', 'assigned', 'running', 'blocked')
          LIMIT 1`,
        [input.projectId, input.seatId],
      );
      if (unfinishedTasks.rowCount) {
        throw new ConflictError("Agent Seat has unfinished Tasks");
      }
      await client.query(
        `UPDATE swarm_hive.agent_sessions
            SET status = 'closed', closed_at = coalesce(closed_at, now()), updated_at = now()
          WHERE agent_seat_id = $1 AND status IN ('active', 'waiting')`,
        [input.seatId],
      );
      await client.query(
        `UPDATE swarm_hive.agent_seats
            SET released_at = now(), updated_at = now()
          WHERE id = $1`,
        [input.seatId],
      );
      await client.query("COMMIT");
      return { seatId: input.seatId, status: "released", reason: input.reason };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async createAgentRun(
    seatId: string,
    options: {
      taskId?: string;
      sessionMode?: "continue" | "fresh";
    } = {},
  ): Promise<StartAgentRunResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const seatRecord = await client.query<{
        project_id: string;
        agent_instance_id: string;
        work_item_id: string;
        instance_status: AgentSeatResult["agentInstance"]["status"];
      }>(
        `SELECT seat.project_id, seat.agent_instance_id,
                p.external_project_id AS work_item_id,
                ai.status AS instance_status
           FROM swarm_hive.agent_seats seat
           JOIN swarm_hive.projects p ON p.id = seat.project_id
           JOIN swarm_hive.agent_instances ai ON ai.id = seat.agent_instance_id
          WHERE seat.id = $1 AND seat.released_at IS NULL
          FOR UPDATE OF seat, ai`,
        [seatId],
      );
      const row = seatRecord.rows[0];
      if (!row) throw new Error("Agent Seat was not found");
      if (row.instance_status === "disabled") {
        throw new ConflictError("Agent Instance is disabled");
      }
      const currentSession = await client.query<{ id: string }>(
        `SELECT id
           FROM swarm_hive.agent_sessions
          WHERE agent_seat_id = $1 AND status IN ('active', 'waiting')
          ORDER BY created_at DESC
          LIMIT 1
          FOR UPDATE`,
        [seatId],
      );
      let sessionId = currentSession.rows[0]?.id;
      if (sessionId) {
        const previousRun = await client.query<{ status: RunStatus }>(
          `SELECT status
             FROM swarm_hive.agent_runs
            WHERE agent_session_id = $1
            ORDER BY created_at DESC
            LIMIT 1`,
          [sessionId],
        );
        const previousStatus = previousRun.rows[0]?.status;
        if (previousStatus && ["queued", "running", "waiting_user"].includes(previousStatus)) {
          throw new ConflictError("Agent Seat already has an active Run");
        }
        if (
          previousStatus &&
          (options.sessionMode === "fresh" || previousStatus === "failed")
        ) {
          await client.query(
            `UPDATE swarm_hive.agent_sessions
                SET status = 'closed', closed_at = now()
              WHERE id = $1`,
            [sessionId],
          );
          sessionId = undefined;
        }
      }
      if (!sessionId) {
        const session = await client.query<{ id: string }>(
          `INSERT INTO swarm_hive.agent_sessions(agent_seat_id, thread_id)
           VALUES ($1, $2)
           RETURNING id`,
          [seatId, `agent-seat:${seatId}:${randomUUID()}`],
        );
        sessionId = session.rows[0]?.id;
      }
      if (!sessionId) throw new Error("Agent Session was not created");
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
           trigger_event_id, status, task_summary, task_id
         ) SELECT $1, $2, $5, $3, 'queued', $4, $6
            WHERE ($6::uuid IS NULL OR EXISTS (
                SELECT 1 FROM swarm_hive.project_tasks task
                 WHERE task.id = $6 AND task.project_id = $1
              ))
         RETURNING id, agent_session_id AS session_id`,
        [
          row.project_id,
          row.agent_instance_id,
          event.rows[0]?.id,
          `处理飞书工作项 ${row.work_item_id}`,
          sessionId,
          options.taskId ?? null,
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
        seatId,
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
      seat_id: string;
      session_id: string;
      external_url: string;
      source: string;
      external_project_key: string;
      external_work_item_type: string;
      external_project_id: string;
      agent_instance_id: string;
      spec_key: string;
      spec_version: number;
      responsibility: string;
      is_coordinator: boolean;
      thread_id: string;
      workspace_key: string;
    }>(
      `SELECT r.id AS run_id, r.project_id, seat.id AS seat_id,
              session.id AS session_id,
              p.source, p.external_url, p.external_project_key, p.external_work_item_type,
              p.external_project_id, ai.id AS agent_instance_id,
              ai.spec_key, ai.spec_version, seat.responsibility, seat.is_coordinator,
              session.thread_id, seat.workspace_key
         FROM swarm_hive.agent_runs r
         JOIN swarm_hive.agent_sessions session ON session.id = r.agent_session_id
         JOIN swarm_hive.agent_seats seat ON seat.id = session.agent_seat_id
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
      seatId: row.seat_id,
      sessionId: row.session_id,
      sourceUrl: row.external_url,
      source: row.source,
      projectKey: row.external_project_key,
      workItemType: row.external_work_item_type,
      workItemId: row.external_project_id,
      agentInstanceId: row.agent_instance_id,
      specKey: row.spec_key,
      specVersion: row.spec_version,
      responsibility: row.responsibility,
      isCoordinator: row.is_coordinator,
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
