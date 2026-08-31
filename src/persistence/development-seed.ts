import type { PoolClient } from "pg";
import { Pool } from "pg";

export const WORKBENCH_TEST_PROJECT_EXTERNAL_ID = "TEST-WORKBENCH-PROJECT";

async function seedCompletedRun(
  client: PoolClient,
  options: {
    projectId: string;
    agentInstanceId: string;
    agentSessionId: string;
    eventId: string;
    eventType: string;
    taskSummary: string;
    status: "succeeded" | "failed";
    minutesAgo: number;
    durationSeconds: number;
  },
): Promise<void> {
  const event = await client.query<{ id: string }>(
    `INSERT INTO swarm_hive.inbox_events(
       source, external_event_id, project_id, event_type, status, processed_at,
       received_at
     ) VALUES ('feishu', $1, $2, $3, 'completed', now(), now() - ($4 * interval '1 minute'))
     ON CONFLICT (project_id, source, external_event_id) DO UPDATE
       SET project_id = excluded.project_id, event_type = excluded.event_type
     RETURNING id`,
    [options.eventId, options.projectId, options.eventType, options.minutesAgo],
  );
  await client.query(
    `INSERT INTO swarm_hive.agent_runs(
       project_id, agent_instance_id, agent_session_id, trigger_event_id, status, task_summary,
       result_summary, started_at, finished_at, created_at
     )
     SELECT $1, $2, $3, $4, $5, $6,
            CASE WHEN $5 = 'succeeded' THEN '任务执行完成' ELSE '测试环境依赖检查失败' END,
            now() - ($7 * interval '1 minute'),
            now() - ($7 * interval '1 minute') + ($8 * interval '1 second'),
            now() - ($7 * interval '1 minute')
     WHERE NOT EXISTS (
       SELECT 1 FROM swarm_hive.agent_runs WHERE trigger_event_id = $4
     )`,
    [
      options.projectId,
      options.agentInstanceId,
      options.agentSessionId,
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
      `INSERT INTO swarm_hive.projects(
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
      `INSERT INTO swarm_hive.agent_instances(
         spec_key, spec_version, instance_key, home_key, status, last_active_at
       ) VALUES (
         'software-engineer', 1, 'default',
         'software-engineer:default', 'active', now()
       )
       ON CONFLICT (spec_key, instance_key) DO UPDATE
         SET spec_version = excluded.spec_version,
             status = excluded.status,
             last_active_at = excluded.last_active_at
       RETURNING id`,
    );
    const agentInstanceId = agent.rows[0]?.id;
    if (!agentInstanceId) throw new Error("Development Agent Instance was not created");

    const seat = await client.query<{ id: string }>(
      `INSERT INTO swarm_hive.agent_seats(
         project_id, agent_instance_id, responsibility, is_coordinator, workspace_key
       ) SELECT $1, $2, 'backend-module-a', true, 'test-workbench-seat'
       WHERE NOT EXISTS (
         SELECT 1 FROM swarm_hive.agent_seats
          WHERE project_id = $1 AND released_at IS NULL AND is_coordinator
       )
       RETURNING id`,
      [projectId, agentInstanceId],
    );
    const seatId = seat.rows[0]?.id ?? (
      await client.query<{ id: string }>(
        `SELECT id FROM swarm_hive.agent_seats
          WHERE project_id = $1 AND released_at IS NULL AND is_coordinator`,
        [projectId],
      )
    ).rows[0]?.id;
    if (!seatId) throw new Error("Development Agent Seat was not created");
    const session = await client.query<{ id: string }>(
      `INSERT INTO swarm_hive.agent_sessions(agent_seat_id, thread_id, last_active_at)
       VALUES ($1, 'test-workbench-coordinator', now())
       ON CONFLICT (thread_id) DO UPDATE SET last_active_at = excluded.last_active_at
       RETURNING id`,
      [seatId],
    );
    const agentSessionId = session.rows[0]?.id;
    if (!agentSessionId) throw new Error("Development Agent Session was not created");

    await seedCompletedRun(client, {
      projectId,
      agentInstanceId,
      agentSessionId,
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
      agentSessionId,
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
      agentSessionId,
      eventId: "demo-environment-check",
      eventType: "test_environment_ready",
      taskSummary: "检查测试环境依赖",
      status: "failed",
      minutesAgo: 1_700,
      durationSeconds: 161,
    });

    const trigger = await client.query<{ id: string }>(
      `INSERT INTO swarm_hive.inbox_events(
         source, external_event_id, project_id, event_type, status, processed_at
       ) VALUES ('feishu', 'demo-requirement-ready', $1, 'requirement_ready', 'completed', now())
       ON CONFLICT (project_id, source, external_event_id) DO UPDATE
         SET project_id = excluded.project_id, status = excluded.status, processed_at = now()
       RETURNING id`,
      [projectId],
    );
    const triggerEventId = trigger.rows[0]?.id;
    const activeRun = await client.query<{ id: string }>(
      `INSERT INTO swarm_hive.agent_runs(
         project_id, agent_instance_id, agent_session_id, trigger_event_id, status, task_summary, started_at
       )
       SELECT $1, $2, $3, $4, 'running', 'Workbench integration task', now() - interval '27 minutes'
       WHERE NOT EXISTS (
         SELECT 1 FROM swarm_hive.agent_runs
          WHERE agent_session_id = $3 AND status IN ('queued','running','waiting_user')
       )
       RETURNING id`,
      [projectId, agentInstanceId, agentSessionId, triggerEventId],
    );
    const existingRun = activeRun.rows[0]?.id
      ? activeRun.rows[0]
      : (
          await client.query<{ id: string }>(
            `SELECT id FROM swarm_hive.agent_runs
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
        `INSERT INTO swarm_hive.agent_run_events(
           agent_run_id, sequence_no, event_type, title, detail, data
         ) VALUES ($1, $2, $3::text, $4::text, $5::text, jsonb_build_object(
           'schemaVersion', 1,
           'phase', $3::text,
           'state', $6::text,
           'progressPercent', $7::integer,
           'command', CASE WHEN $3::text = 'self_test_started'
             THEN 'uv run python -m unittest discover -s tests -v' ELSE NULL END
         ))
         ON CONFLICT (agent_run_id, sequence_no) DO UPDATE
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
