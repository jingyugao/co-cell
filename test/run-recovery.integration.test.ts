import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { describe, expect, test } from "vitest";

import { migrateBusinessDatabase } from "../src/persistence/business-migrations.js";
import { PostgresWorkbenchRepository } from "../src/persistence/workbench-repository.js";

const databaseUrl = process.env.AGENT_BUSINESS_TEST_DATABASE_URL;
const describePostgres = databaseUrl ? describe : describe.skip;

describePostgres("Agent Run recovery", () => {
  test("reuses the Session after failure and requeues a running Task", async () => {
    await migrateBusinessDatabase({ connectionString: databaseUrl! });
    const pool = new Pool({ connectionString: databaseUrl! });
    const repository = new PostgresWorkbenchRepository(pool);
    const suffix = randomUUID();
    const seat = await repository.createAgentSeat({
      sourceUrl: `https://project.feishu.cn/test-space/story/detail/recovery-${suffix}`,
      externalProjectKey: "test-project-key",
      externalWorkItemType: "story",
      externalWorkItemId: `recovery-${suffix}`,
      specKey: `software-engineer-${suffix}`,
      specVersion: 1,
      responsibility: "",
    });

    try {
      const task = await pool.query<{ id: string }>(
        `INSERT INTO swarm_hive.project_tasks(
           project_id, created_by_agent_seat_id, assignee_agent_seat_id, title, status
         ) VALUES ($1, $2, $2, 'Recover interrupted work', 'running')
         RETURNING id`,
        [seat.projectId, seat.seatId],
      );
      const taskId = task.rows[0]!.id;
      const failedRun = await repository.createAgentRun(seat.seatId, { taskId });
      await repository.updateAgentRun({ runId: failedRun.runId, status: "running" });
      await repository.updateAgentRun({
        runId: failedRun.runId,
        status: "failed",
        errorCode: "infrastructure_error",
        errorMessage: "checkpoint pool closed",
      });

      const requeued = await pool.query<{ status: string }>(
        "SELECT status FROM swarm_hive.project_tasks WHERE id = $1",
        [taskId],
      );
      expect(requeued.rows[0]?.status).toBe("assigned");

      const continuedRun = await repository.createAgentRun(seat.seatId, { taskId });
      expect(continuedRun.sessionId).toBe(failedRun.sessionId);
      await repository.cancelAgentRun(continuedRun.runId);

      const freshRun = await repository.createAgentRun(seat.seatId, {
        taskId,
        sessionMode: "fresh",
      });
      expect(freshRun.sessionId).not.toBe(failedRun.sessionId);
      await repository.cancelAgentRun(freshRun.runId);
    } finally {
      await pool.query(
        `DELETE FROM swarm_hive.agent_run_events
          WHERE agent_run_id IN (
            SELECT id FROM swarm_hive.agent_runs WHERE project_id = $1
          )`,
        [seat.projectId],
      );
      await pool.query("DELETE FROM swarm_hive.agent_runs WHERE project_id = $1", [seat.projectId]);
      await pool.query("DELETE FROM swarm_hive.inbox_events WHERE project_id = $1", [seat.projectId]);
      await pool.query("DELETE FROM swarm_hive.project_tasks WHERE project_id = $1", [seat.projectId]);
      await pool.query("DELETE FROM swarm_hive.agent_sessions WHERE agent_seat_id = $1", [seat.seatId]);
      await pool.query("DELETE FROM swarm_hive.agent_seats WHERE project_id = $1", [seat.projectId]);
      await pool.query("DELETE FROM swarm_hive.projects WHERE id = $1", [seat.projectId]);
      await pool.query(
        "DELETE FROM swarm_hive.agent_instances WHERE id = $1",
        [seat.agentInstance.id],
      );
      await pool.end();
    }
  });
});
