import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, test } from "vitest";

import { loadAgentSpec } from "../src/specs/loader.js";

const specDirectory = resolve("agent-specs/software-engineer");

describe("loadAgentSpec", () => {
  test("loads one prompt and one memory file", async () => {
    const spec = await loadAgentSpec({ directory: specDirectory });

    expect(spec.manifest.id).toBe("software-engineer");
    expect(spec.manifest.sandbox.dockerfile).toBe("sandbox/Dockerfile");
    expect(spec.manifest.prompt).toBe("prompt.txt");
    expect(spec.manifest.memory).toBe("memory.txt");
    expect(spec.manifest.defaultResponsibility).toContain("代码开发");
    expect(spec.prompt).not.toContain("{{");
    expect(spec.prompt).toContain("task_list");
    expect(spec.prompt).toContain("project_publish");
    expect(spec.prompt).not.toContain("{{requirement_json}}");
    expect(spec.memorySeed).toContain("example-data");
    expect(spec.memorySeed).toContain("Meegle");
    expect(spec.memorySeed).toContain("技术方案调研");
    expect(spec.memorySeed).toContain("example-tool-server");
    expect(spec.prompt).not.toContain("project_cli");
  });

  test("starts a Run with only the Feishu Project URL as task input", async () => {
    const launcher = await readFile(
      resolve("src/application/coding-run-launcher.ts"),
      "utf8",
    );

    expect(launcher).not.toContain("this.options.source.get");
    expect(launcher).toContain("buildSessionRunPrompt({");
    expect(launcher).toContain("isFirstRunInSession: context.isFirstRunInSession");
    expect(launcher).toContain("spec.prompt");
    expect(launcher).toContain("getAgentSessionMemory(context.sessionId)");
    expect(launcher).toContain("context.responsibility");
  });

  test("uses the dedicated coding Agent Git identity", async () => {
    const initializer = await readFile(
      resolve(specDirectory, "sandbox/bin/gitlab-init"),
      "utf8",
    );

    expect(initializer).toContain('AGENT_GIT_NAME:-code_agent');
    expect(initializer).toContain('AGENT_GIT_EMAIL:-code_agent@noreply.${email_host}');
    expect(initializer).toContain("Always refresh the stored credential");
  });

  test("installs native Feishu CLIs into the persistent Spec HOME", async () => {
    const [dockerfile, tools, initializer] = await Promise.all([
      readFile(resolve(specDirectory, "sandbox/Dockerfile"), "utf8"),
      readFile(resolve(specDirectory, "sandbox/bin/tools-init"), "utf8"),
      readFile(resolve(specDirectory, "sandbox/bin/feishu-init"), "utf8"),
    ]);

    expect(dockerfile).not.toContain("@lark-project/meegle@");
    expect(dockerfile).not.toContain("@larksuite/cli@");
    expect(dockerfile).not.toContain("project_cli");
    expect(tools).toContain('npm install --global "@lark-project/meegle@$meegle_version"');
    expect(tools).toContain('npm install --global "@larksuite/cli@$lark_cli_version"');
    expect(initializer).toContain("MEEGLE_USER_ACCESS_TOKEN is required");
    expect(initializer).not.toContain('$HOME/.meegle');
    expect(initializer).toContain("meegle auth status --format json");
    expect(initializer).toContain("lark-cli auth status --json");
  });
});
