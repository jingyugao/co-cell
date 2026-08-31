import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { describe, expect, test, vi } from "vitest";

import { ProjectWorkflowService } from "../src/application/project-workflow-service.js";
import { migrateBusinessDatabase } from "../src/persistence/business-migrations.js";
import { PostgresWorkbenchRepository } from "../src/persistence/workbench-repository.js";

const databaseUrl = process.env.AGENT_BUSINESS_TEST_DATABASE_URL;
const describePostgres = databaseUrl ? describe : describe.skip;

describePostgres("project workflow integration", () => {
  test("persists only an external reference and Agent execution state", async () => {
    await migrateBusinessDatabase({ connectionString: databaseUrl! });
    const pool = new Pool({ connectionString: databaseUrl! });
    const repository = new PostgresWorkbenchRepository(pool);
    const suffix = randomUUID();
    const specKey = `software-engineer-${suffix}`;
    const workItemId = `test-${suffix}`;
    const sourceUrl = `https://project.feishu.cn/test-space/story/detail/${workItemId}`;
    const launch = vi.fn();
    const notify = vi.fn();
    const resume = vi.fn(async (runId: string) => ({ runId, status: "running" as const }));
    const cancel = vi.fn(async (runId: string) => ({
      runId,
      agentInstanceId: randomUUID(),
      status: "cancelled" as const,
    }));
    const service = new ProjectWorkflowService(
      {
        get: async () => ({
          preview: {
            sourceUrl,
            projectKey: "test-project-key",
            project: { key: "test-project-key", simpleName: "test-space", name: "实时名称" },
            workItemId,
            workItemType: { key: "story", name: "需求" },
            title: "绝不能保存的实时标题",
            status: { key: "developing", name: "开发中" },
            roles: [],
            currentNodes: [],
            fields: [{ key: "description", name: "描述", value: "绝不能保存的正文" }],
            updatedAt: null,
            seats: [],
          },
          raw: {
            work_item_attribute: { work_item_name: "绝不能保存的实时标题" },
            work_item_fields: [{ key: "description", name: "描述", value: "绝不能保存的正文" }],
            work_item_current_node: [],
          },
        }),
      },
      repository,
      {
        list: async () => ({ items: [] }),
        get: async () => ({
          id: specKey,
          name: "Software Engineer",
          version: 1,
          defaultResponsibility: "代码开发与交付",
          memory: "memory.txt",
          sandbox: { dockerfile: "sandbox/Dockerfile", image: "image" },
          environmentExample: ".env.example",
        }),
      },
      { launch, notify, resume, cancel },
    );
    let projectId: string | undefined;
    let agentInstanceId: string | undefined;
    let seatId: string | undefined;
    let secondProjectId: string | undefined;
    let workerAgentInstanceId: string | undefined;
    let boundAgentInstanceId: string | undefined;
    let runId: string | undefined;
    try {
      const seat = await service.assignSeat({
        url: sourceUrl,
        specKey,
        responsibility: "backend-a",
      });
      ({ projectId, seatId } = seat);
      agentInstanceId = seat.agentInstance.id;
      await expect(repository.getAgentSessionMemory(seat.session.id)).resolves.toBeNull();
      await expect(repository.pinAgentSessionMemory(seat.session.id, {
        content: "# First session snapshot",
        sha256: "first-hash",
      })).resolves.toEqual({
        content: "# First session snapshot",
        sha256: "first-hash",
      });
      await expect(repository.pinAgentSessionMemory(seat.session.id, {
        content: "# Later candidate",
        sha256: "later-hash",
      })).resolves.toEqual({
        content: "# First session snapshot",
        sha256: "first-hash",
      });
      const stored = await pool.query<{
        name: string | null;
        metadata: Record<string, unknown>;
        external_url: string;
        external_project_key: string;
        external_work_item_type: string;
        external_project_id: string;
      }>(
        `SELECT name, metadata, external_url, external_project_key,
                external_work_item_type, external_project_id
           FROM swarm_hive.projects WHERE id = $1`,
        [projectId],
      );
      expect(stored.rows[0]).toEqual({
        name: null,
        metadata: {},
        external_url: sourceUrl,
        external_project_key: "test-project-key",
        external_work_item_type: "story",
        external_project_id: workItemId,
      });
      expect(JSON.stringify(stored.rows[0])).not.toContain("绝不能保存");

      const reopened = await service.preview(sourceUrl);
      expect(reopened.seats).toHaveLength(1);
      expect(reopened.seats[0]).toMatchObject({
        seatId,
        responsibility: "backend-a",
        agentInstance: { status: "active" },
      });

      const secondSeat = await service.assignSeat({
        url: sourceUrl,
        specKey,
        responsibility: "backend-b",
        isCoordinator: false,
      });
      expect(secondSeat).toMatchObject({
        projectId,
        responsibility: "backend-b",
        isCoordinator: false,
        agentInstance: { id: agentInstanceId, instanceKey: "default" },
      });
      expect(secondSeat.seatId).not.toBe(seatId);
      const activeBindings = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM swarm_hive.agent_seats
          WHERE project_id = $1 AND released_at IS NULL`,
        [projectId],
      );
      expect(activeBindings.rows[0]?.count).toBe("2");

      const workerSeat = await repository.createAgentSeat({
        sourceUrl,
        externalProjectKey: "test-project-key",
        externalWorkItemType: "story",
        externalWorkItemId: workItemId,
        specKey: `project-worker-${suffix}`,
        specVersion: 1,
        responsibility: "architecture",
        isCoordinator: false,
      });
      workerAgentInstanceId = workerSeat.agentInstance.id;
      expect(workerSeat).toMatchObject({ projectId, isCoordinator: false });
      await expect(service.preview(sourceUrl)).resolves.toMatchObject({
        seats: expect.arrayContaining([
          expect.objectContaining({ seatId, isCoordinator: true }),
          expect.objectContaining({ seatId: workerSeat.seatId, isCoordinator: false }),
        ]),
      });

      const dynamicallyBound = await repository.bindProjectAgentSeat({
        projectId,
        requestedBySeatId: seatId!,
        specKey: `software-tester-${suffix}`,
        specVersion: 1,
        responsibility: "uat-validation",
      });
      boundAgentInstanceId = dynamicallyBound.agentInstance.id;
      expect(dynamicallyBound).toMatchObject({
        projectId,
        isCoordinator: false,
        responsibility: "uat-validation",
      });
      const parallelSeat = await repository.bindProjectAgentSeat({
        projectId,
        requestedBySeatId: seatId!,
        specKey: `software-tester-${suffix}`,
        specVersion: 1,
        responsibility: "api-validation",
      });
      expect(parallelSeat.agentInstance.id).toBe(dynamicallyBound.agentInstance.id);
      expect(parallelSeat.seatId).not.toBe(dynamicallyBound.seatId);
      await expect(repository.releaseProjectAgentSeat({
        projectId,
        requestedBySeatId: seatId!,
        seatId: parallelSeat.seatId,
        reason: "parallel validation complete",
      })).resolves.toMatchObject({ status: "released" });
      await expect(repository.bindProjectAgentSeat({
        projectId,
        requestedBySeatId: workerSeat.seatId,
        specKey: `unauthorized-${suffix}`,
        specVersion: 1,
        responsibility: "unauthorized",
      })).rejects.toThrow("Only the active Project Coordinator");
      const blockingTask = await pool.query<{ id: string }>(
        `INSERT INTO swarm_hive.project_tasks(
           project_id, created_by_agent_seat_id, assignee_agent_seat_id, title, status
         ) VALUES ($1, $2, $3, 'Validate release guard', 'assigned')
         RETURNING id`,
        [projectId, seatId, dynamicallyBound.seatId],
      );
      await expect(repository.releaseProjectAgentSeat({
        projectId,
        requestedBySeatId: seatId!,
        seatId: dynamicallyBound.seatId,
        reason: "too early",
      })).rejects.toThrow("unfinished Tasks");
      await pool.query(
        `UPDATE swarm_hive.project_tasks
            SET status = 'completed', completed_at = now()
          WHERE id = $1`,
        [blockingTask.rows[0]?.id],
      );
      const blockingRun = await repository.createAgentRun(dynamicallyBound.seatId);
      await expect(repository.releaseProjectAgentSeat({
        projectId,
        requestedBySeatId: seatId!,
        seatId: dynamicallyBound.seatId,
        reason: "still too early",
      })).rejects.toThrow("active Run");
      await repository.cancelAgentRun(blockingRun.runId);
      await expect(repository.releaseProjectAgentSeat({
        projectId,
        requestedBySeatId: seatId!,
        seatId: dynamicallyBound.seatId,
        reason: "validation complete",
      })).resolves.toEqual({
        seatId: dynamicallyBound.seatId,
        status: "released",
        reason: "validation complete",
      });
      const released = await pool.query<{ released: boolean; session_status: string }>(
        `SELECT seat.released_at IS NOT NULL AS released, session.status AS session_status
           FROM swarm_hive.agent_seats seat
           JOIN swarm_hive.agent_sessions session ON session.agent_seat_id = seat.id
          WHERE seat.id = $1`,
        [dynamicallyBound.seatId],
      );
      expect(released.rows[0]).toEqual({ released: true, session_status: "closed" });

      await expect(repository.createAgentSeat({
        sourceUrl: `https://project.feishu.cn/test-space/story/detail/worker-first-${suffix}`,
        externalProjectKey: "test-project-key",
        externalWorkItemType: "story",
        externalWorkItemId: `worker-first-${suffix}`,
        specKey,
        specVersion: 1,
        responsibility: "backend-only",
        isCoordinator: false,
      })).rejects.toThrow("The first Agent Seat in a Project must be the Coordinator");

      const secondProjectSeat = await repository.createAgentSeat({
        sourceUrl: `https://project.feishu.cn/test-space/story/detail/second-${suffix}`,
        externalProjectKey: "test-project-key",
        externalWorkItemType: "story",
        externalWorkItemId: `second-${suffix}`,
        specKey,
        specVersion: 1,
        responsibility: "backend-b",
      });
      secondProjectId = secondProjectSeat.projectId;
      expect(secondProjectSeat.agentInstance.id).toBe(agentInstanceId);
      expect(secondProjectSeat.seatId).not.toBe(seatId);
      expect(secondProjectSeat.session.id).not.toBe(seat.session.id);
      expect(secondProjectSeat.session.threadId).not.toBe(seat.session.threadId);
      const singleton = await pool.query<{ instances: string; seats: string }>(
        `SELECT count(DISTINCT instance.id)::text AS instances,
                count(DISTINCT seat.id)::text AS seats
           FROM swarm_hive.agent_instances instance
           JOIN swarm_hive.agent_seats seat ON seat.agent_instance_id = instance.id
          WHERE instance.spec_key = $1`,
        [specKey],
      );
      expect(singleton.rows[0]).toEqual({ instances: "1", seats: "3" });

      const run = await service.start(seatId!);
      runId = run.runId;
      expect(run.status).toBe("queued");
      const activated = await pool.query<{ thread_id: string; status: string }>(
        `SELECT session.thread_id, instance.status
           FROM swarm_hive.agent_sessions session
           JOIN swarm_hive.agent_seats seat ON seat.id = session.agent_seat_id
           JOIN swarm_hive.agent_instances instance ON instance.id = seat.agent_instance_id
          WHERE seat.id = $1`,
        [seatId],
      );
      expect(activated.rows[0]?.thread_id).toBe(seat.session.threadId);
      expect(activated.rows[0]?.status).toBe("active");
      await new Promise((resolve) => setImmediate(resolve));
      expect(launch).toHaveBeenCalledWith(runId);
      const afterStart = await service.preview(sourceUrl);
      expect(afterStart.seats.find((item) => item.seatId === seatId)).toMatchObject({
        seatId,
        agentInstance: { id: agentInstanceId, status: "active" },
        currentRun: { id: runId, status: "queued" },
      });

      await expect(repository.cancelAgentRun(runId)).resolves.toMatchObject({
        runId,
        agentInstanceId,
        status: "cancelled",
      });
      const cancelled = await pool.query<{ run_status: string; instance_status: string }>(
        `SELECT r.status AS run_status, ai.status AS instance_status
           FROM swarm_hive.agent_runs r
           JOIN swarm_hive.agent_instances ai ON ai.id = r.agent_instance_id
          WHERE r.id = $1`,
        [runId],
      );
      expect(cancelled.rows[0]).toEqual({
        run_status: "cancelled",
        instance_status: "active",
      });

      const restarted = await service.start(seatId!);
      expect(restarted.sessionId).not.toBe(seat.session.id);
      const restartedSession = await pool.query<{ thread_id: string }>(
        `SELECT thread_id FROM swarm_hive.agent_sessions WHERE id = $1`,
        [restarted.sessionId],
      );
      expect(restartedSession.rows[0]?.thread_id).not.toBe(seat.session.threadId);
      await expect(repository.cancelAgentRun(restarted.runId)).resolves.toMatchObject({
        runId: restarted.runId,
        status: "cancelled",
      });
    } finally {
      if (secondProjectId) {
        await pool.query("DELETE FROM swarm_hive.projects WHERE id = $1", [secondProjectId]).catch(() => undefined);
      }
      if (projectId) {
        await pool.query("DELETE FROM swarm_hive.agent_run_events WHERE agent_run_id = $1", [runId]).catch(() => undefined);
        await pool.query("DELETE FROM swarm_hive.agent_runs WHERE project_id = $1", [projectId]).catch(() => undefined);
        await pool.query("DELETE FROM swarm_hive.inbox_events WHERE project_id = $1", [projectId]).catch(() => undefined);
        await pool.query("DELETE FROM swarm_hive.agent_seats WHERE project_id = $1", [projectId]).catch(() => undefined);
        await pool.query("DELETE FROM swarm_hive.projects WHERE id = $1", [projectId]).catch(() => undefined);
      }
      if (agentInstanceId) {
        await pool.query("DELETE FROM swarm_hive.agent_instances WHERE id = $1", [agentInstanceId]).catch(() => undefined);
      }
      if (workerAgentInstanceId) {
        await pool.query("DELETE FROM swarm_hive.agent_instances WHERE id = $1", [workerAgentInstanceId]).catch(() => undefined);
      }
      if (boundAgentInstanceId) {
        await pool.query("DELETE FROM swarm_hive.agent_instances WHERE id = $1", [boundAgentInstanceId]).catch(() => undefined);
      }
      await pool.end();
    }
  });
});
