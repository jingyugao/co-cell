import { AIMessage, HumanMessage, RemoveMessage, ToolMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";

import {
  CODEX_DERIVED_HARNESS_INSTRUCTIONS,
  CODING_AGENT_INSTRUCTIONS,
  CODING_CONTEXT_SUMMARY_PROMPT,
  EFFECTIVELY_UNBOUNDED_RECURSION_LIMIT,
  buildCodingAgentInstructions,
  createCodingContextCompressionMiddleware,
  isTransientModelError,
  renderMessageContent,
  shouldRequireInitialToolCall,
} from "../src/agent/coding-agent.js";
import {
  CONVERSATION_SUMMARY_KEEP_TOKENS,
  CONVERSATION_SUMMARY_TRIGGER_MESSAGES,
  CONVERSATION_SUMMARY_TRIGGER_TOKENS,
  loadContextCompressionConfig,
  resolveContextCompressionConfig,
} from "../src/agent/context-compression.js";

describe("coding agent instructions", () => {
  it("uses only the generic Codex-derived harness instructions by default", () => {
    expect(CODING_AGENT_INSTRUCTIONS).toBe(CODEX_DERIVED_HARNESS_INSTRUCTIONS);
    expect(CODING_AGENT_INSTRUCTIONS).not.toContain("Organization policy");
  });

  it("appends non-empty host instructions after the generic base", () => {
    expect(buildCodingAgentInstructions(["  host policy  ", "  "])).toBe(
      `${CODEX_DERIVED_HARNESS_INSTRUCTIONS}\n\nhost policy`,
    );
  });
});

describe("coding agent context bounds", () => {
  it("uses durable automatic summarization before history becomes unbounded", () => {
    expect(CONVERSATION_SUMMARY_TRIGGER_TOKENS).toBe(40_000);
    expect(CONVERSATION_SUMMARY_TRIGGER_MESSAGES).toBe(60);
    expect(CONVERSATION_SUMMARY_KEEP_TOKENS).toBe(12_000);
    expect(CODING_CONTEXT_SUMMARY_PROMPT).toContain("unresolved questions");
    expect(CODING_CONTEXT_SUMMARY_PROMPT).toContain("validation results");
  });

  it("loads and validates deployment-specific compression bounds", () => {
    expect(loadContextCompressionConfig({
      AGENT_CONTEXT_COMPRESSION_TRIGGER_TOKENS: "20000",
    })).toMatchObject({
      triggerTokens: 20_000,
      keepTokens: 6_000,
      summaryInputTokens: 20_000,
    });
    expect(() => resolveContextCompressionConfig({
      triggerTokens: 10_000,
      keepTokens: 10_000,
    })).toThrow("keepTokens must be smaller than triggerTokens");
  });

  it("replaces old messages with a summary while preserving recent context", async () => {
    const summaryPrompts: string[] = [];
    const middleware = createCodingContextCompressionMiddleware({
      invoke: async (prompt: unknown) => {
        summaryPrompts.push(String(prompt));
        return new AIMessage("需求与已验证状态的摘要");
      },
    } as never, {
      triggerTokens: 10,
      triggerMessages: 99,
      keepTokens: 8,
      summaryInputTokens: 20,
    });
    const beforeModel = middleware.beforeModel;
    expect(typeof beforeModel).toBe("function");
    if (typeof beforeModel !== "function") throw new Error("beforeModel hook is missing");
    const result = await beforeModel(
      {
        messages: [1, 2, 3, 4, 5, 6].map((index) => new HumanMessage({
          id: `message-${index}`,
          content: `message ${index} with enough content`,
        })),
      } as never,
      { context: {} } as never,
    );
    const messages = (result as { messages: Array<HumanMessage | RemoveMessage> }).messages;

    expect(summaryPrompts).toHaveLength(1);
    expect(messages[0]).toBeInstanceOf(RemoveMessage);
    expect(messages[1]?.content).toContain("自动压缩摘要");
    expect(messages[1]?.content).toContain("需求与已验证状态的摘要");
    expect(messages.at(-1)?.id).toBe("message-6");
  });

  it("does not impose the former 200-step workflow limit", () => {
    expect(EFFECTIVELY_UNBOUNDED_RECURSION_LIMIT).toBe(Number.MAX_SAFE_INTEGER);
    expect(EFFECTIVELY_UNBOUNDED_RECURSION_LIMIT).toBeGreaterThan(200);
  });
});

describe("agent response rendering", () => {
  it("renders Responses API text blocks as plain text", () => {
    expect(
      renderMessageContent([
        { type: "text", text: "first" },
        { type: "text", text: " second" },
      ]),
    ).toBe("first second");
  });
});

describe("isTransientModelError", () => {
  it.each([408, 409, 429, 500, 503])("retries HTTP %i", (status) => {
    const error = Object.assign(new Error("request failed"), { status });
    expect(isTransientModelError(error)).toBe(true);
  });

  it("finds NewAPI overload errors through wrapped causes", () => {
    const overloaded = Object.assign(new Error("upstream failed"), {
      code: "server_is_overloaded",
      type: "service_unavailable_error",
    });
    const wrapped = Object.assign(new Error("middleware failed"), {
      cause: overloaded,
    });

    expect(isTransientModelError(wrapped)).toBe(true);
  });

  it.each([400, 401, 403, 404])("does not retry HTTP %i", (status) => {
    const error = Object.assign(new Error("request failed"), { status });
    expect(isTransientModelError(error)).toBe(false);
  });

  it("does not retry deterministic context errors", () => {
    expect(isTransientModelError(new Error("context_length_exceeded"))).toBe(false);
  });
});

describe("shouldRequireInitialToolCall", () => {
  it("requires a tool before a coding run can finish", () => {
    expect(shouldRequireInitialToolCall([new HumanMessage("implement this")])).toBe(true);
  });

  it("restores automatic tool choice after a tool has executed", () => {
    expect(
      shouldRequireInitialToolCall([
        new HumanMessage("implement this"),
        new ToolMessage({ content: "ok", tool_call_id: "call-1" }),
      ]),
    ).toBe(false);
  });
});
