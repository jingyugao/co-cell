import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import {
  AGENT_MEMORY_SANDBOX_PATH,
  loadAgentMemory,
  renderAgentMemoryInstructions,
} from "../src/specs/memory.js";

describe("Agent Instance Memory", () => {
  test("persists one bounded file in the Spec HOME and renders it as advisory context", async () => {
    const home = await mkdtemp(join(tmpdir(), "swarm-hive-spec-memory-"));
    try {
      const initial = await loadAgentMemory(home, "# Seed Memory\n\n- initial convention");
      expect(initial.content).toContain("initial convention");
      expect(initial.sandboxPath).toBe(AGENT_MEMORY_SANDBOX_PATH);

      await writeFile(initial.hostPath, "# Agent Instance Memory\n\n- verified convention\n", "utf8");
      const reloaded = await loadAgentMemory(home, "# Replacement Seed");
      expect(reloaded.content).toContain("verified convention");
      expect(reloaded.content).not.toContain("Replacement Seed");
      expect(renderAgentMemoryInstructions(reloaded)).toContain("下一个 Session 生效");
      expect(await readFile(initial.hostPath, "utf8")).toContain("verified convention");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
