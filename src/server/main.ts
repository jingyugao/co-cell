import { serve } from "@hono/node-server";

import { WorkbenchQueryService } from "../application/workbench-query-service.js";
import { CodingRunLauncher } from "../application/coding-run-launcher.js";
import {
  McpFeishuWorkItemSource,
  RequirementWorkflowService,
} from "../application/requirement-workflow-service.js";
import { getCompleteFeishuProjectWorkItem } from "../integrations/feishu-project-mcp.js";
import { migrateBusinessDatabase } from "../persistence/business-migrations.js";
import { createBusinessDatabase } from "../persistence/database.js";
import { PostgresWorkbenchRepository } from "../persistence/workbench-repository.js";
import { PostgresAgentConversationReader } from "../persistence/checkpoint-conversation-reader.js";
import { createApp } from "./app.js";
import { loadServerConfig } from "./config.js";
import { DockerSandboxHealthProvider } from "./docker-sandbox-health.js";
import { FilesystemAgentSpecCatalog } from "./agent-spec-catalog.js";

const config = loadServerConfig();
await migrateBusinessDatabase({ connectionString: config.databaseUrl });
const database = createBusinessDatabase(config.databaseUrl);
const repository = new PostgresWorkbenchRepository(database.pool);
const specCatalog = new FilesystemAgentSpecCatalog(config.specsRoot);
const requirementSource = new McpFeishuWorkItemSource((url) =>
  getCompleteFeishuProjectWorkItem(
    { url: config.feishuProjectMcpUrl, token: config.feishuProjectMcpToken },
    { url },
  ),
);
const runLauncher = new CodingRunLauncher({
  repository,
  source: requirementSource,
  databaseUrl: config.databaseUrl,
  specsRoot: config.specsRoot,
  workspaceRoot: config.workspaceRoot,
  sandboxBackend: config.sandboxBackend,
  sandboxImage: config.sandboxImage,
  sandboxNetwork: config.sandboxNetwork,
  sharedSandboxName: config.sandboxName,
  openAIBaseUrl: config.openAIBaseUrl,
  openAIApiKey: config.openAIApiKey,
  model: config.model,
  gitlabBaseUrl: config.gitlabBaseUrl,
  gitlabToken: config.gitlabToken,
  gitlabUsername: config.gitlabUsername,
  kubeconfigPath: config.kubeconfigPath,
  feishuProjectMcpUrl: config.feishuProjectMcpUrl,
  feishuProjectMcpToken: config.feishuProjectMcpToken,
});
const requirements = new RequirementWorkflowService(
  requirementSource,
  repository,
  specCatalog,
  runLauncher,
);
const conversationReader = new PostgresAgentConversationReader(
  config.databaseUrl,
  process.env.AGENT_CHECKPOINT_SCHEMA,
);
const workbench = new WorkbenchQueryService(
  repository,
  new DockerSandboxHealthProvider(config.sandboxName),
  conversationReader,
);
const app = createApp({
  workbench,
  specCatalog,
  requirements,
  staticRoot: config.staticRoot,
});
const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port });

process.stdout.write(`SwarmHive listening on http://${config.host}:${config.port}\n`);

let stopping = false;
async function stop(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  process.stdout.write(`Received ${signal}, shutting down\n`);
  server.close();
  await conversationReader.close();
  await database.close();
}

process.once("SIGINT", () => void stop("SIGINT"));
process.once("SIGTERM", () => void stop("SIGTERM"));
