import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

import { runCodingTask } from "./agent/coding-agent.js";
import { loginWithDeviceCode } from "./auth/codex-oauth.js";
import { createPostgresCheckpointer } from "./persistence/postgres-checkpointer.js";
import { verifyGitLabMergeRequest } from "./integrations/gitlab.js";
import { createTerminalUserInputHandler } from "./tools/request-user-input.js";
import { loadAgentSpec } from "./specs/loader.js";
import {
  AGENT_MEMORY_SANDBOX_PATH,
  createAgentMemorySnapshot,
  loadAgentMemory,
  renderAgentMemoryInstructions,
} from "./specs/memory.js";
import {
  allocateInstanceProjectWorkspace,
  createTaskSandbox,
  type SandboxBackend,
} from "./sandbox/factory.js";

function valueAfter(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

function firstUrlHost(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    if (!value?.trim()) continue;
    try {
      return new URL(value.trim()).host;
    } catch {
      // Ignore malformed optional values; the corresponding integration remains disabled.
    }
  }
  return undefined;
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === "auth") {
    const provider = await loginWithDeviceCode({
      onCode: (uri, code) => {
        process.stdout.write(`Open ${uri} and enter code: ${code}\n`);
      },
    });
    process.stdout.write(`Authentication saved to ${provider.path}\n`);
    return;
  }

  if (command === "run") {
    const runId = valueAfter("--run-id") ?? randomUUID();
    const threadId =
      valueAfter("--agent-id") ?? valueAfter("--thread-id") ?? runId;
    const sandboxBackend = (valueAfter("--sandbox") ??
      process.env.AGENT_SANDBOX ??
      "local") as SandboxBackend;
    if (
      sandboxBackend !== "local" &&
      sandboxBackend !== "docker" &&
      sandboxBackend !== "shared-docker"
    ) {
      throw new Error(`Unsupported sandbox backend: ${sandboxBackend}`);
    }
    const workspaceRoot = process.env.AGENT_WORKSPACE_ROOT;
    const requestedWorkspace = valueAfter("--workspace");
    const resume = process.argv.includes("--resume");
    const taskPath = valueAfter("--task-file");
    const inlineTask = valueAfter("--task");
    const prompt = resume
      ? undefined
      : taskPath
        ? await readFile(resolve(taskPath), "utf8")
        : inlineTask ?? (process.stdin.isTTY ? undefined : await readStdin());
    if (!resume && !prompt?.trim()) {
      throw new Error(
        "Provide --task, --task-file, or pipe a task through standard input",
      );
    }
    const baseURL = valueAfter("--base-url") ?? process.env.OPENAI_BASE_URL;
    const apiKeyEnvironment = valueAfter("--api-key-env") ?? "OPENAI_API_KEY";
    const apiKey = baseURL ? process.env[apiKeyEnvironment] : undefined;
    if (baseURL && !apiKey) {
      throw new Error(
        `Set ${apiKeyEnvironment} when using --base-url or OPENAI_BASE_URL`,
      );
    }
    const checkpointDatabaseUrl = process.env.AGENT_CHECKPOINT_DATABASE_URL;
    if (resume && !checkpointDatabaseUrl) {
      throw new Error(
        "AGENT_CHECKPOINT_DATABASE_URL is required with --resume",
      );
    }
    const checkpointHandle = checkpointDatabaseUrl
      ? await createPostgresCheckpointer({
          connectionString: checkpointDatabaseUrl,
          schema: process.env.AGENT_CHECKPOINT_SCHEMA,
        })
      : undefined;
    const gitlabBaseUrl = process.env.GITLAB_BASE_URL?.trim();
    const gitlabToken = process.env.GITLAB_TOKEN?.trim();
    if (Boolean(gitlabBaseUrl) !== Boolean(gitlabToken)) {
      throw new Error(
        "GITLAB_BASE_URL and GITLAB_TOKEN must be configured together",
      );
    }
    const gitlabUsername = process.env.GITLAB_USERNAME?.trim() || "oauth2";
    const gitlabFeatureBranch =
      process.env.GITLAB_FEATURE_BRANCH?.trim() ||
      `agent/${threadId.toLowerCase().replace(/[^a-z0-9._-]/g, "-").slice(0, 80)}`;
    const gitlabHome = "/tmp/agent-home";
    const gitlabHost = gitlabBaseUrl
      ? new URL(gitlabBaseUrl).host
      : undefined;
    const gitlabEnvironment =
      gitlabBaseUrl && gitlabToken && gitlabHost
        ? {
            GITLAB_BASE_URL: gitlabBaseUrl,
            GITLAB_HOST: gitlabHost,
            GITLAB_TOKEN: gitlabToken,
            GITLAB_USERNAME: gitlabUsername,
            HOME: gitlabHome,
            GLAB_CONFIG_DIR: `${gitlabHome}/.config/glab-cli`,
            GIT_TERMINAL_PROMPT: "0",
            GITLAB_FEATURE_BRANCH: gitlabFeatureBranch,
          }
        : undefined;
    if (
      gitlabEnvironment &&
      sandboxBackend !== "docker" &&
      sandboxBackend !== "shared-docker"
    ) {
      throw new Error(
        "GitLab delivery requires a Docker sandbox so authentication and repository initialization complete before the Agent starts",
      );
    }
    const spec = await loadAgentSpec({
      directory:
        valueAfter("--spec") ??
        process.env.AGENT_SPEC_DIR ??
        resolve("agent-specs/software-engineer"),
    });
    const feishuCredentialsRoot = resolve(spec.directory, ".credentials/feishu");
    const larkConfigPath = resolve(feishuCredentialsRoot, ".lark-cli");
    const larkDataPath = resolve(
      feishuCredentialsRoot,
      ".local/share/lark-cli",
    );
    const meegleUserAccessToken =
      process.env.MEEGLE_USER_ACCESS_TOKEN?.trim() ||
      process.env.FEISHU_PROJECT_MCP_TOKEN?.trim() ||
      process.env.FeishuProjectMcpToken?.trim();
    const meegleHost =
      process.env.MEEGLE_HOST?.trim() ||
      firstUrlHost(
        process.env.FEISHU_PROJECT_WORK_ITEM_URL,
        process.env.FEISHU_PROJECT_MCP_URL,
        process.env.FeishuProjectMcpUrl,
      );
    const feishuCliConfigured = Boolean(
      meegleUserAccessToken &&
      meegleHost &&
      await isDirectory(larkConfigPath) &&
      await isDirectory(larkDataPath),
    );
    let allocation;
    if (!requestedWorkspace && sandboxBackend === "shared-docker") {
      if (!workspaceRoot) {
        throw new Error(
          "AGENT_WORKSPACE_ROOT is required to allocate a Spec project workspace",
        );
      }
      allocation = await allocateInstanceProjectWorkspace({
        workspaceRoot,
        instanceKey: spec.manifest.id,
        projectId: valueAfter("--project-id") ?? threadId,
      });
    }
    const workspace = resolve(
      requestedWorkspace ?? allocation?.workspace ?? process.cwd(),
    );
    if (allocation) {
      process.stderr.write(
        `spec=${spec.manifest.id}\nproject=${allocation.projectId}\nworkspace=${allocation.workspace}\n`,
      );
    }
    const specSandboxPath = resolve(spec.directory, "sandbox");
    const sandboxHome = sandboxBackend === "shared-docker"
      ? "/home/agent"
      : "/tmp/agent-home";
    const sandboxEnvironment = sandboxBackend === "docker" || sandboxBackend === "shared-docker"
      ? {
          ...gitlabEnvironment,
          HOME: sandboxHome,
          GLAB_CONFIG_DIR: `${sandboxHome}/.config/glab-cli`,
          PATH: `${sandboxHome}/.local/bin:/usr/local/bin:/usr/bin:/bin`,
          AGENT_SPEC_SANDBOX_DIR: "/opt/swarm-hive/spec-sandbox",
          ...(allocation ? { AGENT_MEMORY_FILE: AGENT_MEMORY_SANDBOX_PATH } : {}),
          ...(feishuCliConfigured
            ? {
                MEEGLE_HOST: meegleHost!,
                MEEGLE_USER_ACCESS_TOKEN: meegleUserAccessToken!,
              }
            : {}),
        }
      : gitlabEnvironment;
    try {
      const memory = allocation
        ? await loadAgentMemory(allocation.home, spec.memorySeed)
        : createAgentMemorySnapshot(spec.memorySeed);
      const sandbox = await createTaskSandbox({
        backend: sandboxBackend,
        workspace,
        workspaceRoot: allocation?.home ?? workspaceRoot,
        runId,
        image: valueAfter("--sandbox-image") ?? process.env.AGENT_SANDBOX_IMAGE,
        network:
          valueAfter("--sandbox-network") ??
          process.env.AGENT_SANDBOX_NETWORK ??
          "none",
        env: sandboxEnvironment,
        mounts: sandboxBackend === "docker" || sandboxBackend === "shared-docker"
          ? [
              {
                source: specSandboxPath,
                target: "/opt/swarm-hive/spec-sandbox",
                readOnly: true,
              },
              ...(feishuCliConfigured
                ? [
                    {
                      source: larkConfigPath,
                      target: `${sandboxHome}/.lark-cli`,
                    },
                    {
                      source: larkDataPath,
                      target: `${sandboxHome}/.local/share/lark-cli`,
                    },
                  ]
                : []),
            ]
          : undefined,
        sharedContainerName: sandboxBackend === "shared-docker"
          ? `${process.env.AGENT_SHARED_SANDBOX_NAME ?? "swarm-hive-dev-sandbox"}-${allocation?.instanceSlug ?? spec.manifest.id}`
          : undefined,
        initializers: sandboxBackend === "docker" || sandboxBackend === "shared-docker"
          ? [
              {
                name: "spec-tools",
                command: "sh /opt/swarm-hive/spec-sandbox/bin/tools-init",
              },
              ...(gitlabEnvironment
                ? [{
                    name: "gitlab",
                    command: "sh /opt/swarm-hive/spec-sandbox/bin/gitlab-init",
                  }]
                : []),
              ...(feishuCliConfigured
                ? [{
                    name: "feishu-cli",
                    command: "sh /opt/swarm-hive/spec-sandbox/bin/feishu-init",
                  }]
                : []),
            ]
          : undefined,
      });
      try {
        const result = await runCodingTask({
          workspace,
          prompt,
          ...(resume ? { resume: true as const } : {}),
          sandbox,
          model: valueAfter("--model"),
          requestUserInput: createTerminalUserInputHandler(),
          runId,
          additionalInstructions: [spec.prompt, renderAgentMemoryInstructions(memory)],
          requireMergeRequest: Boolean(gitlabEnvironment),
          ...(checkpointHandle
            ? { checkpointer: checkpointHandle.checkpointer, threadId }
            : {}),
          ...(baseURL && apiKey
            ? { openAICompatible: { baseURL, apiKey } }
            : {}),
        });
        if (gitlabBaseUrl && gitlabToken && result.mergeRequestUrl) {
          await verifyGitLabMergeRequest({
            baseUrl: gitlabBaseUrl,
            token: gitlabToken,
            mergeRequestUrl: result.mergeRequestUrl,
          });
        }
        process.stdout.write(`${result.finalResponse}\n`);
      } finally {
        await sandbox?.destroy();
      }
    } finally {
      await checkpointHandle?.close();
    }
    return;
  }

  if (command === "server") {
    await import("./server/main.js");
    return;
  }

  process.stderr.write(
      "Usage:\n" +
      "  pnpm auth\n" +
      "  pnpm run server\n" +
      "  pnpm agent -- --spec PATH --agent-id ID --task TEXT\n" +
      "  pnpm agent -- --agent-id ID --task TEXT  # shared-docker allocates workspace\n" +
      "  pnpm agent -- --workspace PATH --task TEXT\n" +
      "  pnpm agent -- --workspace PATH --task-file FILE\n" +
      "  AGENT_CHECKPOINT_DATABASE_URL=... pnpm agent -- --thread-id THREAD --workspace PATH --task TEXT\n" +
      "  AGENT_CHECKPOINT_DATABASE_URL=... pnpm agent -- --resume --thread-id THREAD --workspace PATH\n" +
      "  pnpm agent -- --sandbox docker --sandbox-image IMAGE --workspace PATH --task TEXT\n" +
      "  OPENAI_API_KEY=... pnpm agent -- --base-url URL --model MODEL --workspace PATH --task TEXT\n",
  );
  process.exitCode = 2;
}

await main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`error: ${message}\n`);
  process.exitCode = 1;
});
