import { Pool } from "pg";
import { describe, expect, test } from "vitest";

import { WorkbenchQueryService } from "../src/application/workbench-query-service.js";
import { migrateBusinessDatabase } from "../src/persistence/business-migrations.js";
import {
  WORKBENCH_TEST_PROJECT_EXTERNAL_ID,
  seedWorkbenchTestData,
} from "../src/persistence/development-seed.js";
import { PostgresWorkbenchRepository } from "../src/persistence/workbench-repository.js";
import { createApp } from "../src/server/app.js";

const databaseUrl = process.env.AGENT_BUSINESS_TEST_DATABASE_URL;
const describePostgres = databaseUrl ? describe : describe.skip;

describePostgres("workbench API integration", () => {
  test("serves isolated PostgreSQL fixture data through Hono", async () => {
    await migrateBusinessDatabase({ connectionString: databaseUrl! });
    const projectId = await seedWorkbenchTestData(databaseUrl!);
    const pool = new Pool({ connectionString: databaseUrl! });
    try {
      const repository = new PostgresWorkbenchRepository(pool);
      const service = new WorkbenchQueryService(repository, {
        getStatus: async () => ({ status: "online", name: "test-sandbox", latencyMs: 1 }),
      });
      const list = await service.listProjects({ limit: 100 });
      expect(
        list.items.some(
          (project) => project.externalProjectId === WORKBENCH_TEST_PROJECT_EXTERNAL_ID,
        ),
      ).toBe(true);

      const workbench = await service.getProjectWorkbench(projectId);
      expect(workbench.project.name).toBe("Workbench integration fixture");
      expect(workbench.primaryAgentFork?.specKey).toBe("software-engineer");
      expect(workbench.currentRun?.progress.percent).toBe(67);
      expect(workbench.currentRun?.events).toHaveLength(6);
      expect(workbench.runtime.status).toBe("online");

      const runId = workbench.currentRun?.id;
      if (!runId) throw new Error("Seeded current Run is missing");
      expect((await service.getRun(runId)).projectId).toBe(projectId);
      const events = await service.getRunEvents(runId, 3, 2);
      expect(events.items.map((event) => event.sequenceNo)).toEqual([4, 5]);
      expect(events.lastSequence).toBe(5);

      const firstRunsPage = await service.listProjectRuns(projectId, { limit: 2 });
      expect(firstRunsPage.items).toHaveLength(2);
      expect(firstRunsPage.nextCursor).not.toBeNull();
      const secondRunsPage = await service.listProjectRuns(projectId, {
        limit: 2,
        cursor: firstRunsPage.nextCursor!,
      });
      expect(secondRunsPage.items).toHaveLength(2);
      expect(secondRunsPage.items[0]?.id).not.toBe(firstRunsPage.items[0]?.id);

      const inboxEvents = await service.listInboxEvents(projectId, { limit: 100 });
      expect(inboxEvents.items).toHaveLength(4);
      expect((await service.listRuns({ limit: 100 })).items.length).toBeGreaterThanOrEqual(4);
      expect((await service.listAllInboxEvents({ limit: 100 })).items.length).toBeGreaterThanOrEqual(4);

      const specUsage = await service.getAgentSpecUsage("software-engineer");
      expect(specUsage.statistics.instances).toBe(1);
      expect(specUsage.statistics.activeRequirements).toBeGreaterThanOrEqual(1);
      const fixtureRequirements = specUsage.activeRequirements.filter(
        (item) => item.project.id === projectId,
      );
      expect(fixtureRequirements).toHaveLength(1);
      expect(fixtureRequirements[0]?.role).toBe("backend-module-a");

      const agentInstanceId = fixtureRequirements[0]?.agentInstance.id;
      if (!agentInstanceId) throw new Error("Seeded Agent Instance is missing");
      const agentDetail = await service.getAgentInstance(agentInstanceId);
      expect(agentDetail.agentInstance.id).toBe(agentInstanceId);
      expect(agentDetail.forks[0]?.project.id).toBe(projectId);
      expect(agentDetail.forks[0]?.role).toBe(fixtureRequirements[0]?.role);

      const app = createApp({
        workbench: service,
        specCatalog: {
          list: async () => ({ items: [] }),
          get: async (key) => key === "software-engineer" ? {
            id: "software-engineer",
            name: "Software Engineer",
            version: 1,
            memory: "memory.txt",
            sandbox: { dockerfile: "sandbox/Dockerfile", image: "swarm-hive:latest" },
            environmentExample: ".env.example",
          } : null,
        },
        enableRequestLogger: false,
      });
      const response = await app.request(`/api/v1/projects/${projectId}/workbench`);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        project: { id: projectId },
        currentRun: { progress: { percent: 67 } },
      });
      expect((await app.request(`/api/v1/projects/${projectId}/runs`)).status).toBe(200);
      expect((await app.request(`/api/v1/projects/${projectId}/inbox-events`)).status).toBe(200);
      const agentResponse = await app.request(`/api/v1/agent-instances/${agentInstanceId}`);
      expect(agentResponse.status).toBe(200);
      expect(await agentResponse.json()).toMatchObject({
        agentInstance: { id: agentInstanceId },
        forks: [{ project: { id: projectId } }],
      });
      const specResponse = await app.request("/api/v1/agent-specs/software-engineer");
      expect(specResponse.status).toBe(200);
      const specBody = await specResponse.json() as {
        spec: { id: string };
        statistics: { activeRequirements: number };
      };
      expect(specBody.spec.id).toBe("software-engineer");
      expect(specBody.statistics.activeRequirements).toBeGreaterThanOrEqual(1);
    } finally {
      const agents = await pool.query<{ agent_instance_id: string }>(
        `SELECT agent_instance_id FROM swarm_hive.agent_forks
          WHERE project_id = $1`,
        [projectId],
      );
      await pool.query(
        `DELETE FROM swarm_hive.agent_run_events
          WHERE agent_run_id IN (
            SELECT id FROM swarm_hive.agent_runs WHERE project_id = $1
          )`,
        [projectId],
      );
      await pool.query("DELETE FROM swarm_hive.agent_runs WHERE project_id = $1", [projectId]);
      await pool.query("DELETE FROM swarm_hive.inbox_events WHERE project_id = $1", [projectId]);
      await pool.query("DELETE FROM swarm_hive.agent_forks WHERE project_id = $1", [projectId]);
      await pool.query("DELETE FROM swarm_hive.projects WHERE id = $1", [projectId]);
      for (const agent of agents.rows) {
        await pool.query("DELETE FROM swarm_hive.agent_instances WHERE id = $1", [agent.agent_instance_id]);
      }
      await pool.end();
    }
  });
});
