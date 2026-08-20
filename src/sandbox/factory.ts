import { createHash, randomUUID } from "node:crypto";
import { chown, mkdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, posix, relative, resolve, sep } from "node:path";

import { DockerSandboxProvider } from "./docker.js";
import { SharedDockerSandboxProvider } from "./shared-docker.js";
import type { Sandbox } from "./types.js";

export type SandboxBackend = "local" | "docker" | "shared-docker";

export interface SandboxInitializer {
  /** Stable, non-secret name used in control-plane errors and logs. */
  name: string;
  command: string;
}

export interface TaskSandboxOptions {
  backend: SandboxBackend;
  workspace: string;
  workspaceRoot?: string;
  runId?: string;
  image?: string;
  network?: string;
  cpu?: number;
  memoryMb?: number;
  pids?: number;
  timeoutMs?: number;
  env?: Readonly<Record<string, string>>;
  initializers?: readonly SandboxInitializer[];
  sharedContainerName?: string;
}

export interface AgentWorkspace {
  agentId: string;
  slug: string;
  root: string;
  workspace: string;
}

export function agentWorkspaceSlug(agentId: string): string {
  const normalized = agentId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "agent";
  const digest = createHash("sha256").update(agentId).digest("hex").slice(0, 8);
  return `${normalized}-${digest}`;
}

/** Allocate a stable host directory for one long-lived Agent conversation. */
export async function allocateAgentWorkspace(options: {
  workspaceRoot: string;
  agentId: string;
}): Promise<AgentWorkspace> {
  const requestedRoot = resolve(options.workspaceRoot);
  await mkdir(requestedRoot, { recursive: true });
  const root = await realpath(requestedRoot);
  const rootStat = await stat(root);
  const slug = agentWorkspaceSlug(options.agentId);
  const agentRoot = resolve(root, slug);
  const workspace = resolve(agentRoot, "repo");
  await mkdir(workspace, { recursive: true });
  // The controller commonly runs as root to access docker.sock. Preserve the
  // host workspace-root owner so files created by the shared container remain
  // editable by the local developer.
  await chown(agentRoot, rootStat.uid, rootStat.gid);
  await chown(workspace, rootStat.uid, rootStat.gid);
  return { agentId: options.agentId, slug, root: agentRoot, workspace };
}

const INITIALIZER_YIELD_MS = 30_000;
const INITIALIZER_OUTPUT_TOKENS = 4_000;

function initializerFailureMessage(
  initializer: SandboxInitializer,
  output: string,
): string {
  const detail = output.trim().slice(-8_000);
  return `Sandbox initializer "${initializer.name}" failed${detail ? `:\n${detail}` : ""}`;
}

/** Run lifecycle initialization before the sandbox is exposed to the Agent. */
export async function runSandboxInitializers(
  sandbox: Sandbox,
  initializers: readonly SandboxInitializer[],
): Promise<void> {
  for (const initializer of initializers) {
    let result = await sandbox.exec({
      command: initializer.command,
      yieldTimeMs: INITIALIZER_YIELD_MS,
      maxOutputTokens: INITIALIZER_OUTPUT_TOKENS,
    });
    let output = result.output;

    while (result.sessionId) {
      result = await sandbox.continue({
        sessionId: result.sessionId,
        yieldTimeMs: INITIALIZER_YIELD_MS,
        maxOutputTokens: INITIALIZER_OUTPUT_TOKENS,
      });
      output += result.output;
    }

    if (result.exitCode !== 0) {
      throw new Error(initializerFailureMessage(initializer, output));
    }
  }
}

function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

/**
 * Create the execution sandbox selected by the control plane.
 *
 * Local execution returns undefined and is intended only for trusted development.
 * Docker bind mounts require workspace paths to be identical in the controller
 * container and on the Docker daemon host.
 */
export async function createTaskSandbox(
  options: TaskSandboxOptions,
): Promise<Sandbox | undefined> {
  if (options.backend === "local") return undefined;

  const workspace = await realpath(resolve(options.workspace));
  if (options.workspaceRoot) {
    const workspaceRoot = await realpath(resolve(options.workspaceRoot));
    if (!isWithin(workspaceRoot, workspace)) {
      throw new Error(`Workspace is outside AGENT_WORKSPACE_ROOT: ${workspace}`);
    }
  }
  const image = options.image?.trim();
  if (!image) throw new Error("A Docker sandbox image is required");

  const workspaceStat = await stat(workspace);
  const runId = options.runId ?? randomUUID();
  const user = `${workspaceStat.uid}:${workspaceStat.gid}`;
  let provider: DockerSandboxProvider | SharedDockerSandboxProvider;
  let mountPath = "/workspace/repo";
  let sandboxEnvironment = options.env;
  if (options.backend === "shared-docker") {
    if (!options.workspaceRoot) {
      throw new Error("AGENT_WORKSPACE_ROOT is required for shared-docker");
    }
    const workspaceRoot = await realpath(resolve(options.workspaceRoot));
    const workspaceRelative = relative(workspaceRoot, workspace);
    if (!workspaceRelative || workspaceRelative.startsWith("..")) {
      throw new Error("Shared Agent workspace must be below AGENT_WORKSPACE_ROOT");
    }
    mountPath = `/agent-workspaces/${workspaceRelative.split(sep).join("/")}`;
    const hostAgentHome = resolve(workspace, "..", ".home");
    await mkdir(hostAgentHome, { recursive: true });
    await chown(hostAgentHome, workspaceStat.uid, workspaceStat.gid);
    const agentHome = posix.join(posix.dirname(mountPath), ".home");
    sandboxEnvironment = {
      ...options.env,
      HOME: agentHome,
      GLAB_CONFIG_DIR: `${agentHome}/.config/glab-cli`,
    };
    provider = new SharedDockerSandboxProvider({
      hostWorkspaceRoot: workspaceRoot,
      containerName: options.sharedContainerName,
      user,
    });
  } else {
    provider = new DockerSandboxProvider({
      resolveWorkspace: async () => workspace,
      user,
    });
  }

  const sandbox = await provider.create({
    runId,
    image,
    workspace: {
      id: runId,
      mountPath,
    },
    resources: {
      cpu: options.cpu ?? 2,
      memoryMb: options.memoryMb ?? 4_096,
      pids: options.pids ?? 256,
    },
    networkProfile: options.network ?? "none",
    workingDirectory: mountPath,
    timeoutMs: options.timeoutMs ?? 30 * 60_000,
    env: sandboxEnvironment,
  });

  try {
    await runSandboxInitializers(sandbox, options.initializers ?? []);
    return sandbox;
  } catch (error) {
    await sandbox.destroy().catch(() => undefined);
    throw error;
  }
}
