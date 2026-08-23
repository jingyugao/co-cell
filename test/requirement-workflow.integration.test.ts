import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { describe, expect, test, vi } from "vitest";

import { RequirementWorkflowService } from "../src/application/requirement-workflow-service.js";
import { migrateBusinessDatabase } from "../src/persistence/business-migrations.js";
import { PostgresWorkbenchRepository } from "../src/persistence/workbench-repository.js";

const databaseUrl = process.env.AGENT_BUSINESS_TEST_DATABASE_URL;
const describePostgres = databaseUrl ? describe : describe.skip;

describePostgres("requirement workflow integration", () => {
  test("persists only an external reference and Agent execution state", async () => {
    await migrateBusinessDatabase({ connectionString: databaseUrl! });
    const pool = new Pool({ connectionString: databaseUrl! });
    const repository = new PostgresWorkbenchRepository(pool);
    const suffix = randomUUID();
    const workItemId = `test-${suffix}`;
    const sourceUrl = `https://project.feishu.cn/test-space/story/detail/${workItemId}`;
    const launch = vi.fn();
    const resume = vi.fn(async (runId: string) => ({ runId, status: "running" as const }));
    const cancel = vi.fn(async (runId: string) => ({
      runId,
      agentInstanceId: randomUUID(),
      status: "cancelled" as const,
    }));
    const service = new RequirementWorkflowService(
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
            assignments: [],
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
          id: "software-engineer",
          name: "Software Engineer",
          version: 1,
          knowledge: [],
          sandbox: { dockerfile: "sandbox/Dockerfile", image: "image" },
          environmentExample: ".env.example",
        }),
      },
      { launch, resume, cancel },
    );
    let projectId: string | undefined;
    let agentInstanceId: string | undefined;
    let assignmentId: string | undefined;
    let runId: string | undefined;
    try {
      const assignment = await service.assign({
        url: sourceUrl,
        specKey: "software-engineer",
        role: "backend-a",
      });
      ({ projectId, assignmentId } = assignment);
      agentInstanceId = assignment.agentInstance.id;
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
      expect(reopened.assignments).toHaveLength(1);
      expect(reopened.assignments[0]).toMatchObject({
        assignmentId,
        agentInstance: {
          role: "backend-a",
          status: "idle",
        },
      });

      const run = await service.start(assignmentId);
      runId = run.runId;
      expect(run.status).toBe("queued");
      const activated = await pool.query<{ thread_id: string; status: string }>(
        "SELECT thread_id, status FROM swarm_hive.agent_instances WHERE id = $1",
        [agentInstanceId],
      );
      expect(activated.rows[0]?.thread_id).not.toBe(assignment.agentInstance.threadId);
      expect(activated.rows[0]?.thread_id).toMatch(/^run:/);
      expect(activated.rows[0]?.status).toBe("queued");
      await new Promise((resolve) => setImmediate(resolve));
      expect(launch).toHaveBeenCalledWith(runId);

      await expect(repository.cancelAgentRun(runId)).resolves.toMatchObject({
        runId,
        agentInstanceId,
        status: "cancelled",
      });
      const cancelled = await pool.query<{ run_status: string; instance_status: string }>(
        `SELECT r.status AS run_status, ai.status AS instance_status
           FROM swarm_hive.agent_instance_runs r
           JOIN swarm_hive.agent_instances ai ON ai.id = r.agent_instance_id
          WHERE r.id = $1`,
        [runId],
      );
      expect(cancelled.rows[0]).toEqual({
        run_status: "cancelled",
        instance_status: "idle",
      });
    } finally {
      if (projectId) {
        await pool.query("DELETE FROM swarm_hive.agent_instance_run_events WHERE agent_instance_run_id = $1", [runId]).catch(() => undefined);
        await pool.query("DELETE FROM swarm_hive.agent_instance_runs WHERE project_id = $1", [projectId]).catch(() => undefined);
        await pool.query("DELETE FROM swarm_hive.inbox_events WHERE project_id = $1", [projectId]).catch(() => undefined);
        await pool.query("DELETE FROM swarm_hive.project_agent_instances WHERE project_id = $1", [projectId]).catch(() => undefined);
        await pool.query("DELETE FROM swarm_hive.projects WHERE id = $1", [projectId]).catch(() => undefined);
      }
      if (agentInstanceId) {
        await pool.query("DELETE FROM swarm_hive.agent_instances WHERE id = $1", [agentInstanceId]).catch(() => undefined);
      }
      await pool.end();
    }
  });
});
