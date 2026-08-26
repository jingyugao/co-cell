import { describe, expect, test, vi } from "vitest";

import {
  McpFeishuWorkItemSource,
  RequirementWorkflowService,
} from "../src/application/requirement-workflow-service.js";
import type { PostgresWorkbenchRepository } from "../src/persistence/workbench-repository.js";

const sourceUrl = "https://project.feishu.cn/example-project/story/detail/1234567890";

function rawWorkItem() {
  return {
    work_item_attribute: {
      owned_project: { key: "space-key", simple_name: "example-project", name: "研发空间" },
      work_item_id: "1234567890",
      work_item_name: "实时需求",
      work_item_type: { key: "story", name: "需求" },
      work_item_status: { key: "developing", name: "开发中" },
      role_members: [{ key: "berd", name: "后端开发", members: [{ key: "u1", name: "研发" }] }],
      update_time: "2026-08-21T10:00:00+08:00",
    },
    work_item_fields: [{ key: "description", name: "描述", value: "需求正文" }],
    work_item_current_node: [{ id: "develop", name: "后端开发", owners: [{ key: "u1", name: "研发" }] }],
  };
}

describe("Requirement workflow", () => {
  test("normalizes live MCP data without persistence", async () => {
    const load = vi.fn(async () => rawWorkItem());
    const source = new McpFeishuWorkItemSource(load);
    const result = await source.get(sourceUrl);
    expect(result.preview).toMatchObject({
      sourceUrl,
      projectKey: "space-key",
      title: "实时需求",
      status: { name: "开发中" },
      currentNodes: [{ name: "后端开发", owners: [{ name: "研发" }] }],
    });
    expect(load).toHaveBeenCalledWith(sourceUrl);
  });

  test("reads Feishu again before saving only an Agent assignment", async () => {
    const source = new McpFeishuWorkItemSource(async () => rawWorkItem());
    const createAgentFork = vi.fn(async (input) => ({
      projectId: "project-id",
      forkId: "fork-id",
      role: input.role,
      agentInstance: {
        id: "instance-id",
        specKey: input.specKey,
        specVersion: input.specVersion,
        status: "active" as const,
      },
      session: {
        id: "session-id",
        workspaceKey: input.workspaceKey,
        threadId: input.threadId,
        status: "active" as const,
      },
      currentRun: null,
    }));
    const repository = { createAgentFork } as unknown as PostgresWorkbenchRepository;
    const service = new RequirementWorkflowService(
      source,
      repository,
      {
        list: async () => ({ items: [] }),
        get: async () => ({
          id: "software-engineer",
          name: "Software Engineer",
          version: 1,
          memory: "memory.txt",
          sandbox: { dockerfile: "sandbox/Dockerfile", image: "image" },
          environmentExample: ".env.example",
        }),
      },
      {
        launch: vi.fn(),
        notify: vi.fn(),
        resume: vi.fn(async (runId: string) => ({ runId, status: "running" as const })),
        cancel: vi.fn(async (runId: string) => ({
          runId,
          agentInstanceId: "instance-id",
          status: "cancelled" as const,
        })),
      },
    );
    await service.fork({
      url: sourceUrl,
      specKey: "software-engineer",
      role: "backend-a",
    });
    expect(createAgentFork).toHaveBeenCalledWith(expect.objectContaining({
      sourceUrl,
      externalProjectKey: "space-key",
      externalWorkItemType: "story",
      externalWorkItemId: "1234567890",
      role: "backend-a",
    }));
    const persisted = createAgentFork.mock.calls[0]?.[0];
    expect(persisted).not.toHaveProperty("title");
    expect(persisted).not.toHaveProperty("fields");
    expect(persisted).not.toHaveProperty("status");
  });
});
