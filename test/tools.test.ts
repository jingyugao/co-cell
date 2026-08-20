import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createRequestUserInputTool,
  type RequestUserInput,
} from "../src/tools/request-user-input.js";
import { createViewImageTool } from "../src/tools/view-image.js";

describe("request_user_input", () => {
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
});

describe("view_image", () => {
  it("returns an OpenAI input_image block and enforces workspace boundaries", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "agent-staff-image-"));
    const outside = await mkdtemp(join(tmpdir(), "agent-staff-outside-"));
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
