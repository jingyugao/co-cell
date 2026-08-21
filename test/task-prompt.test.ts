import { describe, expect, test } from "vitest";

import { renderAgentTaskPrompt } from "../src/specs/task-prompt.js";

describe("Agent task prompt", () => {
  test("renders every declared runtime variable", () => {
    expect(renderAgentTaskPrompt(
      "Role={{role}}\nURL={{source_url}}",
      { role: "backend", source_url: "https://example.test/requirement/1" },
    )).toBe("Role=backend\nURL=https://example.test/requirement/1");
  });

  test("rejects missing and unused runtime variables", () => {
    expect(() => renderAgentTaskPrompt("{{role}} {{missing}}", { role: "backend" }))
      .toThrow("variable is missing: missing");
    expect(() => renderAgentTaskPrompt("{{role}}", { role: "backend", extra: "value" }))
      .toThrow("variables are unused: extra");
  });
});
