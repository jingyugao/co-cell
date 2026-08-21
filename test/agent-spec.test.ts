import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, test } from "vitest";

import { loadAgentSpec } from "../src/specs/loader.js";

const specDirectory = resolve("agent-specs/software-engineer");

describe("loadAgentSpec", () => {
  test("loads unconditional engineering knowledge", async () => {
    const spec = await loadAgentSpec({ directory: specDirectory });

    expect(spec.manifest.id).toBe("software-engineer");
    expect(spec.manifest.sandbox.dockerfile).toBe("sandbox/Dockerfile");
    expect(spec.manifest.prompt).toBe("prompt.txt");
    expect(spec.prompt).toContain("职责或模块：{{role}}");
    expect(spec.prompt).toContain("glab mr create --yes");
    expect(spec.prompt).not.toContain("{{requirement_json}}");
    expect(spec.instructions).toHaveLength(1);
    expect(spec.instructions[0]).toContain("业务架构：[待补充]");
    expect(spec.instructions[0]).toContain("测试环境：[待补充]");
    expect(spec.instructions.join("\n")).toContain("gitlab.example.com/example-user/example-data");
  });

  test("loads the same long-term knowledge for GitLab capability", async () => {
    const spec = await loadAgentSpec({
      directory: specDirectory,
      capabilities: new Set(["gitlab"]),
    });

    expect(spec.instructions).toHaveLength(1);
    expect(spec.prompt).toContain("GitLab 交付规范");
  });

  test("uses the dedicated coding Agent Git identity", async () => {
    const initializer = await readFile(
      resolve(specDirectory, "sandbox/bin/gitlab-init"),
      "utf8",
    );

    expect(initializer).toContain('AGENT_GIT_NAME:-code_agent');
    expect(initializer).toContain('AGENT_GIT_EMAIL:-code_agent@noreply.${email_host}');
  });
});
