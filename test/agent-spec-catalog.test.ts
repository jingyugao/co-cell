import { resolve } from "node:path";

import { describe, expect, test } from "vitest";

import { FilesystemAgentSpecCatalog } from "../src/server/agent-spec-catalog.js";

describe("filesystem Agent Spec catalog", () => {
  test("lists validated Agent Spec manifests without exposing environment values", async () => {
    const catalog = new FilesystemAgentSpecCatalog(resolve("agent-specs"));
    const result = await catalog.list();
    expect(result.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "project-coordinator", name: "Project Coordinator" }),
      expect.objectContaining({
        id: "software-engineer",
        name: "Software Engineer",
        version: 13,
        defaultResponsibility: "代码开发、自测、环境验证和 Merge Request 交付",
        memory: "memory.txt",
        environmentExample: ".env.example",
      }),
    ]));
    expect(JSON.stringify(result)).not.toContain("OPENAI_API_KEY");
    const definition = await catalog.getDefinition("software-engineer");
    expect(definition?.prompt).toContain("软件工程师");
    expect(definition?.memory).toBeTruthy();
  });
});
