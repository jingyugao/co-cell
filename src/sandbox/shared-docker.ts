import { realpath } from "node:fs/promises";
import { isAbsolute, posix } from "node:path";

import { ProcessSessionManager } from "./process-sessions.js";
import {
  DockerCliCommandRunner,
  type DockerCommandRunner,
} from "./docker.js";
import type {
  Sandbox,
  SandboxContinueRequest,
  SandboxExecRequest,
  SandboxExecResult,
  SandboxInfo,
  SandboxProvider,
  SandboxSpec,
  WorkspaceRef,
} from "./types.js";

interface DockerInspect {
  Config?: {
    Image?: string;
    Labels?: Record<string, string>;
  };
  State?: { Running?: boolean };
  Mounts?: Array<{ Source?: string; Destination?: string; RW?: boolean }>;
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
}

export interface SharedDockerSandboxProviderOptions {
  hostWorkspaceRoot: string;
  containerWorkspaceRoot?: string;
  containerName?: string;
  commandRunner?: DockerCommandRunner;
  shell?: string;
  user?: string;
}

function assertDockerSuccess(
  result: { exitCode: number; stdout: string; stderr: string },
  operation: string,
): void {
  if (result.exitCode !== 0) {
    throw new Error(
      `${operation} failed: ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
}

function assertWorkspacePath(path: string, workspace: WorkspaceRef): void {
  if (!isAbsolute(path)) throw new Error(`Sandbox path must be absolute: ${path}`);
  const relative = posix.relative(workspace.mountPath, path);
  if (relative.startsWith("..") || posix.isAbsolute(relative)) {
    throw new Error(`Path is outside agent workspace: ${path}`);
  }
}

/**
 * Provides logical per-agent sandboxes backed by one persistent Docker container.
 * Each logical sandbox has its own working directory and process sessions; destroy
 * releases only that logical handle and deliberately leaves the container running.
 */
export class SharedDockerSandboxProvider implements SandboxProvider {
  readonly name = "shared-docker";
  private readonly runner: DockerCommandRunner;
  private readonly sandboxes = new Map<string, SharedDockerSandbox>();
  private ensurePromise?: Promise<void>;

  constructor(private readonly options: SharedDockerSandboxProviderOptions) {
    this.runner = options.commandRunner ?? new DockerCliCommandRunner();
  }

  async create(spec: SandboxSpec): Promise<Sandbox> {
    assertWorkspacePath(
      spec.workingDirectory ?? spec.workspace.mountPath,
      spec.workspace,
    );
    await this.ensureContainer(spec);
    const sandbox = new SharedDockerSandbox({
      id: `${this.containerName}:${spec.runId}`,
      containerName: this.containerName,
      spec,
      runner: this.runner,
      shell: this.options.shell ?? "/bin/sh",
      createdAt: new Date().toISOString(),
      onDestroy: (id) => this.sandboxes.delete(id),
    });
    this.sandboxes.set(sandbox.id, sandbox);
    return sandbox;
  }

  async get(sandboxId: string): Promise<Sandbox | undefined> {
    return this.sandboxes.get(sandboxId);
  }

  private get containerName(): string {
    return this.options.containerName ?? "swarm-hive-dev-sandbox";
  }

  private get containerWorkspaceRoot(): string {
    return this.options.containerWorkspaceRoot ?? "/agent-workspaces";
  }

  private ensureContainer(spec: SandboxSpec): Promise<void> {
    this.ensurePromise ??= this.ensureContainerOnce(spec).catch((error) => {
      this.ensurePromise = undefined;
      throw error;
    });
    return this.ensurePromise;
  }

  private async ensureContainerOnce(spec: SandboxSpec): Promise<void> {
    const hostRoot = await realpath(this.options.hostWorkspaceRoot);
    const inspectResult = await this.runner.run(["inspect", this.containerName]);
    if (inspectResult.exitCode === 0) {
      await this.useExistingContainer(inspectResult.stdout, hostRoot, spec);
      return;
    }

    const createArgs = [
      "create",
      "--name",
      this.containerName,
      "--label",
      "swarm-hive.shared-sandbox=true",
      "--network",
      spec.networkProfile,
      "--user",
      this.options.user ?? "10001:10001",
      "--mount",
      `type=bind,src=${hostRoot},dst=${this.containerWorkspaceRoot}`,
      "--workdir",
      this.containerWorkspaceRoot,
    ];
    for (const mount of spec.mounts ?? []) {
      createArgs.push(
        "--mount",
        `type=bind,src=${mount.source},dst=${mount.target}${mount.readOnly ? ",readonly" : ""}`,
      );
    }
    createArgs.push(
      "--entrypoint",
      "sleep",
      spec.image,
      "infinity",
    );
    const createResult = await this.runner.run(createArgs);
    if (createResult.exitCode !== 0) {
      // Two controller processes may race while creating the first shared
      // container. Accept the winner only after applying the same validation.
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        const racedInspect = await this.runner.run(["inspect", this.containerName]);
        if (racedInspect.exitCode === 0) {
          await this.useExistingContainer(racedInspect.stdout, hostRoot, spec);
          return;
        }
        await wait(attempt * 50);
      }
      assertDockerSuccess(createResult, "docker create shared sandbox");
    }
    const startResult = await this.runner.run(["start", this.containerName]);
    assertDockerSuccess(startResult, "docker start shared sandbox");
  }

  private async useExistingContainer(
    inspectOutput: string,
    hostRoot: string,
    spec: SandboxSpec,
  ): Promise<void> {
    const inspected = JSON.parse(inspectOutput) as DockerInspect[];
    const container = inspected[0];
    if (!container) throw new Error("docker inspect returned no shared container");
    if (container.Config?.Labels?.["swarm-hive.shared-sandbox"] !== "true") {
      throw new Error(
        `Container ${this.containerName} exists but is not managed by SwarmHive`,
      );
    }
    if (container.Config.Image !== spec.image) {
      throw new Error(
        `Shared sandbox ${this.containerName} uses image ${container.Config.Image ?? "unknown"}; expected ${spec.image}. Recreate it before starting agents.`,
      );
    }
    const mount = container.Mounts?.find(
      (candidate) => candidate.Destination === this.containerWorkspaceRoot,
    );
    if (!mount || (await realpath(mount.Source ?? "")) !== hostRoot) {
      throw new Error(
        `Shared sandbox ${this.containerName} is mounted to a different workspace root`,
      );
    }
    for (const required of spec.mounts ?? []) {
      const configured = container.Mounts?.find(
        (candidate) => candidate.Destination === required.target,
      );
      if (
        !configured ||
        (await realpath(configured.Source ?? "")) !== await realpath(required.source) ||
        (required.readOnly === true && configured.RW !== false)
      ) {
        throw new Error(
          `Shared sandbox ${this.containerName} is missing required mount ${required.target}. Recreate it before starting agents.`,
        );
      }
    }
    if (!container.State?.Running) {
      const startResult = await this.runner.run(["start", this.containerName]);
      assertDockerSuccess(startResult, "docker start shared sandbox");
    }
  }
}

class SharedDockerSandbox implements Sandbox {
  readonly id: string;
  private status: SandboxInfo["status"] = "running";
  private readonly sessions: ProcessSessionManager;

  constructor(
    private readonly options: {
      id: string;
      containerName: string;
      spec: SandboxSpec;
      runner: DockerCommandRunner;
      shell: string;
      createdAt: string;
      onDestroy(id: string): void;
    },
  ) {
    this.id = options.id;
    this.sessions = new ProcessSessionManager(options.spec.timeoutMs ?? 30 * 60_000);
  }

  async info(): Promise<SandboxInfo> {
    return {
      id: this.id,
      provider: "shared-docker",
      runId: this.options.spec.runId,
      status: this.status,
      workspace: this.options.spec.workspace,
      createdAt: this.options.createdAt,
    };
  }

  async exec(request: SandboxExecRequest): Promise<SandboxExecResult> {
    if (this.status !== "running") {
      throw new Error(`Cannot execute command in ${this.status} sandbox`);
    }
    const defaultCwd =
      this.options.spec.workingDirectory ?? this.options.spec.workspace.mountPath;
    const cwd = request.cwd
      ? isAbsolute(request.cwd) ? request.cwd : posix.resolve(defaultCwd, request.cwd)
      : defaultCwd;
    assertWorkspacePath(cwd, this.options.spec.workspace);
    const args = ["exec", "-i", "--workdir", cwd];
    const environment = { ...this.options.spec.env, ...request.env };
    for (const [key, value] of Object.entries(environment)) {
      args.push("--env", `${key}=${value}`);
    }
    args.push(
      this.options.containerName,
      this.options.shell,
      request.login ? "-lc" : "-c",
      request.command,
    );
    const child = this.options.runner.spawn(args);
    return this.sessions.start(child, {
      yieldTimeMs: request.yieldTimeMs,
      maxOutputTokens: request.maxOutputTokens,
    });
  }

  continue(request: SandboxContinueRequest): Promise<SandboxExecResult> {
    return this.sessions.continue(request);
  }

  async stop(): Promise<void> {
    if (this.status !== "running") return;
    this.sessions.dispose();
    this.status = "stopped";
  }

  async destroy(): Promise<void> {
    if (this.status === "destroyed") return;
    this.sessions.dispose();
    this.status = "destroyed";
    this.options.onDestroy(this.id);
  }
}
