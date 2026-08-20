import { describe, expect, test } from "vitest";

import { oauthInternalsForTest } from "../src/auth/codex-oauth.js";

function jwt(payload: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.sig`;
}

describe("OAuth token parsing", () => {
  test("extracts the ChatGPT account id", () => {
    const idToken = jwt({
      sub: "user-1",
      "https://api.openai.com/auth": {
        chatgpt_account_id: "account-1",
        chatgpt_plan_type: "team",
      },
    });

    const token = oauthInternalsForTest.tokenFromResponse({
      access_token: "access",
      refresh_token: "refresh",
      expires_in: 3600,
      id_token: idToken,
    });

    expect(token.account_id).toBe("account-1");
    expect(token.plan_type).toBe("team");
    expect(token.user_id).toBe("user-1");
  });
});
