import { type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";

import type {
  SandboxContinueRequest,
  SandboxExecResult,
} from "./types.js";

interface RunningProcess {
  child: ChildProcessWithoutNullStreams;
  startedAt: number;
  chunks: string[];
  cursor: number;
  exitCode?: number;
  done: Promise<void>;
  killTimer: NodeJS.Timeout;
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((done) => setTimeout(done, milliseconds));
}

function truncateOutput(value: string, maxTokens: number): {
  output: string;
  originalTokenCount?: number;
} {
  const originalTokenCount = Math.ceil(value.length / 4);
  if (originalTokenCount <= maxTokens) return { output: value };
  const maxCharacters = maxTokens * 4;
  const headLength = Math.floor(maxCharacters * 0.2);
  const tailLength = maxCharacters - headLength;
  return {
    output: `${value.slice(0, headLength)}\n\n[... output truncated ...]\n\n${value.slice(-tailLength)}`,
    originalTokenCount,
  };
}

/** Tracks interactive host processes used to communicate with a sandbox runtime. */
export class ProcessSessionManager {
  private readonly processes = new Map<string, RunningProcess>();

  constructor(
    private readonly hardTimeoutMs: number,
    private readonly onHardTimeout?: () => void,
  ) {}

  async start(
    child: ChildProcessWithoutNullStreams,
    options: { yieldTimeMs?: number; maxOutputTokens?: number },
  ): Promise<SandboxExecResult> {
    const sessionId = randomUUID();
    const startedAt = Date.now();
    const chunks: string[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => chunks.push(chunk.toString("utf8")));

    let complete: () => void = () => undefined;
    const done = new Promise<void>((resolveDone) => {
      complete = resolveDone;
    });
    const running: RunningProcess = {
      child,
      startedAt,
      chunks,
      cursor: 0,
      done,
      killTimer: setTimeout(() => {
        this.killProcess(child);
        this.onHardTimeout?.();
      }, this.hardTimeoutMs),
    };
    child.once("error", (error) => {
      chunks.push(`\nprocess error: ${error.message}\n`);
      running.exitCode = 1;
      complete();
    });
    child.once("exit", (code, signal) => {
      running.exitCode = code ?? (signal ? 128 : 1);
      if (signal) chunks.push(`\nprocess terminated by ${signal}\n`);
      clearTimeout(running.killTimer);
      complete();
    });
    this.processes.set(sessionId, running);
    await Promise.race([done, wait(options.yieldTimeMs ?? 10_000)]);
    return this.collect(sessionId, options.maxOutputTokens ?? 10_000);
  }

  async continue(request: SandboxContinueRequest): Promise<SandboxExecResult> {
    const running = this.processes.get(request.sessionId);
    if (!running) {
      throw new Error(`Unknown or completed sandbox session: ${request.sessionId}`);
    }
    if (request.chars) running.child.stdin.write(request.chars);
    await Promise.race([running.done, wait(request.yieldTimeMs ?? 5_000)]);
    return this.collect(request.sessionId, request.maxOutputTokens ?? 10_000);
  }

  dispose(): void {
    for (const running of this.processes.values()) {
      clearTimeout(running.killTimer);
      this.killProcess(running.child);
    }
    this.processes.clear();
  }

  private collect(sessionId: string, maxTokens: number): SandboxExecResult {
    const running = this.processes.get(sessionId);
    if (!running) throw new Error(`Unknown sandbox session: ${sessionId}`);
    const joined = running.chunks.join("");
    const recent = joined.slice(running.cursor);
    running.cursor = joined.length;
    const truncated = truncateOutput(recent, maxTokens);
    const result: SandboxExecResult = {
      wallTimeSeconds: (Date.now() - running.startedAt) / 1000,
      output: truncated.output,
      ...(truncated.originalTokenCount
        ? { originalTokenCount: truncated.originalTokenCount }
        : {}),
    };
    if (running.exitCode === undefined) {
      result.sessionId = sessionId;
    } else {
      result.exitCode = running.exitCode;
      this.processes.delete(sessionId);
    }
    return result;
  }

  private killProcess(child: ChildProcessWithoutNullStreams): void {
    if (!child.pid) return;
    try {
      if (process.platform === "win32") child.kill("SIGKILL");
      else process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }
}
