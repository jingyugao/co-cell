import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { BashProcessManager } from "../src/tools/bash.js";

const managers: BashProcessManager[] = [];

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.dispose()));
});

describe("BashProcessManager", () => {
  test("runs a command in the workspace", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "bash-tool-"));
    await writeFile(join(workspace, "hello.txt"), "hello\n");
    const manager = await BashProcessManager.create({ workspace });
    managers.push(manager);

    const result = await manager.execute({
      cmd: "sed -n '1p' hello.txt",
      workdir: ".",
    });

    expect(result.exit_code).toBe(0);
    expect(result.output).toBe("hello\n");
  });

  test("continues a long-running command", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "bash-tool-"));
    const manager = await BashProcessManager.create({ workspace });
    managers.push(manager);

    const started = await manager.execute({
      cmd: "sleep 0.5; echo done",
      workdir: ".",
      yield_time_ms: 250,
    });
    expect(started.session_id).toBeTypeOf("string");

    const finished = await manager.execute({
      session_id: started.session_id,
      yield_time_ms: 1_000,
    });
    expect(finished.exit_code).toBe(0);
    expect(finished.output).toContain("done");
  });

  test("rejects a workdir outside the workspace", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "bash-tool-"));
    const manager = await BashProcessManager.create({ workspace });
    managers.push(manager);

    await expect(
      manager.execute({ cmd: "pwd", workdir: await realpath(tmpdir()) }),
    ).rejects.toThrow("outside sandbox workspace");
  });
});
