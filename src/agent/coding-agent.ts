import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import type { StructuredToolInterface } from "@langchain/core/tools";
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import { Command } from "@langchain/langgraph";
import {
  createAgent,
  createMiddleware,
  modelRetryMiddleware,
  summarizationMiddleware,
  todoListMiddleware,
  type Todo,
} from "langchain";

import { createCodexModel } from "../model/chat-codex.js";
import { createOpenAICompatibleModel } from "../model/chat-openai-compatible.js";
import type { Sandbox } from "../sandbox/types.js";
import { findGitLabMergeRequestUrl } from "../integrations/gitlab.js";
import { BashProcessManager, createBashTool } from "../tools/bash.js";
import { createViewImageTool } from "../tools/view-image.js";
import {
  resolveContextCompressionConfig,
  type ContextCompressionConfig,
} from "./context-compression.js";

/**
 * Harness behavior adapted from OpenAI Codex's default base instructions:
 * codex-rs/protocol/src/prompts/base_instructions/default.md.
 *
 * Planning instructions are intentionally absent: LangChain's
 * todoListMiddleware injects its canonical write_todos prompt.
 */
export const CODEX_DERIVED_HARNESS_INSTRUCTIONS = `
You are a coding agent working inside a pre-scoped sandbox. Be precise, safe,
helpful, concise, and direct.

AGENTS.md:
- Discover and obey every AGENTS.md whose directory scope includes a file you
  inspect or modify. More deeply nested files take precedence.
- Direct system, developer, and user instructions take precedence over AGENTS.md.

Communication:
- Before tool calls, briefly state the immediate work you are about to do.
- For long tasks, provide concise progress updates at meaningful milestones.
- State assumptions, prerequisites, blockers, and changes of approach explicitly.

Task execution:
- Continue until the requested outcome is genuinely complete; do not stop after
  analysis when implementation was requested.
- Inspect requirements, tests, repository context, and relevant environments before
  editing. Do not guess when evidence can be gathered with the available tools.
- Use rg or rg --files for search when available.
- Use bash for command-line work and always set workdir. Prefer apply_patch for
  precise edits; it is available on PATH in the sandbox.
- Fix root causes when practical. Keep changes minimal, focused, and consistent
  with the existing codebase. Do not fix unrelated defects.
- Preserve unrelated user changes. Do not reset, overwrite, delete, commit, create
  branches, or push unless the user explicitly requests that action.
- Use view_image when visual inspection of a local image is material.
- When external decisions are needed, finish all independent work, record the
  reviewed questions in the project, publish them through the project workflow,
  and complete the current run instead of waiting inside the model call.

Validation:
- Validate from the narrowest relevant checks outward: targeted tests first, then
  broader tests, lint, formatting, or builds when proportionate.
- Do not add a formatter or test framework to a repository that does not have one.
- Inspect the final diff when the workspace is a Git repository.
- Never claim a check passed unless its result was observed.

Escalation and completion:
- If the same failure repeats three times without new evidence, stop retrying and
  request leader input with the attempts, evidence, and exact decision needed.
- The final response must state the outcome, changed files, validation and results,
  untested cases, risks, and the exact blocker when incomplete.
`.trim();

/**
 * LangGraph requires a positive recursion limit even when the application does
 * not want to impose a workflow-depth limit. This value is effectively
 * unbounded for a real Agent Run while preserving the framework contract.
 */
export const EFFECTIVELY_UNBOUNDED_RECURSION_LIMIT = Number.MAX_SAFE_INTEGER;

export const CODING_CONTEXT_SUMMARY_PROMPT = `
Summarize the coding Agent conversation for continued autonomous execution.
Preserve concrete requirements, user decisions, unresolved questions, repository
and branch state, changed files, commands and validation results, external artifact
URLs, workflow reports, confirmation keys and answers, errors already investigated,
and the exact next action. Distinguish verified facts from assumptions. Omit verbose
tool output, repeated progress narration, help text, and failed attempts once their
cause is known. Never invent completion, validation, permissions, or external state.
The summary will replace the older messages, so make it concise but operationally
complete. Respond only with the summary.

<messages>
{messages}
</messages>
`.trim();

type SummarizationModel = Parameters<typeof summarizationMiddleware>[0]["model"];

/** Build durable compaction that replaces old state with a summary plus recent context. */
export function createCodingContextCompressionMiddleware(
  model: SummarizationModel,
  overrides: Partial<ContextCompressionConfig> = {},
) {
  const config = resolveContextCompressionConfig(overrides);
  return summarizationMiddleware({
    model,
    trigger: [
      { tokens: config.triggerTokens },
      { messages: config.triggerMessages },
    ],
    keep: { tokens: config.keepTokens },
    trimTokensToSummarize: config.summaryInputTokens,
    summaryPrompt: CODING_CONTEXT_SUMMARY_PROMPT,
    summaryPrefix: "以下是此前研发对话的自动压缩摘要：",
  });
}

export function buildCodingAgentInstructions(
  additionalInstructions: readonly string[] = [],
): string {
  return [CODEX_DERIVED_HARNESS_INSTRUCTIONS, ...additionalInstructions]
    .map((instructions) => instructions.trim())
    .filter(Boolean)
    .join("\n\n");
}

export const CODING_AGENT_INSTRUCTIONS = buildCodingAgentInstructions();

const RETRYABLE_MODEL_CODES = new Set([
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "ENETUNREACH",
  "ETIMEDOUT",
  "server_is_overloaded",
]);

const RETRYABLE_MODEL_TYPES = new Set([
  "service_unavailable_error",
  "timeout_error",
]);

/** Return true only for model failures that can reasonably recover after waiting. */
export function isTransientModelError(error: Error): boolean {
  const visited = new Set<object>();
  let current: unknown = error;

  for (let depth = 0; depth < 8 && current; depth += 1) {
    if (typeof current !== "object") return false;
    if (visited.has(current)) return false;
    visited.add(current);

    const value = current as {
      status?: unknown;
      code?: unknown;
      type?: unknown;
      name?: unknown;
      message?: unknown;
      cause?: unknown;
      error?: unknown;
    };
    const status = typeof value.status === "number" ? value.status : undefined;
    const code = typeof value.code === "string" ? value.code : undefined;
    const type = typeof value.type === "string" ? value.type : undefined;
    const name = typeof value.name === "string" ? value.name : undefined;
    const message = typeof value.message === "string" ? value.message : "";

    if (
      status === 408 ||
      status === 409 ||
      status === 429 ||
      (status !== undefined && status >= 500) ||
      (code !== undefined && RETRYABLE_MODEL_CODES.has(code)) ||
      (type !== undefined && RETRYABLE_MODEL_TYPES.has(type)) ||
      name === "APIConnectionError" ||
      /server(?:s are)? currently overloaded|connection error|fetch failed/i.test(
        message,
      )
    ) {
      return true;
    }

    current = value.cause ?? value.error;
  }

  return false;
}

/** A coding run must inspect its workspace before it can legitimately finish. */
export function shouldRequireInitialToolCall(messages: readonly unknown[]): boolean {
  return !messages.some(
    (message) => message instanceof ToolMessage || ToolMessage.isInstance(message),
  );
}

export const requireInitialToolCallMiddleware = createMiddleware({
  name: "requireInitialToolCallMiddleware",
  wrapModelCall: async (request, handler) =>
    handler(
      shouldRequireInitialToolCall(request.messages)
        ? { ...request, toolChoice: "required" }
        : request,
    ),
});

export interface CodingTask {
  workspace: string;
  /** New user input. Omit only when resuming an interrupted/failed checkpoint. */
  prompt?: string;
  /** Optional input used only when resuming a legacy interrupted checkpoint. */
  resume?: { message: string } | true;
  /** Optional externally managed execution sandbox. Defaults to local execution. */
  sandbox?: Sandbox;
  model?: string;
  recursionLimit?: number;
  /** Stable conversation identifier required when checkpointing is enabled. */
  threadId?: string;
  /** Identifier for this activation of the long-lived thread. */
  runId?: string;
  /** Durable LangGraph state saver, normally backed by PostgreSQL. */
  checkpointer?: BaseCheckpointSaver;
  /** Fail the run unless the final response contains a GitLab MR URL. */
  requireMergeRequest?: boolean;
  /** Host- or deployment-specific developer instructions appended after the base. */
  additionalInstructions?: readonly string[];
  /** Automatic durable context summarization bounds. */
  contextCompression?: Partial<ContextCompressionConfig>;
  /** Project-scoped durable workflow tools supplied by the control plane. */
  workflowTools?: readonly StructuredToolInterface[];
  /** Enable general shell execution. Coordinators should use project tools instead. */
  enableShell?: boolean;
  /** Durable external events checked before every model call. */
  externalEvents?: {
    claim(): Promise<Array<{ id: string; content: string }>>;
    complete(ids: string[]): Promise<void>;
    fail(ids: string[], error: string): Promise<void>;
  };
  openAICompatible?: {
    apiKey: string;
    baseURL: string;
  };
  /** Stops model execution while the sandbox is being terminated. */
  signal?: AbortSignal;
}

export interface CodingTaskResult {
  finalResponse: string;
  messages: unknown[];
  todos: Todo[];
  mergeRequestUrl?: string;
  processedExternalEventIds: string[];
}

export function renderMessageContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const text = content
      .map((block) => {
        if (
          typeof block === "object" &&
          block !== null &&
          "text" in block &&
          typeof block.text === "string"
        ) {
          return block.text;
        }
        return "";
      })
      .join("");
    if (text) return text;
  }
  return JSON.stringify(content);
}

export async function runCodingTask(task: CodingTask): Promise<CodingTaskResult> {
  if (!task.resume && !task.prompt?.trim()) {
    throw new Error("prompt is required unless resuming a checkpoint");
  }
  if (task.resume && (!task.checkpointer || !task.threadId?.trim())) {
    throw new Error("checkpointing and threadId are required to resume");
  }
  if (task.checkpointer && !task.threadId?.trim()) {
    throw new Error("threadId is required when checkpointing is enabled");
  }
  const shellEnabled = task.enableShell !== false;
  const localManager = shellEnabled && !task.sandbox
    ? await BashProcessManager.create({ workspace: task.workspace })
    : undefined;
  const executor = shellEnabled ? task.sandbox ?? localManager : undefined;
  const claimedExternalEventIds = new Set<string>();
  try {
    const instructions = buildCodingAgentInstructions(task.additionalInstructions);
    const model = task.openAICompatible
      ? createOpenAICompatibleModel({
          ...task.openAICompatible,
          model: task.model ?? "gpt-5.6-luna",
          instructions,
        })
      : await createCodexModel({ model: task.model, instructions });
    const viewImage = await createViewImageTool({ workspace: task.workspace });
    const externalEventMiddleware = task.externalEvents
      ? createMiddleware({
          name: "externalEventMiddleware",
          beforeModel: async () => {
            const events = await task.externalEvents!.claim();
            if (events.length === 0) return undefined;
            events.forEach((event) => claimedExternalEventIds.add(event.id));
            return {
              messages: events.map((event) => new HumanMessage({
                id: `external-event:${event.id}`,
                content: event.content,
              })),
            };
          },
        })
      : undefined;
    const agent = createAgent({
      name: "coding-agent",
      model,
      tools: [
        ...(executor ? [createBashTool(executor)] : []),
        viewImage,
        ...(task.workflowTools ?? []),
      ],
      middleware: [
        requireInitialToolCallMiddleware,
        ...(externalEventMiddleware ? [externalEventMiddleware] : []),
        createCodingContextCompressionMiddleware(model, task.contextCompression),
        modelRetryMiddleware({
          maxRetries: 5,
          initialDelayMs: 2_000,
          backoffFactor: 2,
          maxDelayMs: 30_000,
          jitter: true,
          retryOn: isTransientModelError,
          onFailure: "error",
        }),
        todoListMiddleware(),
      ],
      checkpointer: task.checkpointer,
    });
    const threadId = task.threadId?.trim();
    let result;
    try {
      result = await agent.invoke(
        task.resume
          ? new Command({ resume: task.resume })
          : { messages: [new HumanMessage(task.prompt!)] },
        {
          recursionLimit:
            task.recursionLimit ?? EFFECTIVELY_UNBOUNDED_RECURSION_LIMIT,
          ...(task.signal ? { signal: task.signal } : {}),
          ...(threadId
            ? {
                configurable: {
                  thread_id: threadId,
                  ...(task.runId ? { run_id: task.runId } : {}),
                },
                durability: "sync" as const,
              }
            : {}),
          ...(task.runId || threadId
            ? {
                metadata: {
                  ...(task.runId ? { run_id: task.runId } : {}),
                  ...(threadId ? { thread_id: threadId } : {}),
                },
              }
            : {}),
        },
      );
      await task.externalEvents?.complete([...claimedExternalEventIds]);
    } catch (error) {
      await task.externalEvents?.fail(
        [...claimedExternalEventIds],
        error instanceof Error ? error.message : String(error),
      ).catch(() => undefined);
      throw error;
    }
    const messages = result.messages ?? [];
    const todos = (result as unknown as { todos?: Todo[] }).todos ?? [];
    const finalMessage = [...messages]
      .reverse()
      .find((message): message is AIMessage => message instanceof AIMessage);
    const finalResponse = finalMessage
      ? renderMessageContent(finalMessage.content)
      : "Agent finished without a final AI message.";
    const mergeRequest = findGitLabMergeRequestUrl(finalResponse);
    if (task.requireMergeRequest && !mergeRequest) {
      throw new Error(
        "GitLab delivery incomplete: final response does not contain a merge request URL",
      );
    }
    return {
      finalResponse,
      messages,
      todos,
      processedExternalEventIds: [...claimedExternalEventIds],
      ...(mergeRequest ? { mergeRequestUrl: mergeRequest.url } : {}),
    };
  } finally {
    await localManager?.dispose();
  }
}
