import { describe, expect, test } from "vitest";

import { redactSensitiveText } from "../src/security/redact.js";

describe("sensitive output redaction", () => {
  test("redacts environment, JSON and authorization secrets", () => {
    const output = [
      "GITLAB_TOKEN=private-value",
      "escaped\\nGITLAB_TOKEN=escaped-private-value\\nnext",
      'payload={"api_key":"another-value"}',
      "Authorization: Bearer bearer-value",
      "GITLAB_BASE_URL=https://gitlab.example.test",
    ].join("\n");

    const redacted = redactSensitiveText(output);
    expect(redacted).not.toContain("private-value");
    expect(redacted).not.toContain("escaped-private-value");
    expect(redacted).not.toContain("another-value");
    expect(redacted).not.toContain("bearer-value");
    expect(redacted).toContain("GITLAB_TOKEN=[REDACTED]");
    expect(redacted).toContain("GITLAB_BASE_URL=https://gitlab.example.test");
  });
});
