import { describe, expect, test, vi } from "vitest";

import {
  feishuDocumentResource,
  PostgresProjectEventBus,
  SingleAgentProjectEventDispatcher,
} from "../src/events/project-event-bus.js";

describe("project event bus", () => {
  test("normalizes provider-specific document URLs into generic resource IDs", () => {
    expect(feishuDocumentResource("https://example.feishu.cn/docx/document-token"))
      .toEqual({
        resourceId: "docx:document-token",
        fileType: "docx",
        fileToken: "document-token",
      });
    expect(feishuDocumentResource("https://example.feishu.cn/base/base-token"))
      .toEqual({
        resourceId: "bitable:base-token",
        fileType: "bitable",
        fileToken: "base-token",
      });
  });

  test("routes each delivered project to its single active Agent run", async () => {
    const findDispatchTarget = vi.fn(async (projectId: string) =>
      projectId === "project-without-agent"
        ? null
        : { projectId, runId: `run-${projectId}`, agentInstanceId: `agent-${projectId}` }
    );
    const notify = vi.fn();
    const dispatcher = new SingleAgentProjectEventDispatcher(
      { findDispatchTarget },
      { notify },
    );

    await dispatcher.dispatch(["project-1", "project-1", "project-2", "project-without-agent"]);

    expect(findDispatchTarget).toHaveBeenCalledTimes(3);
    expect(notify.mock.calls).toEqual([["run-project-1"], ["run-project-2"]]);
  });

  test("allows a failed Run to be selected for event resume", async () => {
    const query = vi.fn(async (_sql: string) => ({
      rows: [{
        project_id: "project-1",
        run_id: "failed-run",
        agent_instance_id: "agent-1",
      }],
    }));
    const bus = new PostgresProjectEventBus({ query } as never);

    await expect(bus.findDispatchTarget("project-1")).resolves.toEqual({
      projectId: "project-1",
      runId: "failed-run",
      agentInstanceId: "agent-1",
    });
    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain("'failed'");
    expect(sql).toContain("instance.status = 'active'");
  });
});
