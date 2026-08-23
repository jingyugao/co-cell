import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { describe, expect, test } from "vitest";

import type {
  DockerCommandResult,
  DockerCommandRunner,
} from "../src/sandbox/docker.js";
import { SharedDockerSandboxProvider } from "../src/sandbox/shared-docker.js";
import type { SandboxSpec } from "../src/sandbox/types.js";

class FakeChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  pid = 999_998;

  kill(): boolean {
    return true;
  }
}

class FakeRunner implements DockerCommandRunner {
  readonly calls: string[][] = [];
  readonly children: FakeChild[] = [];

  async run(args: readonly string[]): Promise<DockerCommandResult> {
    this.calls.push([...args]);
    if (args[0] === "inspect") {
      return { stdout: "", stderr: "not found", exitCode: 1 };
    }
    return { stdout: "shared-container\n", stderr: "", exitCode: 0 };
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
    runId: "requirement-1001",
    image: "swarm-hive-sandbox-python:3.12",
    workspace: {
      id: "requirement-1001",
      mountPath: "/home/agent/projects/project-1001/repo",
    },
    workingDirectory: "/home/agent/projects/project-1001/repo",
    resources: { cpu: 2, memoryMb: 4096 },
    networkProfile: "bridge",
    env: { HOME: "/home/agent" },
    mounts: [{
      source: "/host/credentials/kubeconfig",
      target: "/etc/swarm-hive/kubeconfig",
      readOnly: true,
    }],
  };
}

describe("SharedDockerSandboxProvider", () => {
  test("creates one persistent container and only destroys the logical handle", async () => {
    const runner = new FakeRunner();
    const provider = new SharedDockerSandboxProvider({
      hostWorkspaceRoot: process.cwd(),
      containerWorkspaceRoot: "/home/agent",
      containerName: "swarm-hive-test-shared",
      commandRunner: runner,
      user: "1234:1234",
    });

    const sandbox = await provider.create(spec());
    expect(runner.calls[0]).toEqual(["inspect", "swarm-hive-test-shared"]);
    const create = runner.calls.find((call) => call[0] === "create") ?? [];
    expect(create).toContain("swarm-hive.shared-sandbox=true");
    expect(create).toContain("swarm-hive-sandbox-python:3.12");
    expect(create).toContain(
      "type=bind,src=/host/credentials/kubeconfig,dst=/etc/swarm-hive/kubeconfig,readonly",
    );

    const pending = sandbox.exec({ command: "pwd" });
    const child = runner.children[0];
    if (!child) throw new Error("Expected docker exec child");
    child.stdout.write("/home/agent/projects/project-1001/repo\n");
    child.emit("exit", 0, null);
    await expect(pending).resolves.toMatchObject({ exitCode: 0 });

    const exec = runner.calls.at(-1) ?? [];
    expect(exec).toContain("HOME=/home/agent");
    expect(exec).toContain("/home/agent/projects/project-1001/repo");

    await sandbox.destroy();
    expect(runner.calls.some((call) => call[0] === "rm")).toBe(false);
    await expect(provider.get(sandbox.id)).resolves.toBeUndefined();
  });

  test("rejects commands outside the assigned Agent directory", async () => {
    const runner = new FakeRunner();
    const provider = new SharedDockerSandboxProvider({
      hostWorkspaceRoot: process.cwd(),
      containerWorkspaceRoot: "/home/agent",
      commandRunner: runner,
    });
    const sandbox = await provider.create(spec());

    await expect(
      sandbox.exec({ command: "pwd", cwd: "/home/agent/projects/another-project/repo" }),
    ).rejects.toThrow("outside agent workspace");
    await sandbox.destroy();
  });

  test("resolves relative command directories from the assigned workspace", async () => {
    const runner = new FakeRunner();
    const provider = new SharedDockerSandboxProvider({
      hostWorkspaceRoot: process.cwd(),
      containerWorkspaceRoot: "/home/agent",
      commandRunner: runner,
    });
    const sandbox = await provider.create(spec());

    const pending = sandbox.exec({ command: "pwd", cwd: "." });
    const child = runner.children[0];
    if (!child) throw new Error("Expected docker exec child");
    child.emit("exit", 0, null);
    await expect(pending).resolves.toMatchObject({ exitCode: 0 });
    expect(runner.calls.at(-1)).toContain("/home/agent/projects/project-1001/repo");
    await sandbox.destroy();
  });
});
