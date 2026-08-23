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
    expect(spec.prompt).not.toContain("{{");
    expect(spec.prompt).toContain("glab mr create --yes");
    expect(spec.prompt).not.toContain("{{requirement_json}}");
    expect(spec.instructions).toHaveLength(3);
    expect(spec.instructions[0]).toContain("业务架构：[待补充]");
    expect(spec.instructions[0]).toContain("测试环境：[待补充]");
    expect(spec.instructions.join("\n")).toContain("gitlab.example.com/example-user/example-data");
    expect(spec.instructions.join("\n")).toContain("meegle url decode");
    expect(spec.instructions.join("\n")).toContain("lark-cli docs +fetch");
    expect(spec.instructions.join("\n")).toContain("solution_design");
    expect(spec.instructions.join("\n")).toContain("production_verification");
    expect(spec.instructions.join("\n")).toContain("form_item_type=field");
    expect(spec.instructions.join("\n")).toContain("飞书文档");
    expect(spec.instructions[2]).toContain("需求文档可以很短");
    expect(spec.instructions[2]).toContain("技术方案深度必须与需求规模和风险匹配");
    expect(spec.instructions[1]).toContain('--fields \'["description","wiki"]\'');
    expect(spec.instructions[2]).toContain("永远禁止覆盖");
    expect(spec.instructions[2]).toContain("简单模板没有专用技术方案字段时，不修改任何 Meegle 链接字段");
    expect(spec.prompt).toContain("solution_design");
    expect(spec.prompt).toContain("统一遵循“单 Agent 研发交付流程”");
    expect(spec.prompt).not.toContain("project_cli");
  });

  test("loads the same long-term knowledge for GitLab capability", async () => {
    const spec = await loadAgentSpec({
      directory: specDirectory,
      capabilities: new Set(["gitlab"]),
    });

    expect(spec.instructions).toHaveLength(3);
    expect(spec.prompt).toContain("GitLab 交付规范");
  });

  test("starts a Run with only the Feishu Project URL as task input", async () => {
    const launcher = await readFile(
      resolve("src/application/coding-run-launcher.ts"),
      "utf8",
    );

    expect(launcher).not.toContain("this.options.source.get");
    expect(launcher).toContain("buildFeishuProjectTaskPrompt(spec.prompt, context.sourceUrl)");
    expect(launcher).not.toContain("role: context.role");
  });

  test("uses the dedicated coding Agent Git identity", async () => {
    const initializer = await readFile(
      resolve(specDirectory, "sandbox/bin/gitlab-init"),
      "utf8",
    );

    expect(initializer).toContain('AGENT_GIT_NAME:-code_agent');
    expect(initializer).toContain('AGENT_GIT_EMAIL:-code_agent@noreply.${email_host}');
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
