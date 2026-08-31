import { serve } from "@hono/node-server";

import { WorkbenchQueryService } from "../application/workbench-query-service.js";
import { CodingRunLauncher } from "../application/coding-run-launcher.js";
import {
  McpFeishuWorkItemSource,
  ProjectWorkflowService,
} from "../application/project-workflow-service.js";
import { getCompleteFeishuProjectWorkItem } from "../integrations/feishu-project-mcp.js";
import { migrateBusinessDatabase } from "../persistence/business-migrations.js";
import { createBusinessDatabase } from "../persistence/database.js";
import { PostgresWorkbenchRepository } from "../persistence/workbench-repository.js";
import { PostgresProjectCollaborationRepository } from "../persistence/project-collaboration-repository.js";
import { PostgresAgentConversationReader } from "../persistence/checkpoint-conversation-reader.js";
import { PostgresRunHandoffRepository } from "../persistence/run-handoff-repository.js";
import { FeishuCommentEventSubscriber } from "../integrations/feishu-comment-events.js";
import {
  PostgresProjectEventBus,
  CoordinatorProjectEventDispatcher,
} from "../events/project-event-bus.js";
import { PostgresProjectEventInteractions } from "../events/project-event-interactions.js";
import { FeishuCommentReplyAdapter } from "../integrations/feishu-comment-replies.js";
import { createApp } from "./app.js";
import { loadServerConfig } from "./config.js";
import { DockerSandboxHealthProvider } from "./docker-sandbox-health.js";
import { FilesystemAgentSpecCatalog } from "./agent-spec-catalog.js";

const config = loadServerConfig();
await migrateBusinessDatabase({ connectionString: config.databaseUrl });
const database = createBusinessDatabase(config.databaseUrl);
const repository = new PostgresWorkbenchRepository(database.pool);
const collaborationRepository = new PostgresProjectCollaborationRepository(database.pool);
const handoffRepository = new PostgresRunHandoffRepository(database.pool);
const eventBus = new PostgresProjectEventBus(database.pool);
const eventInteractions = new PostgresProjectEventInteractions(
  database.pool,
  config.larkAppId && config.larkAppSecret
    ? [new FeishuCommentReplyAdapter({
        appId: config.larkAppId,
        appSecret: config.larkAppSecret,
      })]
    : [],
);
const specCatalog = new FilesystemAgentSpecCatalog(config.specsRoot);
const workItemSource = new McpFeishuWorkItemSource((url) =>
  getCompleteFeishuProjectWorkItem(
    { url: config.feishuProjectMcpUrl, token: config.feishuProjectMcpToken },
    { url },
  ),
);
const runLauncher = new CodingRunLauncher({
  repository,
  collaborationRepository,
  eventBus,
  eventInteractions,
  handoffRepository,
  databaseUrl: config.databaseUrl,
  specsRoot: config.specsRoot,
  listAgentSpecs: async () => (await specCatalog.list()).items.map((spec) => ({
    id: spec.id,
    name: spec.name,
    version: spec.version,
    defaultResponsibility: spec.defaultResponsibility,
  })),
  runtimeSpecKey: config.runtimeSpecKey,
  workspaceRoot: config.workspaceRoot,
  sandboxBackend: config.sandboxBackend,
  sandboxImage: config.sandboxImage,
  sandboxNetwork: config.sandboxNetwork,
  sharedSandboxName: config.sandboxName,
  openAIBaseUrl: config.openAIBaseUrl,
  openAIApiKey: config.openAIApiKey,
  model: config.model,
  contextCompression: config.contextCompression,
  gitlabBaseUrl: config.gitlabBaseUrl,
  gitlabToken: config.gitlabToken,
  gitlabUsername: config.gitlabUsername,
  kubeconfigPath: config.kubeconfigPath,
  meegleUserAccessToken: config.feishuProjectMcpToken,
});
const projectEventDispatcher = new CoordinatorProjectEventDispatcher(eventBus, runLauncher);
const commentEvents = config.larkAppId && config.larkAppSecret
  ? new FeishuCommentEventSubscriber({
      appId: config.larkAppId,
      appSecret: config.larkAppSecret,
      eventBus,
      dispatcher: projectEventDispatcher,
      onReady: () => process.stdout.write("Feishu comment event connection ready\n"),
      onError: (error, notice) => {
        process.stderr.write(
          `Feishu comment event failed${notice?.comment_id ? ` for ${notice.comment_id}` : ""}: ${error.message}\n`,
        );
      },
      onEvent: ({ notice, outcome, publishResult }) => {
        process.stdout.write(
          `Feishu comment event ${outcome}` +
          `${notice.comment_id ? ` comment=${notice.comment_id}` : ""}` +
          `${publishResult ? ` projects=${publishResult.deliveredProjectIds.length}` : ""}\n`,
        );
      },
    })
  : undefined;
const projectWorkflow = new ProjectWorkflowService(
  workItemSource,
  repository,
  specCatalog,
  runLauncher,
  eventBus,
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
  projectWorkflow,
  collaboration: collaborationRepository,
  staticRoot: config.staticRoot,
});
const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port });
if (commentEvents) {
  void commentEvents.start().catch((error) => {
    process.stderr.write(`Unable to start Feishu comment events: ${String(error)}\n`);
  });
} else {
  process.stderr.write("Feishu comment events disabled: LARK_APP_ID/LARK_APP_SECRET are not configured\n");
}
void eventBus.pendingProjectIds()
  .then((projectIds) => projectEventDispatcher.dispatch(projectIds))
  .catch((error) => {
    process.stderr.write(`Unable to resume pending project events: ${String(error)}\n`);
  });

process.stdout.write(`SwarmHive listening on http://${config.host}:${config.port}\n`);

let stopping = false;
async function stop(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  process.stdout.write(`Received ${signal}, shutting down\n`);
  commentEvents?.stop();
  server.close();
  await conversationReader.close();
  await database.close();
}

process.once("SIGINT", () => void stop("SIGINT"));
process.once("SIGTERM", () => void stop("SIGTERM"));
