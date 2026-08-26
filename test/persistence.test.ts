import { describe, expect, test } from "vitest";

import { runCodingTask } from "../src/agent/coding-agent.js";
import { createPostgresCheckpointer } from "../src/persistence/postgres-checkpointer.js";

const unusedInputHandler = async () => ({ answers: {} });

describe("checkpoint configuration", () => {
  test("rejects an empty PostgreSQL connection string before connecting", async () => {
    await expect(
      createPostgresCheckpointer({ connectionString: "  " }),
    ).rejects.toThrow("must not be empty");
  });

  test("requires durable checkpoint configuration when resuming", async () => {
    await expect(
      runCodingTask({
        workspace: process.cwd(),
        resume: { message: "通过" },
        threadId: "requirement-1",
        requestUserInput: unusedInputHandler,
      }),
    ).rejects.toThrow("checkpointing and threadId are required");
  });
});
