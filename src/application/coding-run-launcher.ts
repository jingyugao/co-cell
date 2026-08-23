import { resolve } from "node:path";
import { interrupt } from "@langchain/langgraph";

import { runCodingTask } from "../agent/coding-agent.js";
import type { RequestUserInput } from "../tools/request-user-input.js";
import { createPostgresCheckpointer } from "../persistence/postgres-checkpointer.js";
import type { PostgresWorkbenchRepository } from "../persistence/workbench-repository.js";
import {
  allocateSpecProjectWorkspace,
  createTaskSandbox,
  type SandboxBackend,
} from "../sandbox/factory.js";
import { loadAgentSpec } from "../specs/loader.js";
import type {
  CancelAgentRunResult,
  ResumeAgentRunInput,
  ResumeAgentRunResult,
} from "../contracts/requirements.js";
import type { Sandbox } from "../sandbox/types.js";
import { ConflictError } from "./errors.js";
import type { AgentRunLauncher } from "./requirement-workflow-service.js";

export interface CodingRunLauncherOptions {
  repository: PostgresWorkbenchRepository;
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
  meegleUserAccessToken: string;
}

interface ActiveRun {
  controller: AbortController;
  cancelled: boolean;
  sandbox?: Sandbox;
}

function branchSlug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 70);
}

export function buildFeishuProjectTaskPrompt(
  basePrompt: string,
  sourceUrl: string,
): string {
  return `${basePrompt.trim()}\n\n当前任务：\n\n- 飞书项目地址：${sourceUrl}`;
}

export class CodingRunLauncher implements AgentRunLauncher {
  private readonly active = new Map<string, ActiveRun>();

  constructor(private readonly options: CodingRunLauncherOptions) {}

  launch(runId: string): void {
    if (this.active.has(runId)) return;
    const activeRun: ActiveRun = {
      controller: new AbortController(),
      cancelled: false,
    };
    this.active.set(runId, activeRun);
    void this.execute(runId, activeRun)
      .catch((error) => activeRun.cancelled ? undefined : this.fail(runId, error))
      .finally(() => this.active.delete(runId));
  }

  async resume(
    runId: string,
    input: ResumeAgentRunInput,
  ): Promise<ResumeAgentRunResult> {
    if (this.active.has(runId)) {
      throw new ConflictError("Agent Run is already active");
    }
    const resumed = await this.options.repository.resumeWaitingAgentRun(runId);
    if (!resumed) {
      throw new ConflictError("Agent Run is not waiting for user input");
    }
    const activeRun: ActiveRun = {
      controller: new AbortController(),
      cancelled: false,
    };
    this.active.set(runId, activeRun);
    await this.options.repository.appendAgentRunEvent({
      runId,
      eventType: "user_input_received",
      title: "已收到人工确认",
      detail: Object.values(input.answers)
        .flatMap((answer) => answer.answers)
        .join("；"),
      data: { state: "completed" },
    });
    void this.execute(runId, activeRun, input)
      .catch((error) => activeRun.cancelled ? undefined : this.fail(runId, error))
      .finally(() => this.active.delete(runId));
    return { runId, status: "running" };
  }

  async cancel(runId: string): Promise<CancelAgentRunResult> {
    const result = await this.options.repository.cancelAgentRun(runId);
    if (!result) {
      throw new ConflictError("Agent Run is not active and cannot be cancelled");
    }
    const activeRun = this.active.get(runId);
    if (activeRun) {
      activeRun.cancelled = true;
      activeRun.controller.abort();
      await activeRun.sandbox?.destroy().catch(() => undefined);
    }
    return result;
  }

  private assertActive(activeRun: ActiveRun): void {
    if (activeRun.cancelled || activeRun.controller.signal.aborted) {
      throw new Error("Agent Run was cancelled");
    }
  }

  private async execute(
    runId: string,
    activeRun: ActiveRun,
    resumeInput?: ResumeAgentRunInput,
  ): Promise<void> {
    if (this.options.sandboxBackend !== "shared-docker") {
      throw new Error(
        "Web-started development requires one shared-docker pod per Agent Spec",
      );
    }
    this.assertActive(activeRun);
    const context = await this.options.repository.getAgentRunExecutionContext(runId);
    if (!context) throw new Error("Agent Run execution context was not found");
    if (!resumeInput) {
      const claimed = await this.options.repository.updateAgentRun({ runId, status: "running" });
      if (!claimed) return;
    }
    this.assertActive(activeRun);
    const allocation = await allocateSpecProjectWorkspace({
      workspaceRoot: this.options.workspaceRoot,
      specKey: context.specKey,
      projectId: context.projectId,
    });
    const gitlabConfigured = Boolean(this.options.gitlabBaseUrl && this.options.gitlabToken);
    if (!gitlabConfigured) {
      throw new Error("GITLAB_BASE_URL and GITLAB_TOKEN are required to start development");
    }
    const gitlabHost = new URL(this.options.gitlabBaseUrl!).host;
    const meegleHost = new URL(context.sourceUrl).host;
    const agentHome = "/home/agent";
    const specSandboxPath = resolve(
      this.options.specsRoot,
      context.specKey,
      "sandbox",
    );
    const feishuCredentialsPath = resolve(
      this.options.specsRoot,
      context.specKey,
      ".credentials/feishu",
    );
    const sandbox = await createTaskSandbox({
      backend: this.options.sandboxBackend,
      workspace: allocation.workspace,
      workspaceRoot: allocation.home,
      runId,
      image: this.options.sandboxImage,
      network: this.options.sandboxNetwork,
      sharedContainerName: `${this.options.sharedSandboxName}-${allocation.specSlug}`,
      env: {
        GITLAB_BASE_URL: this.options.gitlabBaseUrl!,
        GITLAB_HOST: gitlabHost,
        GITLAB_TOKEN: this.options.gitlabToken!,
        GITLAB_USERNAME: this.options.gitlabUsername,
        GITLAB_FEATURE_BRANCH: `agent/${branchSlug(`${context.workItemId}-${context.role}`)}`,
        HOME: agentHome,
        GLAB_CONFIG_DIR: `${agentHome}/.config/glab-cli`,
        GIT_TERMINAL_PROMPT: "0",
        PATH: `${agentHome}/.local/bin:/usr/local/bin:/usr/bin:/bin`,
        AGENT_SPEC_SANDBOX_DIR: "/opt/swarm-hive/spec-sandbox",
        FEISHU_PROJECT_WORK_ITEM_URL: context.sourceUrl,
        MEEGLE_HOST: meegleHost,
        MEEGLE_USER_ACCESS_TOKEN: this.options.meegleUserAccessToken,
        ...(this.options.kubeconfigPath
          ? { KUBECONFIG: "/etc/swarm-hive/kubeconfig" }
          : {}),
      },
      mounts: [
        {
          source: resolve(feishuCredentialsPath, ".lark-cli"),
          target: `${agentHome}/.lark-cli`,
        },
        {
          source: resolve(
            feishuCredentialsPath,
            ".local/share/lark-cli",
          ),
          target: `${agentHome}/.local/share/lark-cli`,
        },
        {
          source: specSandboxPath,
          target: "/opt/swarm-hive/spec-sandbox",
          readOnly: true,
        },
        ...(this.options.kubeconfigPath
          ? [{
            source: this.options.kubeconfigPath,
            target: "/etc/swarm-hive/kubeconfig",
            readOnly: true,
          }]
          : []),
      ],
      initializers: [
        {
          name: "spec-tools",
          command: "sh /opt/swarm-hive/spec-sandbox/bin/tools-init",
        },
        {
          name: "gitlab",
          command: "sh /opt/swarm-hive/spec-sandbox/bin/gitlab-init",
        },
        {
          name: "feishu-cli",
          command: "sh /opt/swarm-hive/spec-sandbox/bin/feishu-init",
        },
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
    activeRun.sandbox = sandbox;
    if (activeRun.cancelled || activeRun.controller.signal.aborted) {
      await sandbox?.destroy();
    }
    this.assertActive(activeRun);
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
        title: resumeInput ? "Agent 继续当前流程" : "Agent 开始处理需求",
        detail: "控制面仅提供飞书 Project 地址；Agent 将使用 Sandbox 内的 Meegle 和 Lark CLI 自主读取最新需求",
        data: { state: "running", progressPercent: 5 },
      });
      const prompt = buildFeishuProjectTaskPrompt(spec.prompt, context.sourceUrl);
      const result = await runCodingTask({
        workspace: allocation.workspace,
        sandbox,
        prompt,
        threadId: context.threadId,
        runId,
        checkpointer: checkpoint.checkpointer,
        ...(resumeInput ? { resume: resumeInput } : {}),
        model: this.options.model,
        additionalInstructions: spec.instructions,
        requestUserInput: async (request) =>
          interrupt<RequestUserInput, never>(request),
        signal: activeRun.controller.signal,
        ...(this.options.openAIBaseUrl && this.options.openAIApiKey
          ? {
              openAICompatible: {
                baseURL: this.options.openAIBaseUrl,
                apiKey: this.options.openAIApiKey,
              },
            }
          : {}),
      });
      this.assertActive(activeRun);
      if (result.userInputRequest) {
        const updated = await this.options.repository.updateAgentRun({
          runId,
          status: "waiting_user",
          resultSummary: result.finalResponse,
        });
        if (updated) await this.options.repository.appendAgentRunEvent({
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
      const updated = await this.options.repository.updateAgentRun({
        runId,
        status: "succeeded",
        resultSummary: result.finalResponse,
        mergeRequestUrl: result.mergeRequestUrl,
      });
      if (updated) await this.options.repository.appendAgentRunEvent({
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
    const updated = await this.options.repository.updateAgentRun({
      runId,
      status: "failed",
      errorCode: "agent_execution_failed",
      errorMessage: message,
    }).catch(() => false);
    if (updated) await this.options.repository.appendAgentRunEvent({
      runId,
      eventType: "agent_failed",
      level: "error",
      title: "Agent 执行失败",
      detail: message,
      data: { state: "completed" },
    }).catch(() => undefined);
  }
}
