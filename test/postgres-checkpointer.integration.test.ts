import { randomUUID } from "node:crypto";

import {
  Command,
  END,
  interrupt,
  START,
  StateGraph,
  StateSchema,
} from "@langchain/langgraph";
import { afterEach, describe, expect, test } from "vitest";
import { z } from "zod";

import {
  createPostgresCheckpointer,
  type PostgresCheckpointerHandle,
} from "../src/persistence/postgres-checkpointer.js";

const databaseUrl = process.env.AGENT_CHECKPOINT_TEST_DATABASE_URL;
const describePostgres = databaseUrl ? describe : describe.skip;
const handles: PostgresCheckpointerHandle[] = [];

const ApprovalState = new StateSchema({
  task: z.string(),
  approved: z.boolean().optional(),
});

function buildApprovalGraph(checkpointer: PostgresCheckpointerHandle["checkpointer"]) {
  return new StateGraph(ApprovalState)
    .addNode("approval", (state) => {
      const approved = interrupt({
        question: `Approve ${state.task}?`,
      });
      return { approved: approved === true };
    })
    .addEdge(START, "approval")
    .addEdge("approval", END)
    .compile({ checkpointer });
}

afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.close()));
});

describePostgres("PostgreSQL checkpoint integration", () => {
  test("resumes an interrupted thread after recreating the runtime", async () => {
    const threadId = `integration-${randomUUID()}`;
    const config = {
      configurable: { thread_id: threadId },
      durability: "sync" as const,
    };

    const firstHandle = await createPostgresCheckpointer({
      connectionString: databaseUrl!,
    });
    handles.push(firstHandle);
    const firstGraph = buildApprovalGraph(firstHandle.checkpointer);
    const interrupted = await firstGraph.invoke(
      { task: "deploy coding agent" },
      config,
    );
    expect(
      (interrupted as typeof interrupted & { __interrupt__: unknown[] })
        .__interrupt__,
    ).toHaveLength(1);

    await firstHandle.close();
    handles.splice(handles.indexOf(firstHandle), 1);

    const secondHandle = await createPostgresCheckpointer({
      connectionString: databaseUrl!,
    });
    handles.push(secondHandle);
    const restoredGraph = buildApprovalGraph(secondHandle.checkpointer);
    const completed = await restoredGraph.invoke(
      new Command({ resume: true }),
      config,
    );

    expect(completed).toMatchObject({
      task: "deploy coding agent",
      approved: true,
    });
    const snapshot = await restoredGraph.getState(config);
    expect(snapshot.next).toEqual([]);

    const history = [];
    for await (const state of restoredGraph.getStateHistory(config)) {
      history.push(state);
    }
    expect(history.length).toBeGreaterThanOrEqual(3);

    await secondHandle.checkpointer.deleteThread(threadId);
  });
});
