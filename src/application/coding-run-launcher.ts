import { resolve } from "node:path";
import { interrupt } from "@langchain/langgraph";

import { runCodingTask } from "../agent/coding-agent.js";
import type { RequestUserInput } from "../tools/request-user-input.js";
import { createPostgresCheckpointer } from "../persistence/postgres-checkpointer.js";
import type { PostgresWorkbenchRepository } from "../persistence/workbench-repository.js";
import { allocateAgentWorkspace, createTaskSandbox, type SandboxBackend } from "../sandbox/factory.js";
import { loadAgentSpec } from "../specs/loader.js";
import { renderAgentTaskPrompt } from "../specs/task-prompt.js";
import type { AgentRunLauncher, FeishuWorkItemSource } from "./requirement-workflow-service.js";

export interface CodingRunLauncherOptions {
  repository: PostgresWorkbenchRepository;
  source: FeishuWorkItemSource;
  databaseUrl: string;
  specsRoot: string;
  workspaceRoot: string;
  sandboxBackend: SandboxBackend;
  sandboxImage?: string;
  sandboxNetwork: string;
  sharedSandboxName: string;
  openAIBaseUrl?: string;
  openAIApiKey?: string;
  model?: string;
  gitlabBaseUrl?: string;
  gitlabToken?: string;
  gitlabUsername: string;
  kubeconfigPath?: string;
  feishuProjectMcpUrl: string;
  feishuProjectMcpToken: string;
}

function branchSlug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 70);
}

export class CodingRunLauncher implements AgentRunLauncher {
  private readonly active = new Set<string>();

  constructor(private readonly options: CodingRunLauncherOptions) {}

  launch(runId: string): void {
    if (this.active.has(runId)) return;
    this.active.add(runId);
    void this.execute(runId)
      .catch((error) => this.fail(runId, error))
      .finally(() => this.active.delete(runId));
  }

  private async execute(runId: string): Promise<void> {
    if (this.options.sandboxBackend === "local") {
      throw new Error("Web-started development requires docker or shared-docker sandboxing");
    }
    const context = await this.options.repository.getAgentRunExecutionContext(runId);
    if (!context) throw new Error("Agent Run execution context was not found");
    await this.options.repository.updateAgentRun({ runId, status: "running" });
    await this.options.repository.appendAgentRunEvent({
      runId,
      eventType: "requirement_loading_started",
      title: "正在读取飞书需求",
      detail: "Agent 启动前重新读取飞书中的最新工作项内容",
      data: { state: "running", progressPercent: 5 },
    });
    const requirement = await this.options.source.get(context.sourceUrl);
    await this.options.repository.appendAgentRunEvent({
      runId,
      eventType: "requirement_loading_completed",
      title: "已读取飞书需求",
      detail: `${requirement.preview.title} · ${requirement.preview.currentNodes.map((node) => node.name).join("、") || "无当前节点"}`,
      data: { state: "completed", progressPercent: 10 },
    });

    const allocation = await allocateAgentWorkspace({
      workspaceRoot: this.options.workspaceRoot,
      agentId: context.agentInstanceId,
    });
    const gitlabConfigured = Boolean(this.options.gitlabBaseUrl && this.options.gitlabToken);
    if (!gitlabConfigured) {
      throw new Error("GITLAB_BASE_URL and GITLAB_TOKEN are required to start development");
    }
    const gitlabHost = new URL(this.options.gitlabBaseUrl!).host;
    const agentHome = "/tmp/agent-home";
    const sandbox = await createTaskSandbox({
      backend: this.options.sandboxBackend,
      workspace: allocation.workspace,
      workspaceRoot: this.options.workspaceRoot,
      runId,
      image: this.options.sandboxImage,
      network: this.options.sandboxNetwork,
      sharedContainerName: this.options.sharedSandboxName,
      env: {
        GITLAB_BASE_URL: this.options.gitlabBaseUrl!,
        GITLAB_HOST: gitlabHost,
        GITLAB_TOKEN: this.options.gitlabToken!,
        GITLAB_USERNAME: this.options.gitlabUsername,
        GITLAB_FEATURE_BRANCH: `agent/${branchSlug(`${context.workItemId}-${context.role}`)}`,
        HOME: agentHome,
        GLAB_CONFIG_DIR: `${agentHome}/.config/glab-cli`,
        GIT_TERMINAL_PROMPT: "0",
        FEISHU_PROJECT_MCP_URL: this.options.feishuProjectMcpUrl,
        FEISHU_PROJECT_MCP_TOKEN: this.options.feishuProjectMcpToken,
        FEISHU_PROJECT_WORK_ITEM_URL: context.sourceUrl,
        ...(this.options.kubeconfigPath
          ? { KUBECONFIG: "/etc/swarm-hive/kubeconfig" }
          : {}),
      },
      mounts: this.options.kubeconfigPath
        ? [{
            source: this.options.kubeconfigPath,
            target: "/etc/swarm-hive/kubeconfig",
            readOnly: true,
          }]
        : [],
      initializers: [
        { name: "gitlab", command: "gitlab-init" },
        ...(this.options.kubeconfigPath
          ? [{
              name: "kubernetes",
              command: [
                "kubectl config get-contexts example_data >/dev/null",
                "kubectl config get-contexts common >/dev/null",
                "kubectl --context example_data auth can-i get deployments.apps --all-namespaces >/dev/null",
                "kubectl --context common auth can-i get deployments.apps --all-namespaces >/dev/null",
                "! kubectl --context example_data auth can-i create deployments.apps --all-namespaces >/dev/null 2>&1",
                "! kubectl --context common auth can-i create deployments.apps --all-namespaces >/dev/null 2>&1",
              ].join(" && "),
            }]
          : []),
      ],
    });
    const spec = await loadAgentSpec({
      directory: resolve(this.options.specsRoot, context.specKey),
      capabilities: new Set(["gitlab"]),
    });
    const checkpoint = await createPostgresCheckpointer({
      connectionString: this.options.databaseUrl,
      schema: process.env.AGENT_CHECKPOINT_SCHEMA,
    });
    try {
      await this.options.repository.appendAgentRunEvent({
        runId,
        eventType: "agent_started",
        title: "Agent 开始开发",
        detail: context.role,
        data: { state: "running", progressPercent: 15 },
      });
      const prompt = renderAgentTaskPrompt(spec.prompt, {
        role: context.role,
        source_url: context.sourceUrl,
      });
      const result = await runCodingTask({
        workspace: allocation.workspace,
        sandbox,
        prompt,
        threadId: context.threadId,
        runId,
        checkpointer: checkpoint.checkpointer,
        model: this.options.model,
        additionalInstructions: spec.instructions,
        requestUserInput: async (request) =>
          interrupt<RequestUserInput, never>(request),
        ...(this.options.openAIBaseUrl && this.options.openAIApiKey
          ? {
              openAICompatible: {
                baseURL: this.options.openAIBaseUrl,
                apiKey: this.options.openAIApiKey,
              },
            }
          : {}),
      });
      if (result.userInputRequest) {
        await this.options.repository.updateAgentRun({ runId, status: "waiting_user" });
        await this.options.repository.appendAgentRunEvent({
          runId,
          eventType: "user_input_requested",
          level: "warning",
          title: "Agent 等待人工确认",
          detail: result.userInputRequest.questions
            .map((question) => question.question)
            .join("；"),
          data: { state: "pending", questions: result.userInputRequest.questions },
        });
        return;
      }
      await this.options.repository.updateAgentRun({
        runId,
        status: "succeeded",
        resultSummary: result.finalResponse,
        mergeRequestUrl: result.mergeRequestUrl,
      });
      await this.options.repository.appendAgentRunEvent({
        runId,
        eventType: "agent_completed",
        title: "Agent 已完成本次执行",
        detail: result.finalResponse,
        data: { state: "completed", progressPercent: 100 },
      });
    } finally {
      await checkpoint.close();
      await sandbox?.destroy();
    }
  }

  private async fail(runId: string, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    await this.options.repository.updateAgentRun({
      runId,
      status: "failed",
      errorCode: "agent_execution_failed",
      errorMessage: message,
    }).catch(() => undefined);
    await this.options.repository.appendAgentRunEvent({
      runId,
      eventType: "agent_failed",
      level: "error",
      title: "Agent 执行失败",
      detail: message,
      data: { state: "completed" },
    }).catch(() => undefined);
  }
}
