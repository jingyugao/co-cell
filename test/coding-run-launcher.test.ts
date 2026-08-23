import { describe, expect, test } from "vitest";

import { buildFeishuProjectTaskPrompt } from "../src/application/coding-run-launcher.js";

describe("Coding Run task prompt", () => {
  test("appends only the Feishu Project URL to the static Agent prompt", () => {
    expect(
      buildFeishuProjectTaskPrompt(
        "static software engineer instructions",
        "https://project.feishu.cn/example/story/detail/123",
      ),
    ).toBe(
      "static software engineer instructions\n\n" +
      "当前任务：\n\n" +
      "- 飞书项目地址：https://project.feishu.cn/example/story/detail/123",
    );
  });
});
