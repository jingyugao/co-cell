import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AIMessage } from "@langchain/core/messages";
import { MemorySaver, StateGraph, MessagesAnnotation, isInterrupted, interrupt } from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { describe, expect, it } from "vitest";

import {
  createRequestUserInputTool,
  parseRequestUserInput,
  renderRequestUserInput,
  type RequestUserInput,
} from "../src/tools/request-user-input.js";
import { createViewImageTool } from "../src/tools/view-image.js";

describe("request_user_input", () => {
  it("validates and renders a durable human-readable gate message", () => {
    const request = parseRequestUserInput({
      questions: [{
        id: "scope",
        header: "范围",
        question: "选择本次实现范围？",
        options: [
          { label: "Small (Recommended)", description: "Only required work." },
          { label: "Large", description: "Also refactor related code." },
        ],
      }],
    });

    expect(request).toBeDefined();
    expect(renderRequestUserInput(request!)).toContain("[范围] 选择本次实现范围？");
    expect(renderRequestUserInput(request!)).toContain("- Small (Recommended)：Only required work.");
  });

  it("passes structured questions to the UI handler", async () => {
    let received: RequestUserInput | undefined;
    const request = createRequestUserInputTool(async (input) => {
      received = input;
      return { answers: { scope: { answers: ["Small (Recommended)"] } } };
    });
    const result = await request.invoke({
      questions: [
        {
          id: "scope",
          header: "范围",
          question: "选择本次实现范围？",
          options: [
            { label: "Small (Recommended)", description: "Only required work." },
            { label: "Large", description: "Also refactor related code." },
          ],
        },
      ],
    });
    expect(received?.questions[0]?.id).toBe("scope");
    expect(JSON.parse(result)).toEqual({
      answers: { scope: { answers: ["Small (Recommended)"] } },
    });
  });

  it("pauses the graph instead of converting leader input into a tool error", async () => {
    const request = createRequestUserInputTool(async (input) => interrupt(input));
    const graph = new StateGraph(MessagesAnnotation)
      .addNode("tools", new ToolNode([request]))
      .addEdge("__start__", "tools")
      .addEdge("tools", "__end__")
      .compile({ checkpointer: new MemorySaver() });
    const question = {
      questions: [{
        id: "repository",
        header: "代码仓库",
        question: "请提供目标仓库路径。",
        options: [
          { label: "提供路径 (Recommended)", description: "按明确仓库继续。" },
          { label: "补充线索", description: "提供服务名称后再定位。" },
        ],
      }],
    };
    const result = await graph.invoke(
      {
        messages: [new AIMessage({
          content: "缺少仓库信息，需要负责人确认。",
          tool_calls: [{
            id: "request-1",
            name: "request_user_input",
            args: question,
            type: "tool_call",
          }],
        })],
      },
      { configurable: { thread_id: "missing-repository" } },
    );

    expect(isInterrupted(result)).toBe(true);
    if (!isInterrupted(result)) throw new Error("Expected an interrupted graph");
    expect(result.__interrupt__[0]?.value).toEqual(question);
    expect(result.messages.some((message) =>
      message.type === "tool" && String(message.content).includes("Please fix your mistakes")
    )).toBe(false);
  });
});

describe("view_image", () => {
  it("returns an OpenAI input_image block and enforces workspace boundaries", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "swarm-hive-image-"));
    const outside = await mkdtemp(join(tmpdir(), "swarm-hive-outside-"));
    try {
      const png = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        "base64",
      );
      await writeFile(join(workspace, "pixel.png"), png);
      await writeFile(join(outside, "outside.png"), png);
      const viewImage = await createViewImageTool({ workspace });
      const result = await viewImage.invoke({
        type: "tool_call",
        id: "view-image-call",
        name: "view_image",
        args: { path: "pixel.png", detail: "original" },
      });
      expect(result.content).toEqual([
        expect.objectContaining({
          type: "input_image",
          detail: "original",
          image_url: expect.stringMatching(/^data:image\/png;base64,/),
        }),
      ]);
      expect(result.tool_call_id).toBe("view-image-call");
      await expect(viewImage.invoke({ path: join(outside, "outside.png") })).rejects.toThrow(
        "outside sandbox workspace",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});
