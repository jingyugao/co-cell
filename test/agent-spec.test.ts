import { resolve } from "node:path";

import { describe, expect, test } from "vitest";

import { loadAgentSpec } from "../src/specs/loader.js";

const specDirectory = resolve("agent-specs/software-engineer");

describe("loadAgentSpec", () => {
  test("loads unconditional engineering knowledge", async () => {
    const spec = await loadAgentSpec({ directory: specDirectory });

    expect(spec.manifest.id).toBe("software-engineer");
    expect(spec.manifest.sandbox.dockerfile).toBe("sandbox/Dockerfile");
    expect(spec.manifest.taskPrompt).toBe("prompts/development-task.txt");
    expect(spec.taskPrompt).toContain("你负责的职责：{{role}}");
    expect(spec.taskPrompt).toContain("{{requirement_json}}");
    expect(spec.instructions).toHaveLength(1);
    expect(spec.instructions[0]).toContain("AI software engineer");
    expect(spec.instructions[0]).not.toContain("glab mr create");
  });

  test("loads capability-specific GitLab knowledge", async () => {
    const spec = await loadAgentSpec({
      directory: specDirectory,
      capabilities: new Set(["gitlab"]),
    });

    expect(spec.instructions).toHaveLength(2);
    expect(spec.instructions.join("\n")).toContain("glab mr create --yes");
  });
});
