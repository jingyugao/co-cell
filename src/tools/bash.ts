import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { delimiter, isAbsolute, relative, resolve } from "node:path";

import { tool } from "langchain";
import { z } from "zod";

import type { Sandbox } from "../sandbox/types.js";
import { redactSensitiveText } from "../security/redact.js";

export interface BashResult {
  wall_time_seconds: number;
  output: string;
  exit_code?: number;
  session_id?: string;
  original_token_count?: number;
}

interface RunningProcess {
  child: ChildProcess;
  startedAt: number;
  chunks: string[];
  cursor: number;
  exitCode?: number;
  done: Promise<void>;
  killTimer: NodeJS.Timeout;
}

const BashInputSchema = z
  .object({
    cmd: z
      .string()
      .optional()
      .describe("Shell command to execute. Omit when polling a session."),
    workdir: z
      .string()
      .optional()
      .describe(
        "Working directory inside the assigned workspace. Relative paths are resolved " +
        "from the workspace root; defaults to the workspace root.",
      ),
    session_id: z
      .string()
      .optional()
      .describe("Running session identifier returned by an earlier call."),
    chars: z
      .string()
      .optional()
      .describe("Characters to write to a running session. Empty polls it."),
    yield_time_ms: z
      .number()
      .int()
      .min(250)
      .max(30_000)
      .optional()
      .describe("Wait before yielding output. Defaults to 10000 ms."),
    max_output_tokens: z
      .number()
      .int()
      .min(100)
      .max(50_000)
      .optional()
      .describe("Approximate output token budget. Defaults to 10000."),
    login: z
      .boolean()
      .optional()
      .describe("Use login-shell semantics. Defaults to false."),
  })
  .refine((input) => Boolean(input.cmd) !== Boolean(input.session_id), {
    message: "Provide exactly one of cmd or session_id",
  });

export type BashInput = z.infer<typeof BashInputSchema>;

function wait(milliseconds: number): Promise<void> {
  return new Promise((done) => setTimeout(done, milliseconds));
}

function approximateTokens(value: string): number {
  return Math.ceil(value.length / 4);
}

function truncateOutput(value: string, maxTokens: number): {
  output: string;
  originalTokenCount?: number;
} {
  const originalTokenCount = approximateTokens(value);
  if (originalTokenCount <= maxTokens) return { output: value };
  const maxCharacters = maxTokens * 4;
  const headLength = Math.floor(maxCharacters * 0.2);
  const tailLength = maxCharacters - headLength;
  return {
    output: `${value.slice(0, headLength)}\n\n[... output truncated ...]\n\n${value.slice(-tailLength)}`,
    originalTokenCount,
  };
}

function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

export class BashProcessManager {
  private readonly processes = new Map<string, RunningProcess>();
  private readonly workspace: string;
  private readonly shell: string;
  private readonly hardTimeoutMs: number;
  private readonly extraPath: string;

  private constructor(options: {
    workspace: string;
    shell: string;
    hardTimeoutMs: number;
    extraPath: string;
  }) {
    this.workspace = options.workspace;
    this.shell = options.shell;
    this.hardTimeoutMs = options.hardTimeoutMs;
    this.extraPath = options.extraPath;
  }

  static async create(options: {
    workspace: string;
    shell?: string;
    hardTimeoutMs?: number;
    extraPath?: string;
  }): Promise<BashProcessManager> {
    return new BashProcessManager({
      workspace: await realpath(resolve(options.workspace)),
      shell: options.shell ?? process.env.SHELL ?? "/bin/bash",
      hardTimeoutMs: options.hardTimeoutMs ?? 30 * 60 * 1000,
      extraPath: options.extraPath ?? resolve(process.cwd(), "bin"),
    });
  }

  async execute(input: BashInput): Promise<BashResult> {
    if (input.session_id) return this.continue(input);
    return this.start(input);
  }

  async dispose(): Promise<void> {
    for (const process of this.processes.values()) this.kill(process);
    this.processes.clear();
  }

  private async resolveWorkdir(workdir?: string): Promise<string> {
    const candidate = resolve(this.workspace, workdir ?? ".");
    const canonical = await realpath(candidate);
    if (!isWithin(this.workspace, canonical)) {
      throw new Error(`workdir is outside sandbox workspace: ${workdir}`);
    }
    return canonical;
  }

  private async start(input: BashInput): Promise<BashResult> {
    const command = input.cmd;
    if (!command) throw new Error("cmd is required");
    const cwd = await this.resolveWorkdir(input.workdir);
    const startedAt = Date.now();
    const shellArguments = input.login ? ["-lc", command] : ["-c", command];
    const child = spawn(this.shell, shellArguments, {
      cwd,
      detached: process.platform !== "win32",
      env: {
        ...process.env,
        PATH: `${this.extraPath}${delimiter}${process.env.PATH ?? ""}`,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const sessionId = randomUUID();
    const chunks: string[] = [];
    child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk.toString("utf8")));
    child.stderr?.on("data", (chunk: Buffer) => chunks.push(chunk.toString("utf8")));

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
      killTimer: setTimeout(() => this.kill(running), this.hardTimeoutMs),
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
    await Promise.race([done, wait(input.yield_time_ms ?? 10_000)]);
    return this.collect(sessionId, input.max_output_tokens ?? 10_000);
  }

  private async continue(input: BashInput): Promise<BashResult> {
    const sessionId = input.session_id;
    if (!sessionId) throw new Error("session_id is required");
    const running = this.processes.get(sessionId);
    if (!running) throw new Error(`Unknown or completed bash session: ${sessionId}`);
    if (input.chars) running.child.stdin?.write(input.chars);
    await Promise.race([running.done, wait(input.yield_time_ms ?? 5_000)]);
    return this.collect(sessionId, input.max_output_tokens ?? 10_000);
  }

  private collect(sessionId: string, maxTokens: number): BashResult {
    const running = this.processes.get(sessionId);
    if (!running) throw new Error(`Unknown bash session: ${sessionId}`);
    const joined = running.chunks.join("");
    const recent = joined.slice(running.cursor);
    running.cursor = joined.length;
    const truncated = truncateOutput(recent, maxTokens);
    const result: BashResult = {
      wall_time_seconds: (Date.now() - running.startedAt) / 1000,
      output: truncated.output,
      ...(truncated.originalTokenCount
        ? { original_token_count: truncated.originalTokenCount }
        : {}),
    };
    if (running.exitCode === undefined) {
      result.session_id = sessionId;
    } else {
      result.exit_code = running.exitCode;
      this.processes.delete(sessionId);
    }
    return result;
  }

  private kill(running: RunningProcess): void {
    clearTimeout(running.killTimer);
    const pid = running.child.pid;
    if (!pid) return;
    try {
      if (process.platform === "win32") running.child.kill("SIGKILL");
      else process.kill(-pid, "SIGKILL");
    } catch {
      running.child.kill("SIGKILL");
    }
  }
}

export function createBashTool(executor: BashProcessManager | Sandbox) {
  return tool(
    async (input: BashInput) => {
      if (executor instanceof BashProcessManager) {
        const result = await executor.execute(input);
        return JSON.stringify({ ...result, output: redactSensitiveText(result.output) });
      }
      const result = input.session_id
        ? await executor.continue({
            sessionId: input.session_id,
            chars: input.chars,
            yieldTimeMs: input.yield_time_ms,
            maxOutputTokens: input.max_output_tokens,
          })
        : await executor.exec({
            command: input.cmd ?? "",
            cwd: input.workdir,
            login: input.login,
            yieldTimeMs: input.yield_time_ms,
            maxOutputTokens: input.max_output_tokens,
          });
      return JSON.stringify({
        wall_time_seconds: result.wallTimeSeconds,
        output: redactSensitiveText(result.output),
        ...(result.exitCode === undefined ? {} : { exit_code: result.exitCode }),
        ...(result.sessionId ? { session_id: result.sessionId } : {}),
        ...(result.originalTokenCount
          ? { original_token_count: result.originalTokenCount }
          : {}),
      } satisfies BashResult);
    },
    {
      name: "bash",
      description:
        "Run a command in the sandbox workspace or continue a running command. " +
        "Use ordinary CLI tools for file reads, searches, edits, Git, tests, " +
        "Kubernetes, databases, and internal development systems.",
      schema: BashInputSchema,
    },
  );
}
