import type { PoolClient } from "pg";
import { Pool } from "pg";

export const WORKBENCH_TEST_PROJECT_EXTERNAL_ID = "TEST-WORKBENCH-PROJECT";

async function seedCompletedRun(
  client: PoolClient,
  options: {
    projectId: string;
    agentInstanceId: string;
    eventId: string;
    eventType: string;
    taskSummary: string;
    status: "succeeded" | "failed";
    minutesAgo: number;
    durationSeconds: number;
  },
): Promise<void> {
  const event = await client.query<{ id: string }>(
    `INSERT INTO agent_staff.inbox_events(
       source, external_event_id, project_id, event_type, status, processed_at,
       received_at
     ) VALUES ('feishu', $1, $2, $3, 'completed', now(), now() - ($4 * interval '1 minute'))
     ON CONFLICT (source, external_event_id) DO UPDATE
       SET project_id = excluded.project_id, event_type = excluded.event_type
     RETURNING id`,
    [options.eventId, options.projectId, options.eventType, options.minutesAgo],
  );
  await client.query(
    `INSERT INTO agent_staff.agent_instance_runs(
       project_id, agent_instance_id, trigger_event_id, status, task_summary,
       result_summary, started_at, finished_at, created_at
     )
     SELECT $1, $2, $3, $4, $5,
            CASE WHEN $4 = 'succeeded' THEN '任务执行完成' ELSE '测试环境依赖检查失败' END,
            now() - ($6 * interval '1 minute'),
            now() - ($6 * interval '1 minute') + ($7 * interval '1 second'),
            now() - ($6 * interval '1 minute')
     WHERE NOT EXISTS (
       SELECT 1 FROM agent_staff.agent_instance_runs WHERE trigger_event_id = $3
     )`,
    [
      options.projectId,
      options.agentInstanceId,
      event.rows[0]?.id,
      options.status,
      options.taskSummary,
      options.minutesAgo,
      options.durationSeconds,
    ],
  );
}

export async function seedWorkbenchTestData(connectionString: string): Promise<string> {
  const pool = new Pool({ connectionString, max: 1 });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const project = await client.query<{ id: string }>(
      `INSERT INTO agent_staff.projects(
         source, external_project_id, name, status, metadata
       ) VALUES (
         'test', $1, 'Workbench integration fixture', 'active', '{"owner":"test"}'::jsonb
       )
       ON CONFLICT (source, external_project_id) DO UPDATE
         SET name = excluded.name, status = excluded.status, metadata = excluded.metadata
       RETURNING id`,
      [WORKBENCH_TEST_PROJECT_EXTERNAL_ID],
    );
    const projectId = project.rows[0]?.id;
    if (!projectId) throw new Error("Development project was not created");

    const agent = await client.query<{ id: string }>(
      `INSERT INTO agent_staff.agent_instances(
         spec_key, spec_version, thread_id, workspace_key, status, last_active_at
       ) VALUES (
         'software-engineer', 1, 'test-workbench-primary',
         'test-workbench-primary', 'running', now()
       )
       ON CONFLICT (thread_id) DO UPDATE
         SET spec_key = excluded.spec_key,
             spec_version = excluded.spec_version,
             status = excluded.status,
             last_active_at = excluded.last_active_at
       RETURNING id`,
    );
    const agentInstanceId = agent.rows[0]?.id;
    if (!agentInstanceId) throw new Error("Development Agent Instance was not created");

    await client.query(
      `INSERT INTO agent_staff.project_agent_instances(project_id, agent_instance_id)
       SELECT $1, $2
       WHERE NOT EXISTS (
         SELECT 1 FROM agent_staff.project_agent_instances
          WHERE project_id = $1 AND unbound_at IS NULL AND is_primary
       )`,
      [projectId, agentInstanceId],
    );
    await client.query(
      `UPDATE agent_staff.project_agent_instances
          SET role = 'backend-module-a'
        WHERE project_id = $1 AND agent_instance_id = $2 AND unbound_at IS NULL`,
      [projectId, agentInstanceId],
    );

    const secondaryAgent = await client.query<{ id: string }>(
      `INSERT INTO agent_staff.agent_instances(
         spec_key, spec_version, thread_id, workspace_key, status, last_active_at
       ) VALUES (
         'software-engineer', 1, 'test-workbench-secondary',
         'test-workbench-secondary', 'idle', now() - interval '8 minutes'
       )
       ON CONFLICT (thread_id) DO UPDATE
         SET spec_key = excluded.spec_key,
             spec_version = excluded.spec_version,
             status = excluded.status,
             last_active_at = excluded.last_active_at
       RETURNING id`,
    );
    const secondaryAgentInstanceId = secondaryAgent.rows[0]?.id;
    if (!secondaryAgentInstanceId) {
      throw new Error("Secondary development Agent Instance was not created");
    }
    await client.query(
      `INSERT INTO agent_staff.project_agent_instances(
         project_id, agent_instance_id, role, is_primary
       )
       SELECT $1, $2, 'backend-module-b', false
       WHERE NOT EXISTS (
         SELECT 1 FROM agent_staff.project_agent_instances
          WHERE agent_instance_id = $2 AND unbound_at IS NULL
       )`,
      [projectId, secondaryAgentInstanceId],
    );

    await seedCompletedRun(client, {
      projectId,
      agentInstanceId,
      eventId: "demo-review-conclusion",
      eventType: "review_conclusion_updated",
      taskSummary: "补充需求评审结论",
      status: "succeeded",
      minutesAgo: 300,
      durationSeconds: 258,
    });
    await seedCompletedRun(client, {
      projectId,
      agentInstanceId,
      eventId: "demo-impact-analysis",
      eventType: "manual_instruction",
      taskSummary: "生成技术影响分析",
      status: "succeeded",
      minutesAgo: 1_600,
      durationSeconds: 483,
    });
    await seedCompletedRun(client, {
      projectId,
      agentInstanceId,
      eventId: "demo-environment-check",
      eventType: "test_environment_ready",
      taskSummary: "检查测试环境依赖",
      status: "failed",
      minutesAgo: 1_700,
      durationSeconds: 161,
    });

    const trigger = await client.query<{ id: string }>(
      `INSERT INTO agent_staff.inbox_events(
         source, external_event_id, project_id, event_type, status, processed_at
       ) VALUES ('feishu', 'demo-requirement-ready', $1, 'requirement_ready', 'completed', now())
       ON CONFLICT (source, external_event_id) DO UPDATE
         SET project_id = excluded.project_id, status = excluded.status, processed_at = now()
       RETURNING id`,
      [projectId],
    );
    const triggerEventId = trigger.rows[0]?.id;
    const activeRun = await client.query<{ id: string }>(
      `INSERT INTO agent_staff.agent_instance_runs(
         project_id, agent_instance_id, trigger_event_id, status, task_summary, started_at
       )
       SELECT $1, $2, $3, 'running', 'Workbench integration task', now() - interval '27 minutes'
       WHERE NOT EXISTS (
         SELECT 1 FROM agent_staff.agent_instance_runs
          WHERE agent_instance_id = $2 AND status IN ('queued','running','waiting_user')
       )
       RETURNING id`,
      [projectId, agentInstanceId, triggerEventId],
    );
    const existingRun = activeRun.rows[0]?.id
      ? activeRun.rows[0]
      : (
          await client.query<{ id: string }>(
            `SELECT id FROM agent_staff.agent_instance_runs
              WHERE agent_instance_id = $1 AND status IN ('queued','running','waiting_user')
              ORDER BY created_at DESC LIMIT 1`,
            [agentInstanceId],
          )
        ).rows[0];
    if (!existingRun?.id) throw new Error("Development Run was not created");

    const events = [
      [1, "context_loading_completed", "读取研发资料", "已读取需求文档、测试 Case 和仓库 AGENTS.md", "completed", 12],
      [2, "code_analysis_completed", "分析代码与影响范围", "确认修改 dev_utils 包，不涉及接口和数据库变更", "completed", 28],
      [3, "implementation_completed", "完成代码开发", "新增分支名称规范化函数及 CLI 入口", "completed", 55],
      [4, "self_test_started", "正在执行项目单元测试", "已通过 18 / 23 项，剩余测试正在运行", "running", 67],
      [5, "git_push_pending", "提交功能分支", "等待自测完成", "pending", null],
      [6, "merge_request_pending", "创建 Merge Request", "等待代码提交", "pending", null],
    ] as const;
    for (const [sequence, eventType, title, detail, state, progressPercent] of events) {
      await client.query(
        `INSERT INTO agent_staff.agent_instance_run_events(
           agent_instance_run_id, sequence_no, event_type, title, detail, data
         ) VALUES ($1, $2, $3::text, $4::text, $5::text, jsonb_build_object(
           'schemaVersion', 1,
           'phase', $3::text,
           'state', $6::text,
           'progressPercent', $7::integer,
           'command', CASE WHEN $3::text = 'self_test_started'
             THEN 'uv run python -m unittest discover -s tests -v' ELSE NULL END
         ))
         ON CONFLICT (agent_instance_run_id, sequence_no) DO UPDATE
           SET event_type = excluded.event_type, title = excluded.title,
               detail = excluded.detail, data = excluded.data`,
        [existingRun.id, sequence, eventType, title, detail, state, progressPercent],
      );
    }

    await client.query("COMMIT");
    return projectId;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}
