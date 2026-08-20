import { describe, expect, it } from "vitest";

import { normalizeOpenAIBaseUrl } from "../src/model/chat-openai-compatible.js";

describe("OpenAI-compatible model", () => {
  it("normalizes a server address to the v1 API root", () => {
    expect(normalizeOpenAIBaseUrl("http://example.test/")).toBe(
      "http://example.test/v1",
    );
    expect(normalizeOpenAIBaseUrl("https://example.test/v1")).toBe(
      "https://example.test/v1",
    );
  });

  it("rejects an address without an explicit protocol", () => {
    expect(() => normalizeOpenAIBaseUrl("example.test")).toThrow(
      "must start with http:// or https://",
    );
  });
});
