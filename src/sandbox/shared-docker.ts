import { createHash } from "node:crypto";
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
  NetworkSettings?: { Networks?: Record<string, unknown> };
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
}

class StaleSharedSandboxError extends Error {}

function mountFingerprint(
  hostRoot: string,
  containerWorkspaceRoot: string,
  mounts: readonly { source: string; target: string; readOnly?: boolean }[],
): string {
  const configuration = [
    { source: hostRoot, target: containerWorkspaceRoot, readOnly: false },
    ...mounts.map((mount) => ({
      source: mount.source,
      target: mount.target,
      readOnly: mount.readOnly === true,
    })),
  ].sort((left, right) => left.target.localeCompare(right.target));
  return createHash("sha256").update(JSON.stringify(configuration)).digest("hex");
}

async function sameRealPath(left: string | undefined, right: string): Promise<boolean> {
  if (!left) return false;
  try {
    return await realpath(left) === right;
  } catch {
    // Docker Desktop exposes bind sources created through the Docker socket as
    // VM-internal /run/desktop paths which are not visible in the controller.
    return false;
  }
}

export interface SharedDockerSandboxProviderOptions {
  hostWorkspaceRoot: string;
  containerWorkspaceRoot?: string;
  containerName?: string;
  commandRunner?: DockerCommandRunner;
  shell?: string;
  user?: string;
  dockerSidecar?: {
    image: string;
  };
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

  private get dockerContainerName(): string {
    return `${this.containerName}-docker`;
  }

  private get dockerNetworkName(): string {
    return `${this.containerName}-network`;
  }

  private get dockerDataVolumeName(): string {
    return `${this.containerName}-docker-data`;
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
    if (this.options.dockerSidecar) {
      await this.ensureDockerNetwork();
      await this.ensureDockerSidecar(hostRoot);
    }
    const inspectResult = await this.runner.run(["inspect", this.containerName]);
    if (inspectResult.exitCode === 0) {
      try {
        await this.useExistingContainer(inspectResult.stdout, hostRoot, spec);
        return;
      } catch (error) {
        if (!(error instanceof StaleSharedSandboxError)) throw error;
        const removed = await this.runner.run(["rm", "-f", this.containerName]);
        assertDockerSuccess(removed, "docker replace stale shared sandbox");
      }
    }

    const createArgs = [
      "create",
      "--name",
      this.containerName,
      "--label",
      "swarm-hive.shared-sandbox=true",
      "--label",
      `swarm-hive.workspace-root=${hostRoot}`,
      "--label",
      `swarm-hive.mounts-fingerprint=${mountFingerprint(
        hostRoot,
        this.containerWorkspaceRoot,
        spec.mounts ?? [],
      )}`,
      "--network",
      this.options.dockerSidecar ? this.dockerNetworkName : spec.networkProfile,
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

  private async ensureDockerNetwork(): Promise<void> {
    const inspect = await this.runner.run(["network", "inspect", this.dockerNetworkName]);
    if (inspect.exitCode === 0) return;
    const created = await this.runner.run([
      "network",
      "create",
      "--label",
      "swarm-hive.dind-network=true",
      this.dockerNetworkName,
    ]);
    if (created.exitCode !== 0) {
      const racedInspect = await this.runner.run(["network", "inspect", this.dockerNetworkName]);
      if (racedInspect.exitCode !== 0) {
        assertDockerSuccess(created, "docker create Agent DinD network");
      }
    }
  }

  private async ensureDockerSidecar(hostRoot: string): Promise<void> {
    const inspect = await this.runner.run(["inspect", this.dockerContainerName]);
    if (inspect.exitCode === 0) {
      const inspected = JSON.parse(inspect.stdout) as DockerInspect[];
      const container = inspected[0];
      if (!container) throw new Error("docker inspect returned no Agent DinD container");
      if (container.Config?.Labels?.["swarm-hive.dind-sidecar"] !== "true") {
        throw new Error(
          `Container ${this.dockerContainerName} exists but is not managed by SwarmHive`,
        );
      }
      if (container.Config.Image !== this.options.dockerSidecar?.image) {
        throw new Error(
          `Agent DinD ${this.dockerContainerName} uses image ${container.Config.Image ?? "unknown"}; expected ${this.options.dockerSidecar?.image}. Recreate it before starting agents.`,
        );
      }
      const workspaceMount = container.Mounts?.find(
        (candidate) => candidate.Destination === this.containerWorkspaceRoot,
      );
      const labeledWorkspaceRoot = container.Config?.Labels?.["swarm-hive.workspace-root"];
      if (
        !workspaceMount ||
        (labeledWorkspaceRoot !== undefined && labeledWorkspaceRoot !== hostRoot)
      ) {
        throw new Error(
          `Agent DinD ${this.dockerContainerName} is mounted to a different workspace root`,
        );
      }
      if (!container.NetworkSettings?.Networks?.[this.dockerNetworkName]) {
        const connected = await this.runner.run([
          "network",
          "connect",
          "--alias",
          "docker-daemon",
          this.dockerNetworkName,
          this.dockerContainerName,
        ]);
        assertDockerSuccess(connected, "docker connect Agent DinD network");
      }
      if (!container.State?.Running) {
        const started = await this.runner.run(["start", this.dockerContainerName]);
        assertDockerSuccess(started, "docker start Agent DinD");
      }
      await this.waitForDockerSidecar();
      return;
    }

    const created = await this.runner.run([
      "create",
      "--name",
      this.dockerContainerName,
      "--label",
      "swarm-hive.dind-sidecar=true",
      "--label",
      `swarm-hive.workspace-root=${hostRoot}`,
      "--privileged",
      "--restart",
      "unless-stopped",
      "--network",
      this.dockerNetworkName,
      "--network-alias",
      "docker-daemon",
      "--env",
      "DOCKER_TLS_CERTDIR=",
      "--mount",
      `type=volume,src=${this.dockerDataVolumeName},dst=/var/lib/docker`,
      "--mount",
      `type=bind,src=${hostRoot},dst=${this.containerWorkspaceRoot}`,
      this.options.dockerSidecar!.image,
    ]);
    assertDockerSuccess(created, "docker create Agent DinD");
    const started = await this.runner.run(["start", this.dockerContainerName]);
    assertDockerSuccess(started, "docker start Agent DinD");
    await this.waitForDockerSidecar();
  }

  private async waitForDockerSidecar(): Promise<void> {
    let lastError = "Docker daemon did not become ready";
    for (let attempt = 1; attempt <= 60; attempt += 1) {
      const result = await this.runner.run([
        "exec",
        this.dockerContainerName,
        "docker",
        "info",
        "--format",
        "{{.ServerVersion}}",
      ]);
      if (result.exitCode === 0) return;
      lastError = result.stderr.trim() || result.stdout.trim() || lastError;
      await wait(Math.min(attempt * 100, 1_000));
    }
    throw new Error(`Agent DinD ${this.dockerContainerName} is not ready: ${lastError}`);
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
      throw new StaleSharedSandboxError(
        `Shared sandbox ${this.containerName} uses image ${container.Config.Image ?? "unknown"}; expected ${spec.image}. Recreate it before starting agents.`,
      );
    }
    if (
      this.options.dockerSidecar &&
      !container.NetworkSettings?.Networks?.[this.dockerNetworkName]
    ) {
      const connected = await this.runner.run([
        "network",
        "connect",
        this.dockerNetworkName,
        this.containerName,
      ]);
      assertDockerSuccess(connected, "docker connect shared sandbox to Agent DinD network");
    }
    const mount = container.Mounts?.find(
      (candidate) => candidate.Destination === this.containerWorkspaceRoot,
    );
    const labeledWorkspaceRoot = container.Config?.Labels?.["swarm-hive.workspace-root"];
    if (
      !mount ||
      (labeledWorkspaceRoot
        ? labeledWorkspaceRoot !== hostRoot
        : !(await sameRealPath(mount.Source, hostRoot)))
    ) {
      throw new StaleSharedSandboxError(
        `Shared sandbox ${this.containerName} is mounted to a different workspace root`,
      );
    }
    const expectedMountFingerprint = mountFingerprint(
      hostRoot,
      this.containerWorkspaceRoot,
      spec.mounts ?? [],
    );
    const labeledMountFingerprint =
      container.Config?.Labels?.["swarm-hive.mounts-fingerprint"];
    if (
      labeledMountFingerprint !== undefined &&
      labeledMountFingerprint !== expectedMountFingerprint
    ) {
      throw new StaleSharedSandboxError(
        `Shared sandbox ${this.containerName} uses stale mounts`,
      );
    }
    for (const required of spec.mounts ?? []) {
      const configured = container.Mounts?.find(
        (candidate) => candidate.Destination === required.target,
      );
      if (
        !configured ||
        (labeledMountFingerprint === undefined &&
          !(await sameRealPath(configured.Source, await realpath(required.source)))) ||
        (required.readOnly === true && configured.RW !== false)
      ) {
        throw new StaleSharedSandboxError(
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
