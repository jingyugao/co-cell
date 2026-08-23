import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { describe, expect, test } from "vitest";

import { serializeConversationMessages } from "../src/persistence/checkpoint-conversation-reader.js";

describe("checkpoint conversation reader", () => {
  test("serializes human, AI, tool calls and tool results in message order", () => {
    const messages = serializeConversationMessages([
      new HumanMessage({ id: "human-1", content: "实现需求" }),
      new AIMessage({
        id: "ai-1",
        content: "先检查代码",
        name: "coding-agent",
        tool_calls: [{ id: "call-1", name: "bash", args: { command: "git status" }, type: "tool_call" }],
      }),
      new ToolMessage({
        id: "tool-1",
        content: "working tree clean",
        name: "bash",
        tool_call_id: "call-1",
        status: "success",
      }),
    ]);

    expect(messages).toEqual([
      expect.objectContaining({ id: "human-1", role: "human", content: "实现需求" }),
      expect.objectContaining({
        id: "ai-1",
        role: "ai",
        content: "先检查代码",
        toolCalls: [{ id: "call-1", name: "bash", args: { command: "git status" } }],
      }),
      expect.objectContaining({
        id: "tool-1",
        role: "tool",
        name: "bash",
        content: "working tree clean",
        toolCallId: "call-1",
        status: "success",
      }),
    ]);
  });

  test("renders an empty request_user_input tool call as a visible confirmation message", () => {
    const messages = serializeConversationMessages([
      new AIMessage({
        id: "ai-gate",
        content: "",
        tool_calls: [{
          id: "request-1",
          name: "request_user_input",
          type: "tool_call",
          args: {
            questions: [{
              id: "delivery_scope",
              header: "交付范围",
              question: "本期是否只交付后端接口？",
              options: [
                { label: "仅后端 (Recommended)", description: "在当前仓库完成接口。" },
                { label: "包含页面", description: "需要补充前端仓库。" },
              ],
            }],
          },
        }],
      }),
    ]);

    expect(messages[0]).toMatchObject({
      role: "ai",
      content:
        "需要人工确认：\n\n" +
        "[交付范围] 本期是否只交付后端接口？\n" +
        "- 仅后端 (Recommended)：在当前仓库完成接口。\n" +
        "- 包含页面：需要补充前端仓库。",
    });
  });
});
