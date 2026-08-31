import { describe, expect, test, vi } from "vitest";

import {
  feishuDocumentResource,
  PostgresProjectEventBus,
  CoordinatorProjectEventDispatcher,
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

  test("routes each delivered project to its Coordinator run", async () => {
    const findDispatchTarget = vi.fn(async (projectId: string) =>
      projectId === "project-without-agent"
        ? null
        : { projectId, runId: `run-${projectId}`, seatId: `seat-${projectId}` }
    );
    const notify = vi.fn();
    const dispatcher = new CoordinatorProjectEventDispatcher(
      { findDispatchTarget },
      { notify },
    );

    await dispatcher.dispatch(["project-1", "project-1", "project-2", "project-without-agent"]);

    expect(findDispatchTarget).toHaveBeenCalledTimes(3);
    expect(notify.mock.calls).toEqual([["run-project-1"], ["run-project-2"]]);
  });

  test("does not select failed Runs for event delivery", async () => {
    const query = vi.fn(async (_sql: string) => ({ rows: [] }));
    const bus = new PostgresProjectEventBus({ query } as never);

    await expect(bus.findDispatchTarget("project-1")).resolves.toBeNull();
    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).not.toContain("'failed'");
    expect(sql).toContain("instance.status = 'active'");
    expect(sql).toContain("seat.is_coordinator");
  });

  test("only lets the Coordinator claim project events unless a Seat is targeted", async () => {
    const query = vi.fn(async (_sql: string) => ({ rows: [] }));
    const bus = new PostgresProjectEventBus({ query } as never);

    await bus.claimPendingEvents("run-1");

    const sql = String(query.mock.calls.at(-1)?.[0]);
    expect(sql).toContain("event.target_agent_seat_id = seat.id");
    expect(sql).toContain("event.target_agent_seat_id IS NULL AND seat.is_coordinator");
  });
});
