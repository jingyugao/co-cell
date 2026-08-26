import { createHash, randomUUID } from "node:crypto";
import { chown, mkdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, posix, relative, resolve, sep } from "node:path";

import { DockerSandboxProvider } from "./docker.js";
import { SharedDockerSandboxProvider } from "./shared-docker.js";
import type { Sandbox, SandboxMount } from "./types.js";

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
  mounts?: readonly SandboxMount[];
  initializers?: readonly SandboxInitializer[];
  sharedContainerName?: string;
}

export interface InstanceProjectWorkspace {
  instanceKey: string;
  projectId: string;
  instanceSlug: string;
  projectSlug: string;
  projectRoot: string;
  workspace: string;
  home: string;
  projectsRoot: string;
}

export function workspaceSlug(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "workspace";
  const digest = createHash("sha256").update(value).digest("hex").slice(0, 8);
  return `${normalized}-${digest}`;
}

/** Allocate one project directory inside the persistent HOME owned by an Instance. */
export async function allocateInstanceProjectWorkspace(options: {
  workspaceRoot: string;
  instanceKey: string;
  projectId: string;
}): Promise<InstanceProjectWorkspace> {
  const requestedRoot = resolve(options.workspaceRoot);
  await mkdir(requestedRoot, { recursive: true });
  const root = await realpath(requestedRoot);
  const rootStat = await stat(root);
  const instanceSlug = workspaceSlug(options.instanceKey);
  const projectSlug = workspaceSlug(options.projectId);
  const instanceRoot = resolve(root, "instances", instanceSlug);
  const home = resolve(instanceRoot, "home");
  const projectsRoot = resolve(home, "projects");
  const projectRoot = resolve(projectsRoot, projectSlug);
  const workspace = resolve(projectRoot, "repo");
  const persistentDirectories = [
    instanceRoot,
    home,
    resolve(home, ".local"),
    resolve(home, ".local/share"),
    resolve(home, ".local/share/lark-cli"),
    resolve(home, ".lark-cli"),
    projectsRoot,
    projectRoot,
    workspace,
  ];
  for (const directory of persistentDirectories) {
    await mkdir(directory, { recursive: true });
  }
  // The controller commonly runs as root to access docker.sock. Preserve the
  // host workspace-root owner across the Spec HOME, mount points, and project.
  // Docker otherwise creates missing nested bind-mount targets as root.
  for (const directory of persistentDirectories) {
    const directoryStat = await stat(directory);
    if (directoryStat.uid !== rootStat.uid || directoryStat.gid !== rootStat.gid) {
      await chown(directory, rootStat.uid, rootStat.gid);
    }
  }
  return {
    instanceKey: options.instanceKey,
    projectId: options.projectId,
    instanceSlug,
    projectSlug,
    projectRoot,
    workspace,
    home,
    projectsRoot,
  };
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
  const mounts = await Promise.all((options.mounts ?? []).map(async (mount) => {
    if (!isAbsolute(mount.target) || mount.target === "/") {
      throw new Error(`Sandbox mount target must be an absolute non-root path: ${mount.target}`);
    }
    const source = await realpath(resolve(mount.source));
    if (source.includes(",") || mount.target.includes(",")) {
      throw new Error("Sandbox mount paths cannot contain commas");
    }
    return { ...mount, source };
  }));
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
    const agentHome = "/home/agent";
    mountPath = posix.join(
      agentHome,
      workspaceRelative.split(sep).join("/"),
    );
    sandboxEnvironment = {
      ...options.env,
      HOME: agentHome,
      GLAB_CONFIG_DIR: `${agentHome}/.config/glab-cli`,
    };
    provider = new SharedDockerSandboxProvider({
      hostWorkspaceRoot: workspaceRoot,
      containerWorkspaceRoot: agentHome,
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
    mounts,
  });

  try {
    await runSandboxInitializers(sandbox, options.initializers ?? []);
    return sandbox;
  } catch (error) {
    await sandbox.destroy().catch(() => undefined);
    throw error;
  }
}
