import { describe, expect, test, vi } from "vitest";

import {
  feishuProjectMcpConfigFromEnvironment,
  getCompleteFeishuProjectWorkItem,
  parseFeishuProjectWorkItemUrl,
} from "../src/integrations/feishu-project-mcp.js";

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function toolResponse(body: unknown, isError = false): Response {
  return jsonResponse({
    jsonrpc: "2.0",
    id: 2,
    result: {
      content: [{ type: "text", text: typeof body === "string" ? body : JSON.stringify(body) }],
      ...(isError ? { isError: true } : {}),
    },
  });
}

describe("Feishu Project MCP", () => {
  test("parses a work item URL", () => {
    expect(
      parseFeishuProjectWorkItemUrl(
        "https://project.feishu.cn/example-project/story/detail/1234567890?openScene=4",
      ),
    ).toEqual({
      projectKey: "example-project",
      workItemType: "story",
      workItemId: "1234567890",
    });
  });

  test("loads both conventional and deployed environment variable names", () => {
    expect(
      feishuProjectMcpConfigFromEnvironment({
        FEISHU_PROJECT_MCP_URL: "https://project.example/mcp",
        FEISHU_PROJECT_MCP_TOKEN: "token",
      }),
    ).toMatchObject({ url: "https://project.example/mcp", token: "token" });
    expect(
      feishuProjectMcpConfigFromEnvironment({
        FeishuProjectMcpUrl: "https://project.example/mcp",
        FeishuProjectMcpToken: "token",
      }),
    ).toMatchObject({ url: "https://project.example/mcp", token: "token" });
  });

  test("reads and combines every field page with Bearer authentication", async () => {
    const fetchImplementation = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      const request = JSON.parse(String(init?.body)) as {
        method: string;
        params?: { arguments?: Record<string, unknown> };
      };
      if (request.method === "initialize") {
        return jsonResponse(
          {
            jsonrpc: "2.0",
            id: 1,
            result: {
              protocolVersion: "2025-03-26",
              capabilities: { tools: {} },
              serverInfo: { name: "Meego MCP Server", version: "1.0.0" },
            },
          },
          { headers: { "content-type": "application/json", "mcp-session-id": "session-1" } },
        );
      }
      if (request.method === "notifications/initialized") {
        return new Response(null, { status: 202 });
      }
      const pageToken = request.params?.arguments?.page_token;
      return pageToken
        ? toolResponse({
            work_item_attribute: { work_item_id: "1234567890", work_item_name: "需求" },
            work_item_fields: [{ key: "priority", name: "优先级", value: "P2" }],
            work_item_current_node: [{ id: "development", name: "开发" }],
            pagination: { page_size: 1, has_more: false, total: 2 },
          })
        : toolResponse({
            work_item_attribute: { work_item_id: "1234567890", work_item_name: "需求" },
            work_item_fields: [{ key: "description", name: "描述", value: "内容" }],
            work_item_current_node: [{ id: "development", name: "开发" }],
            pagination: {
              page_size: 1,
              has_more: true,
              total: 2,
              next_page_token: "page-2",
            },
          });
    });

    const result = await getCompleteFeishuProjectWorkItem(
      {
        url: "https://project.feishu.cn/mcp_server/v1,",
        token: "Bearer secret-token",
        fetchImplementation,
      },
      {
        url: "https://project.feishu.cn/example-project/story/detail/1234567890",
      },
    );

    expect(result.work_item_fields).toEqual([
      { key: "description", name: "描述", value: "内容" },
      { key: "priority", name: "优先级", value: "P2" },
    ]);
    expect(result.pagination).toMatchObject({ has_more: false, page_size: 2, total: 2 });
    expect(fetchImplementation).toHaveBeenCalledTimes(5);
    for (const [, init] of fetchImplementation.mock.calls) {
      expect((init?.headers as Record<string, string>).authorization).toBe(
        "Bearer secret-token",
      );
    }
    const toolCalls = fetchImplementation.mock.calls
      .map(([, init]) => (init?.body ? JSON.parse(String(init.body)) : undefined))
      .filter((body) => body?.method === "tools/call");
    expect(toolCalls).toHaveLength(2);
    expect(toolCalls[0].params.arguments).toMatchObject({
      project_key: "example-project",
      work_item_id: "1234567890",
      fields: ["_all"],
      page_size: 200,
    });
    expect(toolCalls[1].params.arguments.page_token).toBe("page-2");
  });

  test("surfaces MCP business errors", async () => {
    const fetchImplementation = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      const request = JSON.parse(String(init?.body)) as { method: string };
      if (request.method === "initialize") {
        return jsonResponse(
          { jsonrpc: "2.0", id: 1, result: {} },
          { headers: { "content-type": "application/json", "mcp-session-id": "session-1" } },
        );
      }
      if (request.method === "notifications/initialized") {
        return new Response(null, { status: 202 });
      }
      return toolResponse(
        "error=MCPGatewayRequestMissing,message=project_key is empty,retriable=false",
        true,
      );
    });

    await expect(
      getCompleteFeishuProjectWorkItem(
        {
          url: "https://project.feishu.cn/mcp_server/v1",
          token: "token",
          fetchImplementation,
        },
        { projectKey: "space", workItemId: "1" },
      ),
    ).rejects.toThrow("MCPGatewayRequestMissing: project_key is empty");
  });
});
