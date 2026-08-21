import {
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { realpath } from "node:fs/promises";
import { isAbsolute, posix } from "node:path";

import { ProcessSessionManager } from "./process-sessions.js";
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

export interface DockerCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface DockerCommandRunner {
  run(args: readonly string[]): Promise<DockerCommandResult>;
  spawn(args: readonly string[]): ChildProcessWithoutNullStreams;
}

export class DockerCliCommandRunner implements DockerCommandRunner {
  constructor(private readonly executable = "docker") {}

  async run(args: readonly string[]): Promise<DockerCommandResult> {
    return new Promise((resolveResult, reject) => {
      const child = spawn(this.executable, [...args], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.once("error", reject);
      child.once("exit", (code) => {
        resolveResult({
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
          exitCode: code ?? 1,
        });
      });
    });
  }

  spawn(args: readonly string[]): ChildProcessWithoutNullStreams {
    return spawn(this.executable, [...args], {
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
  }
}

export interface DockerSandboxProviderOptions {
  /** Resolves a backend-neutral workspace reference to a host directory. */
  resolveWorkspace(workspace: WorkspaceRef): Promise<string>;
  /** Resolves a policy name to a preconfigured Docker network. */
  resolveNetwork?: (networkProfile: string) => string;
  commandRunner?: DockerCommandRunner;
  shell?: string;
  /** Numeric uid:gid used inside containers. Defaults to an unprivileged identity. */
  user?: string;
}

function assertDockerSuccess(result: DockerCommandResult, operation: string): void {
  if (result.exitCode !== 0) {
    throw new Error(`${operation} failed: ${result.stderr.trim() || result.stdout.trim()}`);
  }
}

function safeContainerName(runId: string): string {
  const normalized = runId.toLowerCase().replace(/[^a-z0-9_.-]/g, "-").slice(0, 48);
  return `agent-${normalized || "run"}`;
}

function assertContainerPath(path: string, workspace: WorkspaceRef): void {
  if (!isAbsolute(path)) throw new Error(`Sandbox path must be absolute: ${path}`);
  const relative = posix.relative(workspace.mountPath, path);
  if (relative.startsWith("..") || posix.isAbsolute(relative)) {
    throw new Error(`Path is outside sandbox workspace: ${path}`);
  }
}

export class DockerSandboxProvider implements SandboxProvider {
  readonly name = "docker";
  private readonly sandboxes = new Map<string, DockerSandbox>();
  private readonly runner: DockerCommandRunner;

  constructor(private readonly options: DockerSandboxProviderOptions) {
    this.runner = options.commandRunner ?? new DockerCliCommandRunner();
  }

  async create(spec: SandboxSpec): Promise<Sandbox> {
    if (spec.resources.cpu <= 0) throw new Error("resources.cpu must be positive");
    if (spec.resources.memoryMb <= 0) {
      throw new Error("resources.memoryMb must be positive");
    }
    if (spec.resources.pids !== undefined && spec.resources.pids <= 0) {
      throw new Error("resources.pids must be positive");
    }
    const hostWorkspace = await realpath(await this.options.resolveWorkspace(spec.workspace));
    if (!isAbsolute(spec.workspace.mountPath)) {
      throw new Error("workspace.mountPath must be absolute");
    }
    const workingDirectory = spec.workingDirectory ?? `${spec.workspace.mountPath}/repo`;
    assertContainerPath(workingDirectory, spec.workspace);
    const network = this.options.resolveNetwork?.(spec.networkProfile) ?? spec.networkProfile;
    const args = [
      "create",
      "--name",
      safeContainerName(spec.runId),
      "--label",
      `agent.run_id=${spec.runId}`,
      "--label",
      `agent.workspace_id=${spec.workspace.id}`,
      "--network",
      network,
      "--user",
      this.options.user ?? "10001:10001",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--cpus",
      String(spec.resources.cpu),
      "--memory",
      `${spec.resources.memoryMb}m`,
      "--pids-limit",
      String(spec.resources.pids ?? 256),
      "--tmpfs",
      "/tmp:rw,nosuid,nodev,size=512m",
      "--mount",
      `type=bind,src=${hostWorkspace},dst=${spec.workspace.mountPath}`,
      "--workdir",
      workingDirectory,
    ];
    for (const mount of spec.mounts ?? []) {
      args.push(
        "--mount",
        `type=bind,src=${mount.source},dst=${mount.target}${mount.readOnly ? ",readonly" : ""}`,
      );
    }
    for (const [key, value] of Object.entries(spec.env ?? {})) {
      args.push("--env", `${key}=${value}`);
    }
    for (const [key, value] of Object.entries(spec.labels ?? {})) {
      args.push("--label", `${key}=${value}`);
    }
    args.push("--entrypoint", "sleep", spec.image, "infinity");

    const createdAt = new Date().toISOString();
    const createResult = await this.runner.run(args);
    assertDockerSuccess(createResult, "docker create");
    const containerId = createResult.stdout.trim();
    if (!containerId) throw new Error("docker create returned an empty container id");
    try {
      const startResult = await this.runner.run(["start", containerId]);
      assertDockerSuccess(startResult, "docker start");
    } catch (error) {
      await this.runner.run(["rm", "-f", containerId]);
      throw error;
    }

    const sandbox = new DockerSandbox({
      containerId,
      spec,
      createdAt,
      runner: this.runner,
      shell: this.options.shell ?? "/bin/sh",
      onDestroy: () => this.sandboxes.delete(containerId),
    });
    this.sandboxes.set(containerId, sandbox);
    return sandbox;
  }

  async get(sandboxId: string): Promise<Sandbox | undefined> {
    return this.sandboxes.get(sandboxId);
  }
}

class DockerSandbox implements Sandbox {
  readonly id: string;
  private status: SandboxInfo["status"] = "running";
  private readonly sessions: ProcessSessionManager;

  constructor(
    private readonly options: {
      containerId: string;
      spec: SandboxSpec;
      createdAt: string;
      runner: DockerCommandRunner;
      shell: string;
      onDestroy(): void;
    },
  ) {
    this.id = options.containerId;
    this.sessions = new ProcessSessionManager(
      options.spec.timeoutMs ?? 30 * 60_000,
      () => {
        this.status = "failed";
        void this.options.runner.run(["kill", this.id]);
      },
    );
  }

  async info(): Promise<SandboxInfo> {
    return {
      id: this.id,
      provider: "docker",
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
      this.options.spec.workingDirectory ?? `${this.options.spec.workspace.mountPath}/repo`;
    const cwd = request.cwd
      ? isAbsolute(request.cwd) ? request.cwd : posix.resolve(defaultCwd, request.cwd)
      : defaultCwd;
    assertContainerPath(cwd, this.options.spec.workspace);
    const args = ["exec", "-i", "--workdir", cwd];
    for (const [key, value] of Object.entries(request.env ?? {})) {
      args.push("--env", `${key}=${value}`);
    }
    args.push(
      this.id,
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

  async stop(options: { gracePeriodMs?: number } = {}): Promise<void> {
    if (this.status === "destroyed" || this.status === "stopped") return;
    this.sessions.dispose();
    const seconds = Math.max(0, Math.ceil((options.gracePeriodMs ?? 10_000) / 1000));
    const result = await this.options.runner.run(["stop", "--time", String(seconds), this.id]);
    assertDockerSuccess(result, "docker stop");
    this.status = "stopped";
  }

  async destroy(): Promise<void> {
    if (this.status === "destroyed") return;
    this.sessions.dispose();
    const result = await this.options.runner.run(["rm", "-f", this.id]);
    if (result.exitCode !== 0 && !result.stderr.includes("No such container")) {
      assertDockerSuccess(result, "docker rm");
    }
    this.status = "destroyed";
    this.options.onDestroy();
  }
}
