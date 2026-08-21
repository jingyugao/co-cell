import { resolve } from "node:path";

import type { SandboxBackend } from "../sandbox/factory.js";

export interface ServerConfig {
  host: string;
  port: number;
  databaseUrl: string;
  staticRoot: string;
  sandboxName: string;
  specsRoot: string;
  workspaceRoot: string;
  sandboxBackend: SandboxBackend;
  sandboxImage?: string;
  sandboxNetwork: string;
  feishuProjectMcpUrl: string;
  feishuProjectMcpToken: string;
  openAIBaseUrl?: string;
  openAIApiKey?: string;
  model?: string;
  gitlabBaseUrl?: string;
  gitlabToken?: string;
  gitlabUsername: string;
}

function integerEnvironment(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0 || value > 65_535) {
    throw new Error(`${name} must be an integer between 1 and 65535`);
  }
  return value;
}

export function loadServerConfig(): ServerConfig {
  const databaseUrl = process.env.AGENT_DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error("AGENT_DATABASE_URL is required");
  const sandboxBackend = (process.env.AGENT_SANDBOX?.trim() || "shared-docker") as SandboxBackend;
  if (!(["local", "docker", "shared-docker"] as const).includes(sandboxBackend)) {
    throw new Error(`Unsupported AGENT_SANDBOX: ${sandboxBackend}`);
  }
  const feishuProjectMcpUrl =
    process.env.FEISHU_PROJECT_MCP_URL?.trim() || process.env.FeishuProjectMcpUrl?.trim();
  const feishuProjectMcpToken =
    process.env.FEISHU_PROJECT_MCP_TOKEN?.trim() || process.env.FeishuProjectMcpToken?.trim();
  if (!feishuProjectMcpUrl || !feishuProjectMcpToken) {
    throw new Error("FeishuProjectMcpUrl and FeishuProjectMcpToken are required");
  }
  const openAIBaseUrl = process.env.OPENAI_BASE_URL?.trim();
  const openAIApiKey = process.env.OPENAI_API_KEY?.trim();
  if (Boolean(openAIBaseUrl) !== Boolean(openAIApiKey)) {
    throw new Error("OPENAI_BASE_URL and OPENAI_API_KEY must be configured together");
  }
  const gitlabBaseUrl = process.env.GITLAB_BASE_URL?.trim();
  const gitlabToken = process.env.GITLAB_TOKEN?.trim();
  if (Boolean(gitlabBaseUrl) !== Boolean(gitlabToken)) {
    throw new Error("GITLAB_BASE_URL and GITLAB_TOKEN must be configured together");
  }
  return {
    host: process.env.AGENT_SERVER_HOST?.trim() || "127.0.0.1",
    port: integerEnvironment("AGENT_SERVER_PORT", 3000),
    databaseUrl,
    staticRoot: resolve(process.env.AGENT_WEB_ROOT?.trim() || "dist/web"),
    sandboxName:
      process.env.AGENT_SHARED_SANDBOX_NAME?.trim() || "agent-staff-dev-sandbox",
    specsRoot: resolve(process.env.AGENT_SPECS_ROOT?.trim() || "agent-specs"),
    workspaceRoot: resolve(process.env.AGENT_WORKSPACE_ROOT?.trim() || ".agent-staff/workspaces"),
    sandboxBackend,
    ...(process.env.AGENT_SANDBOX_IMAGE?.trim()
      ? { sandboxImage: process.env.AGENT_SANDBOX_IMAGE.trim() }
      : {}),
    sandboxNetwork: process.env.AGENT_SANDBOX_NETWORK?.trim() || "bridge",
    feishuProjectMcpUrl,
    feishuProjectMcpToken,
    ...(openAIBaseUrl ? { openAIBaseUrl } : {}),
    ...(openAIApiKey ? { openAIApiKey } : {}),
    ...(process.env.AGENT_MODEL?.trim() ? { model: process.env.AGENT_MODEL.trim() } : {}),
    ...(gitlabBaseUrl ? { gitlabBaseUrl } : {}),
    ...(gitlabToken ? { gitlabToken } : {}),
    gitlabUsername: process.env.GITLAB_USERNAME?.trim() || "oauth2",
  };
}
