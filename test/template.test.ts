import { resolve } from "node:path";

import { describe, expect, test } from "vitest";

import { loadAgentTemplate } from "../src/templates/loader.js";

const templateDirectory = resolve("templates/software-engineer");

describe("loadAgentTemplate", () => {
  test("loads unconditional engineering knowledge", async () => {
    const template = await loadAgentTemplate({ directory: templateDirectory });

    expect(template.manifest.id).toBe("software-engineer");
    expect(template.manifest.sandbox.dockerfile).toBe("sandbox/Dockerfile");
    expect(template.instructions).toHaveLength(1);
    expect(template.instructions[0]).toContain("AI software engineer");
    expect(template.instructions[0]).not.toContain("glab mr create");
  });

  test("loads capability-specific GitLab knowledge", async () => {
    const template = await loadAgentTemplate({
      directory: templateDirectory,
      capabilities: new Set(["gitlab"]),
    });

    expect(template.instructions).toHaveLength(2);
    expect(template.instructions.join("\n")).toContain("glab mr create --yes");
  });
});
