import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { describe, expect, test } from "vitest";

import {
  BUSINESS_DATABASE_SCHEMA,
  migrateBusinessDatabase,
} from "../src/persistence/business-migrations.js";

const databaseUrl = process.env.AGENT_BUSINESS_TEST_DATABASE_URL;
const describePostgres = databaseUrl ? describe : describe.skip;

describePostgres("business database integration", () => {
  test("migrates business tables and supports their core relationship", async () => {
    await migrateBusinessDatabase({ connectionString: databaseUrl! });
    await expect(
      migrateBusinessDatabase({ connectionString: databaseUrl! }),
    ).resolves.toEqual([]);

    const pool = new Pool({ connectionString: databaseUrl! });
    const tables = await pool.query<{ table_name: string }>(
      `SELECT table_name
         FROM information_schema.tables
        WHERE table_schema = $1
          AND table_name <> 'schema_migrations'
          AND table_type = 'BASE TABLE'
        ORDER BY table_name`,
      [BUSINESS_DATABASE_SCHEMA],
    );
    expect(tables.rows.map((row) => row.table_name)).toEqual([
      "agent_forks",
      "agent_instances",
      "agent_run_events",
      "agent_run_handoffs",
      "agent_runs",
      "agent_sessions",
      "event_interactions",
      "external_events",
      "inbox_events",
      "project_confirmations",
      "project_deferred_items",
      "project_reports",
      "project_subscriptions",
      "projects",
    ]);
    const guardIndexes = await pool.query<{ indexname: string }>(
      `SELECT indexname
         FROM pg_indexes
        WHERE schemaname = $1
          AND indexname IN (
            'uq_agent_runs_trigger_event',
            'uq_agent_runs_active_session'
          )
        ORDER BY indexname`,
      [BUSINESS_DATABASE_SCHEMA],
    );
    expect(guardIndexes.rows.map((row) => row.indexname)).toEqual([
      "uq_agent_runs_active_session",
      "uq_agent_runs_trigger_event",
    ]);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const project = await client.query<{ id: string }>(
        `INSERT INTO swarm_hive.projects(source, external_project_id, name)
         VALUES ('feishu_project', $1, 'Migration integration project')
         RETURNING id`,
        [`project-${randomUUID()}`],
      );
      const agentInstance = await client.query<{ id: string }>(
        `INSERT INTO swarm_hive.agent_instances(
           spec_key, spec_version, instance_key, workspace_key
         ) VALUES ('software-engineer', 1, $1, $2)
         RETURNING id`,
        [`thread-${randomUUID()}`, `workspace-${randomUUID()}`],
      );
      const projectId = project.rows[0]?.id;
      const agentInstanceId = agentInstance.rows[0]?.id;
      if (!projectId || !agentInstanceId) throw new Error("Test IDs missing");

      const fork = await client.query<{ id: string }>(
        `INSERT INTO swarm_hive.agent_forks(
           project_id, agent_instance_id, workspace_key
         ) VALUES ($1, $2, $3)
         RETURNING id`,
        [projectId, agentInstanceId, `fork-${randomUUID()}`],
      );
      const session = await client.query<{ id: string }>(
        `INSERT INTO swarm_hive.agent_sessions(agent_fork_id, thread_id)
         VALUES ($1, $2)
         RETURNING id`,
        [fork.rows[0]?.id, `thread-${randomUUID()}`],
      );
      const inboxEvent = await client.query<{ id: string }>(
        `INSERT INTO swarm_hive.inbox_events(
           source, external_event_id, project_id, event_type
         ) VALUES ('feishu', $1, $2, 'requirement_ready')
         RETURNING id`,
        [`event-${randomUUID()}`, projectId],
      );
      const run = await client.query<{ id: string }>(
        `INSERT INTO swarm_hive.agent_runs(
           project_id, agent_instance_id, agent_session_id, trigger_event_id, task_summary
         ) VALUES ($1, $2, $3, $4, 'Implement requirement')
         RETURNING id`,
        [projectId, agentInstanceId, session.rows[0]?.id, inboxEvent.rows[0]?.id],
      );
      await client.query(
        `INSERT INTO swarm_hive.agent_run_events(
           agent_run_id, sequence_no, event_type, title
         ) VALUES ($1, 1, 'started', 'Agent instance run started')`,
        [run.rows[0]?.id],
      );

      const timeline = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM swarm_hive.agent_run_events
          WHERE agent_run_id = $1`,
        [run.rows[0]?.id],
      );
      expect(timeline.rows[0]?.count).toBe("1");
    } finally {
      await client.query("ROLLBACK");
      client.release();
      await pool.end();
    }
  });
});
