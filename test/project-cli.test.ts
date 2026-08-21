import { execFile } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const cliPath = resolve("agent-specs/software-engineer/sandbox/bin/project_cli");
const workItemUrl = "https://project.feishu.cn/example-project/story/detail/1234567890";
const servers: ReturnType<typeof createServer>[] = [];

async function requestBody(request: IncomingMessage): Promise<Record<string, any>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, any>;
}

function rpcToolResponse(response: ServerResponse, id: unknown, value: unknown): void {
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({
    jsonrpc: "2.0",
    id,
    result: { content: [{ type: "text", text: JSON.stringify(value) }] },
  }));
}

async function startMcpServer(
  toolHandler: (name: string, args: Record<string, unknown>) => unknown,
): Promise<{ url: string; calls: Array<{ name: string; args: Record<string, unknown> }> }> {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const server = createServer(async (request, response) => {
    if (request.method === "DELETE") {
      response.statusCode = 204;
      response.end();
      return;
    }
    const body = await requestBody(request);
    if (body.method === "initialize") {
      expect(request.headers.authorization).toBe("Bearer test-secret");
      response.setHeader("content-type", "application/json");
      response.setHeader("mcp-session-id", "test-session");
      response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: {} }));
      return;
    }
    expect(request.headers["mcp-session-id"]).toBe("test-session");
    if (body.method === "notifications/initialized") {
      response.statusCode = 202;
      response.end();
      return;
    }
    const name = String(body.params.name);
    const args = body.params.arguments as Record<string, unknown>;
    calls.push({ name, args });
    rpcToolResponse(response, body.id, toolHandler(name, args));
  });
  servers.push(server);
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("MCP test server did not listen");
  return { url: `http://127.0.0.1:${address.port}/mcp`, calls };
}

async function runCli(url: string, args: string[]) {
  return execFileAsync("bash", [cliPath, ...args], {
    env: {
      ...process.env,
      FEISHU_PROJECT_MCP_URL: url,
      FEISHU_PROJECT_MCP_TOKEN: "test-secret",
      FEISHU_PROJECT_WORK_ITEM_URL: workItemUrl,
    },
  });
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolveClose) => {
    server.close(() => resolveClose());
  })));
});

describe("project_cli", () => {
  test("prints help without requiring credentials", async () => {
    const result = await execFileAsync("bash", [cliPath, "--help"], {
      env: { PATH: process.env.PATH },
    });

    expect(result.stdout).toContain("project_cli status");
    expect(result.stdout).toContain("project_cli comments");
  });

  test("reads the assigned work item and combines every field page", async () => {
    const mcp = await startMcpServer((name, args) => {
      expect(name).toBe("get_workitem_brief");
      const common = {
        work_item_attribute: { work_item_id: "1234567890", work_item_name: "需求" },
        work_item_current_node: [{ id: "dev", name: "开发" }],
      };
      return args.page_token
        ? {
            ...common,
            work_item_fields: [{ key: "priority", name: "优先级", value: "P1" }],
            pagination: { has_more: false, total: 2 },
          }
        : {
            ...common,
            work_item_fields: [{ key: "description", name: "描述", value: "实现告警" }],
            pagination: { has_more: true, total: 2, next_page_token: "next" },
          };
    });

    const result = await runCli(mcp.url, ["status"]);
    const output = JSON.parse(result.stdout);

    expect(output.work_item_fields).toHaveLength(2);
    expect(output.pagination).toMatchObject({ has_more: false, page_size: 2, total: 2 });
    expect(mcp.calls).toHaveLength(2);
    expect(mcp.calls[0]).toEqual({
      name: "get_workitem_brief",
      args: expect.objectContaining({
        url: workItemUrl,
        project_key: "example-project",
        work_item_id: "1234567890",
        fields: ["_all"],
        page_size: 200,
      }),
    });
    expect(mcp.calls.at(1)?.args.page_token).toBe("next");
    expect(result.stdout).not.toContain("test-secret");
  });

  test("reads comments with the requested page", async () => {
    const comments = [{ id: "comment-1", content: "请补充回滚方案" }];
    const mcp = await startMcpServer((name) => {
      expect(name).toBe("list_workitem_comments");
      return { comment_list: comments, total: 1 };
    });

    const result = await runCli(mcp.url, ["comments", "--page", "2"]);

    expect(JSON.parse(result.stdout)).toEqual({ comment_list: comments, total: 1 });
    expect(mcp.calls.at(0)?.args).toEqual({
      project_key: "example-project",
      work_item_id: "1234567890",
      page_num: 2,
    });
  });

  test("reads node details and subtasks", async () => {
    const mcp = await startMcpServer((name) => {
      expect(name).toBe("get_node_detail");
      return { nodes: [{ id: "dev", name: "后端开发" }] };
    });

    const result = await runCli(mcp.url, ["nodes"]);

    expect(JSON.parse(result.stdout)).toEqual({ nodes: [{ id: "dev", name: "后端开发" }] });
    expect(mcp.calls.at(0)?.args).toEqual(expect.objectContaining({
      project_key: "example-project",
      work_item_id: "1234567890",
      node_id_list: ["_all"],
      field_key_list: ["_all"],
      need_sub_task: true,
      page_num: 1,
    }));
  });
});
