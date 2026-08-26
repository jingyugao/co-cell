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
    const notify = vi.fn();
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
            forks: [],
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
          memory: "memory.txt",
          sandbox: { dockerfile: "sandbox/Dockerfile", image: "image" },
          environmentExample: ".env.example",
        }),
      },
      { launch, notify, resume, cancel },
    );
    let projectId: string | undefined;
    let agentInstanceId: string | undefined;
    let forkId: string | undefined;
    let secondProjectId: string | undefined;
    let runId: string | undefined;
    try {
      const fork = await service.fork({
        url: sourceUrl,
        specKey: "software-engineer",
        role: "backend-a",
      });
      ({ projectId, forkId } = fork);
      agentInstanceId = fork.agentInstance.id;
      await expect(repository.getAgentSessionMemory(fork.session.id)).resolves.toBeNull();
      await expect(repository.pinAgentSessionMemory(fork.session.id, {
        content: "# First session snapshot",
        sha256: "first-hash",
      })).resolves.toEqual({
        content: "# First session snapshot",
        sha256: "first-hash",
      });
      await expect(repository.pinAgentSessionMemory(fork.session.id, {
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
      expect(reopened.forks).toHaveLength(1);
      expect(reopened.forks[0]).toMatchObject({
        forkId,
        role: "backend-a",
        agentInstance: { status: "active" },
      });

      await expect(service.fork({
        url: sourceUrl,
        specKey: "software-engineer",
        role: "backend-b",
      })).rejects.toMatchObject({
        code: "conflict",
        status: 409,
      });
      const activeBindings = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM swarm_hive.agent_forks
          WHERE project_id = $1 AND unbound_at IS NULL`,
        [projectId],
      );
      expect(activeBindings.rows[0]?.count).toBe("1");

      const secondFork = await repository.createAgentFork({
        sourceUrl: `https://project.feishu.cn/test-space/story/detail/second-${suffix}`,
        externalProjectKey: "test-project-key",
        externalWorkItemType: "story",
        externalWorkItemId: `second-${suffix}`,
        specKey: "software-engineer",
        specVersion: 1,
        role: "backend-b",
        threadId: `thread-second-${suffix}`,
        workspaceKey: `workspace-second-${suffix}`,
      });
      secondProjectId = secondFork.projectId;
      expect(secondFork.agentInstance.id).toBe(agentInstanceId);
      expect(secondFork.forkId).not.toBe(forkId);
      expect(secondFork.session.id).not.toBe(fork.session.id);
      expect(secondFork.session.threadId).not.toBe(fork.session.threadId);
      const singleton = await pool.query<{ instances: string; forks: string }>(
        `SELECT count(DISTINCT instance.id)::text AS instances,
                count(DISTINCT fork.id)::text AS forks
           FROM swarm_hive.agent_instances instance
           JOIN swarm_hive.agent_forks fork ON fork.agent_instance_id = instance.id
          WHERE instance.spec_key = 'software-engineer'`,
      );
      expect(singleton.rows[0]).toEqual({ instances: "1", forks: "2" });

      const run = await service.start(forkId!);
      runId = run.runId;
      expect(run.status).toBe("queued");
      const activated = await pool.query<{ thread_id: string; status: string }>(
        `SELECT session.thread_id, instance.status
           FROM swarm_hive.agent_sessions session
           JOIN swarm_hive.agent_forks fork ON fork.id = session.agent_fork_id
           JOIN swarm_hive.agent_instances instance ON instance.id = fork.agent_instance_id
          WHERE fork.id = $1`,
        [forkId],
      );
      expect(activated.rows[0]?.thread_id).toBe(fork.session.threadId);
      expect(activated.rows[0]?.status).toBe("active");
      await new Promise((resolve) => setImmediate(resolve));
      expect(launch).toHaveBeenCalledWith(runId);
      await expect(service.preview(sourceUrl)).resolves.toMatchObject({
        forks: [{
          agentInstance: { id: agentInstanceId, status: "active" },
          currentRun: { id: runId, status: "queued" },
        }],
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
    } finally {
      if (secondProjectId) {
        await pool.query("DELETE FROM swarm_hive.projects WHERE id = $1", [secondProjectId]).catch(() => undefined);
      }
      if (projectId) {
        await pool.query("DELETE FROM swarm_hive.agent_run_events WHERE agent_run_id = $1", [runId]).catch(() => undefined);
        await pool.query("DELETE FROM swarm_hive.agent_runs WHERE project_id = $1", [projectId]).catch(() => undefined);
        await pool.query("DELETE FROM swarm_hive.inbox_events WHERE project_id = $1", [projectId]).catch(() => undefined);
        await pool.query("DELETE FROM swarm_hive.agent_forks WHERE project_id = $1", [projectId]).catch(() => undefined);
        await pool.query("DELETE FROM swarm_hive.projects WHERE id = $1", [projectId]).catch(() => undefined);
      }
      if (agentInstanceId) {
        await pool.query("DELETE FROM swarm_hive.agent_instances WHERE id = $1", [agentInstanceId]).catch(() => undefined);
      }
      await pool.end();
    }
  });
});
