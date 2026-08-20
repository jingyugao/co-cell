import { describe, expect, test, vi } from "vitest";

import {
  findGitLabMergeRequestUrl,
  verifyGitLabMergeRequest,
} from "../src/integrations/gitlab.js";

describe("GitLab merge request delivery", () => {
  test("extracts a merge request URL from the final response", () => {
    expect(
      findGitLabMergeRequestUrl(
        "完成：https://lab.example.com/group/project/-/merge_requests/42。",
        "https://lab.example.com",
      ),
    ).toEqual({
      url: "https://lab.example.com/group/project/-/merge_requests/42",
      projectPath: "group/project",
      iid: 42,
    });
  });

  test("does not accept an MR URL from another host", () => {
    expect(
      findGitLabMergeRequestUrl(
        "https://evil.example/group/project/-/merge_requests/1",
        "https://lab.example.com",
      ),
    ).toBeUndefined();
  });

  test("verifies the MR through the configured GitLab API", async () => {
    const fetchImplementation = vi.fn(async () =>
      new Response(
        JSON.stringify({
          state: "opened",
          title: "Implement feature",
          web_url: "https://lab.example.com/group/project/-/merge_requests/42",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    await expect(
      verifyGitLabMergeRequest({
        baseUrl: "https://lab.example.com",
        token: "test-token",
        mergeRequestUrl:
          "https://lab.example.com/group/project/-/merge_requests/42",
        fetchImplementation,
      }),
    ).resolves.toMatchObject({ iid: 42, state: "opened" });

    expect(fetchImplementation).toHaveBeenCalledWith(
      new URL(
        "https://lab.example.com/api/v4/projects/group%2Fproject/merge_requests/42",
      ),
      { headers: { "PRIVATE-TOKEN": "test-token" } },
    );
  });
});
