import { resolve } from "node:path";

import { describe, expect, test } from "vitest";

import { FilesystemAgentSpecCatalog } from "../src/server/agent-spec-catalog.js";

describe("filesystem Agent Spec catalog", () => {
  test("lists validated Agent Spec manifests without exposing environment values", async () => {
    const catalog = new FilesystemAgentSpecCatalog(resolve("agent-specs"));
    const result = await catalog.list();
    expect(result.items).toEqual([
      expect.objectContaining({
        id: "software-engineer",
        name: "Software Engineer",
        version: 8,
        environmentExample: ".env.example",
      }),
    ]);
    expect(JSON.stringify(result)).not.toContain("OPENAI_API_KEY");
  });
});
