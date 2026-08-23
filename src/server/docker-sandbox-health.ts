import { execFile } from "node:child_process";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";

import type {
  SandboxHealthProvider,
  SandboxRuntimeStatus,
} from "../application/workbench-query-service.js";

const execFileAsync = promisify(execFile);

export class DockerSandboxHealthProvider implements SandboxHealthProvider {
  private cached?: { expiresAt: number; value: SandboxRuntimeStatus };

  constructor(
    private readonly containerName: string,
    private readonly cacheMilliseconds = 5_000,
  ) {}

  async getStatus(): Promise<SandboxRuntimeStatus> {
    const now = Date.now();
    if (this.cached && this.cached.expiresAt > now) return this.cached.value;

    const started = performance.now();
    let status: SandboxRuntimeStatus["status"] = "unknown";
    try {
      const result = await execFileAsync(
        "docker",
        [
          "ps",
          "--all",
          "--filter",
          `name=^/${this.containerName}-`,
          "--format",
          "{{.State}}",
        ],
        { timeout: 2_000 },
      );
      const states = result.stdout.trim().split("\n").filter(Boolean);
      status = states.some((state) => state === "running") ? "online" : "offline";
    } catch (error) {
      const exitCode =
        error !== null && typeof error === "object" && "code" in error
          ? String(error.code)
          : undefined;
      status = exitCode === "1" ? "offline" : "unknown";
    }

    const value: SandboxRuntimeStatus = {
      status,
      name: `${this.containerName}-*`,
      latencyMs: Math.round(performance.now() - started),
    };
    this.cached = { expiresAt: now + this.cacheMilliseconds, value };
    return value;
  }
}
