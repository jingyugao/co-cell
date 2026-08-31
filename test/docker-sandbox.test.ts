import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

import { describe, expect, test } from "vitest";

import {
  DockerSandboxProvider,
  type DockerCommandRunner,
} from "../src/sandbox/docker.js";
import type {
  Sandbox,
  SandboxExecResult,
  SandboxSpec,
} from "../src/sandbox/types.js";
import {
  allocateAgentSeatWorkspace,
  createTaskSandbox,
  runSandboxInitializers,
  workspaceSlug,
} from "../src/sandbox/factory.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

class FakeChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  pid = 999_999;

  kill(): boolean {
    return true;
  }
}

class FakeDockerRunner implements DockerCommandRunner {
  readonly calls: string[][] = [];
  readonly children: FakeChild[] = [];

  async run(args: readonly string[]) {
    this.calls.push([...args]);
    if (args[0] === "create") {
      return { stdout: "container-123\n", stderr: "", exitCode: 0 };
    }
    return { stdout: "", stderr: "", exitCode: 0 };
  }

  spawn(args: readonly string[]): ChildProcessWithoutNullStreams {
    this.calls.push([...args]);
    const child = new FakeChild();
    this.children.push(child);
    return child as unknown as ChildProcessWithoutNullStreams;
  }
}

function spec(): SandboxSpec {
  return {
    runId: "REQ/1001",
    image: "coding-agent:test",
    workspace: { id: "requirement-1001", mountPath: "/workspace" },
    resources: { cpu: 2, memoryMb: 4096, pids: 128 },
    networkProfile: "code-development",
    workingDirectory: "/workspace/repo",
    env: { TEST_DELIVERY_MODE: "merge-request" },
    mounts: [{
      source: "/host/credentials/kubeconfig",
      target: "/etc/swarm-hive/kubeconfig",
      readOnly: true,
    }],
  };
}

describe("DockerSandboxProvider", () => {
  test("creates a constrained container and removes it idempotently", async () => {
    const runner = new FakeDockerRunner();
    const provider = new DockerSandboxProvider({
      commandRunner: runner,
      resolveWorkspace: async () => process.cwd(),
      resolveNetwork: () => "agent-egress",
      user: "1234:1234",
    });

    const sandbox = await provider.create(spec());
    const create = runner.calls[0] ?? [];
    expect(create).toContain("--read-only");
    expect(create).toContain("no-new-privileges");
    expect(create).toContain("agent-egress");
    expect(create).toContain("1234:1234");
    expect(create).toContain("coding-agent:test");
    expect(create).toContain("TEST_DELIVERY_MODE=merge-request");
    expect(create).toContain(
      "type=bind,src=/host/credentials/kubeconfig,dst=/etc/swarm-hive/kubeconfig,readonly",
    );
    expect(await provider.get(sandbox.id)).toBe(sandbox);

    await sandbox.destroy();
    await sandbox.destroy();

    expect(runner.calls.filter((call) => call[0] === "rm")).toHaveLength(1);
    expect(await provider.get(sandbox.id)).toBeUndefined();
  });

  test("executes inside the mounted workspace and supports sessions", async () => {
    const runner = new FakeDockerRunner();
    const provider = new DockerSandboxProvider({
      commandRunner: runner,
      resolveWorkspace: async () => process.cwd(),
    });
    const sandbox = await provider.create(spec());

    const pending = sandbox.exec({
      command: "echo hello",
      cwd: "/workspace/repo",
      yieldTimeMs: 250,
    });
    const child = runner.children[0];
    if (!child) throw new Error("Expected docker exec child");
    child.stdout.write("hello\n");
    child.emit("exit", 0, null);
    const result = await pending;

    expect(result.exitCode).toBe(0);
    expect(result.output).toBe("hello\n");
    expect(runner.calls.at(-1)).toEqual([
      "exec",
      "-i",
      "--workdir",
      "/workspace/repo",
      "container-123",
      "/bin/sh",
      "-c",
      "echo hello",
    ]);

    await expect(
      sandbox.exec({ command: "pwd", cwd: "/etc" }),
    ).rejects.toThrow("outside sandbox workspace");
    await sandbox.destroy();
  });

  test("resolves relative command directories from the mounted workspace", async () => {
    const runner = new FakeDockerRunner();
    const provider = new DockerSandboxProvider({
      commandRunner: runner,
      resolveWorkspace: async () => process.cwd(),
    });
    const sandbox = await provider.create(spec());

    const pending = sandbox.exec({ command: "pwd", cwd: "." });
    const child = runner.children[0];
    if (!child) throw new Error("Expected docker exec child");
    child.emit("exit", 0, null);
    await expect(pending).resolves.toMatchObject({ exitCode: 0 });
    expect(runner.calls.at(-1)).toContain("/workspace/repo");
    await sandbox.destroy();
  });
});

describe("createTaskSandbox", () => {
  test("allocates one AgentHome per Instance and one Workspace per Seat", async () => {
    const root = await mkdtemp(join(tmpdir(), "spec-workspaces-"));
    try {
      const first = await allocateAgentSeatWorkspace({
        workspaceRoot: root,
        agentInstanceId: "software-engineer:default",
        agentSeatId: "seat-1001",
      });
      const repeated = await allocateAgentSeatWorkspace({
        workspaceRoot: root,
        agentInstanceId: "software-engineer:default",
        agentSeatId: "seat-1001",
      });
      const second = await allocateAgentSeatWorkspace({
        workspaceRoot: root,
        agentInstanceId: "software-engineer:default",
        agentSeatId: "seat-1002",
      });
      const otherInstance = await allocateAgentSeatWorkspace({
        workspaceRoot: root,
        agentInstanceId: "data-analyst:default",
        agentSeatId: "seat-2001",
      });

      expect(first.repository).toBe(repeated.repository);
      expect(first.repository).not.toBe(second.repository);
      expect(first.home).toBe(second.home);
      expect(first.home).not.toBe(otherInstance.home);
      expect(first.agentInstanceSlug).toBe(workspaceSlug("software-engineer:default"));
      expect(first.agentSeatSlug).toBe(workspaceSlug("seat-1001"));
      expect(first.workspaceRoot).toBe(join(first.seatRoot, "workspace"));
      expect(first.repository).toBe(join(first.workspaceRoot, "repo"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("uses local execution without creating a sandbox", async () => {
    await expect(
      createTaskSandbox({ backend: "local", workspace: process.cwd() }),
    ).resolves.toBeUndefined();
  });

  test("requires an image for Docker execution", async () => {
    await expect(
      createTaskSandbox({ backend: "docker", workspace: process.cwd() }),
    ).rejects.toThrow("Docker sandbox image is required");
  });

  test("rejects workspaces outside the configured host root", async () => {
    await expect(
      createTaskSandbox({
        backend: "docker",
        workspace: process.cwd(),
        workspaceRoot: "/tmp",
        image: "sandbox:test",
      }),
    ).rejects.toThrow("outside AGENT_WORKSPACE_ROOT");
  });
});

describe("runSandboxInitializers", () => {
  function fakeSandbox(
    execResults: SandboxExecResult[],
    continueResults: SandboxExecResult[] = [],
  ): { sandbox: Sandbox; commands: string[]; continuations: string[] } {
    const commands: string[] = [];
    const continuations: string[] = [];
    return {
      commands,
      continuations,
      sandbox: {
        id: "sandbox-initializer-test",
        info: async () => {
          throw new Error("not used");
        },
        exec: async (request) => {
          commands.push(request.command);
          const result = execResults.shift();
          if (!result) throw new Error("Missing fake exec result");
          return result;
        },
        continue: async (request) => {
          continuations.push(request.sessionId);
          const result = continueResults.shift();
          if (!result) throw new Error("Missing fake continue result");
          return result;
        },
        stop: async () => undefined,
        destroy: async () => undefined,
      },
    };
  }

  test("waits for initialization sessions before returning", async () => {
    const { sandbox, commands, continuations } = fakeSandbox(
      [{ output: "starting\n", sessionId: "session-1", wallTimeSeconds: 30 }],
      [{ output: "ready\n", exitCode: 0, wallTimeSeconds: 1 }],
    );

    await runSandboxInitializers(sandbox, [
      { name: "gitlab", command: "gitlab-init" },
    ]);

    expect(commands).toEqual(["gitlab-init"]);
    expect(continuations).toEqual(["session-1"]);
  });

  test("stops when an initializer exits unsuccessfully", async () => {
    const { sandbox, commands } = fakeSandbox([
      { output: "origin mismatch", exitCode: 1, wallTimeSeconds: 1 },
    ]);

    await expect(
      runSandboxInitializers(sandbox, [
        { name: "gitlab", command: "gitlab-init" },
        { name: "dependencies", command: "install-dependencies" },
      ]),
    ).rejects.toThrow('Sandbox initializer "gitlab" failed:\norigin mismatch');
    expect(commands).toEqual(["gitlab-init"]);
  });
});
