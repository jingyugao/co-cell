import { HumanMessage, ToolMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";

import {
  CODEX_DERIVED_HARNESS_INSTRUCTIONS,
  CODING_AGENT_INSTRUCTIONS,
  buildCodingAgentInstructions,
  isTransientModelError,
  renderMessageContent,
  shouldRequireInitialToolCall,
} from "../src/agent/coding-agent.js";

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
