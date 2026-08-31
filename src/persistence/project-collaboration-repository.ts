import type { Pool } from "pg";

import type {
  ProjectPublication,
  ProjectPublicationKind,
  ProjectTask,
  ProjectTaskStatus,
} from "../contracts/collaboration.js";

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

type TaskRow = {
  id: string;
  project_id: string;
  parent_task_id: string | null;
  created_by_agent_seat_id: string;
  assignee_agent_seat_id: string | null;
  created_by_run_id: string | null;
  title: string;
  description: string;
  acceptance_criteria: string;
  status: ProjectTaskStatus;
  blocked_reason: string | null;
  result: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  completed_at: Date | string | null;
};

function task(row: TaskRow): ProjectTask {
  return {
    id: row.id,
    projectId: row.project_id,
    parentTaskId: row.parent_task_id,
    createdBySeatId: row.created_by_agent_seat_id,
    assigneeSeatId: row.assignee_agent_seat_id,
    createdByRunId: row.created_by_run_id,
    title: row.title,
    description: row.description,
    acceptanceCriteria: row.acceptance_criteria,
    status: row.status,
    blockedReason: row.blocked_reason,
    result: row.result,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    completedAt: row.completed_at ? iso(row.completed_at) : null,
  };
}

export class PostgresProjectCollaborationRepository {
  constructor(private readonly pool: Pool) {}

  async createTask(input: {
    projectId: string;
    agentSeatId: string;
    runId: string;
    parentTaskId?: string;
    assigneeSeatId?: string;
    title: string;
    description?: string;
    acceptanceCriteria?: string;
  }): Promise<ProjectTask> {
    const result = await this.pool.query<TaskRow>(
      `INSERT INTO swarm_hive.project_tasks(
         project_id, parent_task_id, created_by_agent_seat_id,
         assignee_agent_seat_id, created_by_run_id, title, description,
         acceptance_criteria, status
       ) SELECT $1, parent.id, $2, assignee.id, $3, $6, $7, $8,
                CASE WHEN assignee.id IS NULL THEN 'pending' ELSE 'assigned' END
           FROM (SELECT 1) seed
           LEFT JOIN swarm_hive.project_tasks parent
             ON parent.id = $4 AND parent.project_id = $1
           LEFT JOIN swarm_hive.agent_seats assignee
             ON assignee.id = $5 AND assignee.project_id = $1 AND assignee.released_at IS NULL
          WHERE ($4::uuid IS NULL OR parent.id IS NOT NULL)
            AND ($5::uuid IS NULL OR assignee.id IS NOT NULL)
       RETURNING *`,
      [input.projectId, input.agentSeatId, input.runId, input.parentTaskId ?? null,
        input.assigneeSeatId ?? null, input.title, input.description ?? "",
        input.acceptanceCriteria ?? ""],
    );
    const row = result.rows[0];
    if (!row) throw new Error("Task parent or assignee is not active in this project");
    return task(row);
  }

  async listTasks(input: {
    projectId: string;
    statuses?: ProjectTaskStatus[];
    assigneeSeatId?: string;
  }): Promise<ProjectTask[]> {
    const result = await this.pool.query<TaskRow>(
      `SELECT * FROM swarm_hive.project_tasks
        WHERE project_id = $1
          AND ($2::text[] IS NULL OR status = ANY($2::text[]))
          AND ($3::uuid IS NULL OR assignee_agent_seat_id = $3)
        ORDER BY CASE status
          WHEN 'running' THEN 0 WHEN 'assigned' THEN 1 WHEN 'blocked' THEN 2
          WHEN 'pending' THEN 3 ELSE 4 END, created_at`,
      [input.projectId, input.statuses?.length ? input.statuses : null,
        input.assigneeSeatId ?? null],
    );
    return result.rows.map(task);
  }

  async getTask(projectId: string, taskId: string): Promise<ProjectTask | null> {
    const result = await this.pool.query<TaskRow>(
      `SELECT * FROM swarm_hive.project_tasks WHERE project_id = $1 AND id = $2`,
      [projectId, taskId],
    );
    return result.rows[0] ? task(result.rows[0]) : null;
  }

  async updateTask(input: {
    projectId: string;
    taskId: string;
    title?: string;
    description?: string;
    acceptanceCriteria?: string;
    assigneeSeatId?: string | null;
    status?: ProjectTaskStatus;
    blockedReason?: string;
    result?: string;
  }): Promise<ProjectTask | null> {
    const updated = await this.pool.query<TaskRow>(
      `UPDATE swarm_hive.project_tasks task SET
         title = coalesce($3, task.title),
         description = coalesce($4, task.description),
         acceptance_criteria = coalesce($5, task.acceptance_criteria),
         assignee_agent_seat_id = CASE WHEN $6::boolean THEN $7::uuid ELSE task.assignee_agent_seat_id END,
         status = coalesce($8, task.status),
         blocked_reason = CASE WHEN $8 = 'blocked' THEN $9
                               WHEN $8 IS NOT NULL THEN NULL ELSE task.blocked_reason END,
         result = coalesce($10, task.result),
         completed_at = CASE WHEN $8 IN ('completed','cancelled') THEN now()
                             WHEN $8 IS NOT NULL THEN NULL ELSE task.completed_at END
       WHERE task.project_id = $1 AND task.id = $2
         AND ($7::uuid IS NULL OR EXISTS (
           SELECT 1 FROM swarm_hive.agent_seats seat
            WHERE seat.id = $7 AND seat.project_id = $1 AND seat.released_at IS NULL
         ))
       RETURNING *`,
      [input.projectId, input.taskId, input.title ?? null, input.description ?? null,
        input.acceptanceCriteria ?? null,
        Object.prototype.hasOwnProperty.call(input, "assigneeSeatId"),
        input.assigneeSeatId ?? null, input.status ?? null,
        input.blockedReason ?? null, input.result ?? null],
    );
    return updated.rows[0] ? task(updated.rows[0]) : null;
  }

  async savePublication(input: {
    projectId: string;
    agentSeatId: string;
    runId: string;
    taskId?: string;
    kind: ProjectPublicationKind;
    summary: string;
    relativePath: string;
    sha256: string;
  }): Promise<ProjectPublication> {
    const result = await this.pool.query<{
      id: string; project_id: string; agent_seat_id: string; run_id: string | null;
      task_id: string | null; kind: ProjectPublicationKind;
      summary: string; relative_path: string; sha256: string; version: number; created_at: Date;
    }>(
      `INSERT INTO swarm_hive.project_publications(
         project_id, agent_seat_id, run_id, task_id, kind, summary,
         relative_path, sha256, version
       ) SELECT $1,$2,$3,task.id,$5,$6,$7,$8,
         (SELECT coalesce(max(version),0)+1 FROM swarm_hive.project_publications
           WHERE project_id=$1 AND kind=$5)
           FROM (SELECT 1) seed
           LEFT JOIN swarm_hive.project_tasks task ON task.id=$4 AND task.project_id=$1
          WHERE $4::uuid IS NULL OR task.id IS NOT NULL
       ON CONFLICT (project_id, relative_path, sha256) DO UPDATE SET summary=excluded.summary
       RETURNING *`,
      [input.projectId, input.agentSeatId, input.runId, input.taskId ?? null,
        input.kind, input.summary, input.relativePath, input.sha256],
    );
    const row = result.rows[0];
    if (!row) throw new Error("Project publication was not saved");
    return {
      id: row.id, projectId: row.project_id, agentSeatId: row.agent_seat_id,
      runId: row.run_id, taskId: row.task_id, kind: row.kind,
      summary: row.summary, relativePath: row.relative_path, sha256: row.sha256,
      version: row.version, createdAt: iso(row.created_at),
    };
  }

  async listPublications(projectId: string): Promise<ProjectPublication[]> {
    const result = await this.pool.query<{
      id: string; project_id: string; agent_seat_id: string; run_id: string | null;
      task_id: string | null; kind: ProjectPublicationKind;
      summary: string; relative_path: string; sha256: string; version: number; created_at: Date;
    }>(
      `SELECT id, project_id, agent_seat_id, run_id, task_id, kind, summary,
              relative_path, sha256, version, created_at
         FROM swarm_hive.project_publications
        WHERE project_id = $1 ORDER BY created_at DESC, id DESC`,
      [projectId],
    );
    return result.rows.map((row) => ({
      id: row.id, projectId: row.project_id, agentSeatId: row.agent_seat_id,
      runId: row.run_id, taskId: row.task_id, kind: row.kind,
      summary: row.summary, relativePath: row.relative_path, sha256: row.sha256,
      version: row.version, createdAt: iso(row.created_at),
    }));
  }
}
