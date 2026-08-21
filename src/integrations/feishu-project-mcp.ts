export interface FeishuProjectMcpConfig {
  url: string;
  token: string;
  fetchImplementation?: typeof fetch;
  protocolVersion?: string;
}

export interface FeishuProjectWorkItemReference {
  url?: string;
  projectKey?: string;
  workItemId?: string;
}

export interface FeishuProjectWorkItemField {
  key: string;
  name: string;
  value: unknown;
  [key: string]: unknown;
}

export interface FeishuProjectWorkItemDetails {
  work_item_attribute: Record<string, unknown>;
  work_item_fields: FeishuProjectWorkItemField[];
  work_item_current_node: Record<string, unknown>[];
  pagination?: {
    page_size?: number;
    has_more?: boolean;
    total?: number;
    next_page_token?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

interface JsonRpcResponse {
  jsonrpc?: string;
  id?: string | number | null;
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
    data?: unknown;
  };
}

interface McpTextContent {
  type: "text";
  text: string;
}

interface McpToolResult {
  content?: Array<McpTextContent | Record<string, unknown>>;
  isError?: boolean;
}

const DEFAULT_PROTOCOL_VERSION = "2025-03-26";
const MAX_FIELD_PAGES = 100;

function requiredEnvironmentValue(
  environment: NodeJS.ProcessEnv,
  names: readonly string[],
): string {
  for (const name of names) {
    const value = environment[name]?.trim();
    if (value) return value;
  }
  throw new Error(`Set ${names.join(" or ")}`);
}

export function feishuProjectMcpConfigFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): FeishuProjectMcpConfig {
  return {
    url: requiredEnvironmentValue(environment, [
      "FEISHU_PROJECT_MCP_URL",
      "FeishuProjectMcpUrl",
    ]),
    token: requiredEnvironmentValue(environment, [
      "FEISHU_PROJECT_MCP_TOKEN",
      "FeishuProjectMcpToken",
    ]),
  };
}

export function parseFeishuProjectWorkItemUrl(value: string): {
  projectKey: string;
  workItemType: string;
  workItemId: string;
} {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Invalid Feishu Project work item URL");
  }
  if (url.protocol !== "https:") {
    throw new Error("Feishu Project work item URL must use HTTPS");
  }
  const segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (segments.length < 4 || segments[2] !== "detail") {
    throw new Error(
      "Expected a Feishu Project work item URL like /{project}/{type}/detail/{id}",
    );
  }
  const [projectKey, workItemType, , workItemId] = segments;
  if (!projectKey || !workItemType || !workItemId) {
    throw new Error("Feishu Project URL is missing project, type, or work item ID");
  }
  return { projectKey, workItemType, workItemId };
}

function normalizeConfig(config: FeishuProjectMcpConfig): Required<
  Pick<FeishuProjectMcpConfig, "url" | "token" | "protocolVersion">
> & { fetchImplementation: typeof fetch } {
  const rawUrl = config.url.trim().replace(/,+$/, "");
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("Feishu Project MCP URL is invalid");
  }
  if (url.protocol !== "https:" && url.hostname !== "localhost") {
    throw new Error("Feishu Project MCP URL must use HTTPS");
  }
  const token = config.token.trim().replace(/^Bearer\s+/i, "");
  if (!token) throw new Error("Feishu Project MCP token is empty");
  return {
    url: url.toString(),
    token,
    protocolVersion: config.protocolVersion ?? DEFAULT_PROTOCOL_VERSION,
    fetchImplementation: config.fetchImplementation ?? fetch,
  };
}

function parseJsonRpcPayload(text: string, contentType: string | null): JsonRpcResponse {
  if (contentType?.includes("text/event-stream")) {
    const data = text
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .filter((line) => line && line !== "[DONE]")
      .at(-1);
    if (!data) throw new Error("MCP server returned an empty event stream");
    return JSON.parse(data) as JsonRpcResponse;
  }
  return JSON.parse(text) as JsonRpcResponse;
}

function toolErrorMessage(result: McpToolResult): string {
  const text = result.content
    ?.filter((item): item is McpTextContent => item.type === "text")
    .map((item) => item.text)
    .find((item) => item && !item.startsWith("logid:"));
  if (!text) return "Feishu Project MCP tool failed";
  const message = text.match(/(?:^|,)message=([^,]+)(?:,|$)/)?.[1];
  const code = text.match(/(?:^|,)error=([^,]+)(?:,|$)/)?.[1];
  return [code, message].filter(Boolean).join(": ") || text;
}

function parseToolJson<T>(result: McpToolResult): T {
  if (result.isError) throw new Error(toolErrorMessage(result));
  const text = result.content
    ?.filter((item): item is McpTextContent => item.type === "text")
    .map((item) => item.text)
    .find((item) => item.trimStart().startsWith("{") || item.trimStart().startsWith("["));
  if (!text) throw new Error("Feishu Project MCP tool returned no JSON content");
  return JSON.parse(text) as T;
}

function validateWorkItemDetails(value: unknown): FeishuProjectWorkItemDetails {
  if (!value || typeof value !== "object") {
    throw new Error("Feishu Project returned an invalid work item response");
  }
  const details = value as Partial<FeishuProjectWorkItemDetails>;
  if (!details.work_item_attribute || typeof details.work_item_attribute !== "object") {
    throw new Error("Feishu Project response is missing work_item_attribute");
  }
  if (!Array.isArray(details.work_item_fields)) {
    throw new Error("Feishu Project response is missing work_item_fields");
  }
  if (!Array.isArray(details.work_item_current_node)) {
    throw new Error("Feishu Project response is missing work_item_current_node");
  }
  return details as FeishuProjectWorkItemDetails;
}

export class FeishuProjectMcpClient {
  private readonly config: ReturnType<typeof normalizeConfig>;
  private sessionId?: string;
  private nextRequestId = 1;

  constructor(config: FeishuProjectMcpConfig) {
    this.config = normalizeConfig(config);
  }

  async connect(): Promise<void> {
    if (this.sessionId) return;
    const response = await this.send(
      {
        jsonrpc: "2.0",
        id: this.nextRequestId++,
        method: "initialize",
        params: {
          protocolVersion: this.config.protocolVersion,
          capabilities: {},
          clientInfo: { name: "swarm-hive", version: "0.1.0" },
        },
      },
      false,
    );
    if (response.error) {
      throw new Error(response.error.message ?? "Feishu Project MCP initialization failed");
    }
    if (!this.sessionId) {
      throw new Error("Feishu Project MCP did not create a session");
    }
    await this.sendNotification("notifications/initialized");
  }

  async callTool<T>(name: string, args: Record<string, unknown>): Promise<T> {
    await this.connect();
    const response = await this.send({
      jsonrpc: "2.0",
      id: this.nextRequestId++,
      method: "tools/call",
      params: { name, arguments: args },
    });
    if (response.error) {
      throw new Error(response.error.message ?? `MCP tool ${name} failed`);
    }
    return parseToolJson<T>(response.result as McpToolResult);
  }

  async close(): Promise<void> {
    if (!this.sessionId) return;
    const sessionId = this.sessionId;
    this.sessionId = undefined;
    try {
      await this.config.fetchImplementation(this.config.url, {
        method: "DELETE",
        headers: this.headers(sessionId),
      });
    } catch {
      // Session cleanup is best effort and must not hide a successful read.
    }
  }

  private async sendNotification(method: string): Promise<void> {
    const response = await this.config.fetchImplementation(this.config.url, {
      method: "POST",
      headers: this.headers(this.sessionId),
      body: JSON.stringify({ jsonrpc: "2.0", method }),
    });
    if (!response.ok) {
      throw new Error(`Feishu Project MCP notification failed with HTTP ${response.status}`);
    }
  }

  private async send(
    body: Record<string, unknown>,
    requireSession = true,
  ): Promise<JsonRpcResponse> {
    if (requireSession && !this.sessionId) {
      throw new Error("Feishu Project MCP session is not initialized");
    }
    const response = await this.config.fetchImplementation(this.config.url, {
      method: "POST",
      headers: this.headers(this.sessionId),
      body: JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(
        `Feishu Project MCP request failed with HTTP ${response.status}${text ? `: ${text.slice(0, 500)}` : ""}`,
      );
    }
    const sessionId = response.headers.get("mcp-session-id");
    if (sessionId) this.sessionId = sessionId;
    try {
      return parseJsonRpcPayload(text, response.headers.get("content-type"));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid Feishu Project MCP response: ${message}`);
    }
  }

  private headers(sessionId?: string): Record<string, string> {
    return {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${this.config.token}`,
      ...(sessionId
        ? {
            "mcp-session-id": sessionId,
            "mcp-protocol-version": this.config.protocolVersion,
          }
        : {}),
    };
  }
}

export async function getCompleteFeishuProjectWorkItem(
  config: FeishuProjectMcpConfig,
  reference: FeishuProjectWorkItemReference,
): Promise<FeishuProjectWorkItemDetails> {
  const parsed = reference.url
    ? parseFeishuProjectWorkItemUrl(reference.url)
    : undefined;
  const projectKey = reference.projectKey?.trim() || parsed?.projectKey;
  const workItemId = reference.workItemId?.trim() || parsed?.workItemId;
  if (!projectKey || !workItemId) {
    throw new Error("Provide a work item URL or both projectKey and workItemId");
  }

  const client = new FeishuProjectMcpClient(config);
  try {
    const fields: FeishuProjectWorkItemField[] = [];
    let firstPage: FeishuProjectWorkItemDetails | undefined;
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_FIELD_PAGES; page += 1) {
      const rawPage = await client.callTool<unknown>("get_workitem_brief", {
        ...(reference.url ? { url: reference.url } : {}),
        project_key: projectKey,
        work_item_id: workItemId,
        fields: ["_all"],
        page_size: 200,
        ...(pageToken ? { page_token: pageToken } : {}),
      });
      const currentPage = validateWorkItemDetails(rawPage);
      firstPage ??= currentPage;
      fields.push(...currentPage.work_item_fields);
      if (!currentPage.pagination?.has_more) break;
      const nextPageToken = currentPage.pagination.next_page_token;
      if (!nextPageToken || nextPageToken === pageToken) {
        throw new Error("Feishu Project returned an invalid field pagination token");
      }
      pageToken = nextPageToken;
      if (page === MAX_FIELD_PAGES - 1) {
        throw new Error("Feishu Project work item exceeded the field pagination limit");
      }
    }
    if (!firstPage) throw new Error("Feishu Project returned no work item data");
    return {
      ...firstPage,
      work_item_fields: fields,
      pagination: {
        ...firstPage.pagination,
        page_size: fields.length,
        has_more: false,
      },
    };
  } finally {
    await client.close();
  }
}
