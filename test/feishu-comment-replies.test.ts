import { describe, expect, test, vi } from "vitest";

import { FeishuCommentReplyAdapter } from "../src/integrations/feishu-comment-replies.js";

describe("Feishu comment replies", () => {
  test("replies to the original comment as the SwarmHive bot", async () => {
    const reply = vi.fn(async () => ({ providerReplyId: "provider-reply-id" }));
    const adapter = new FeishuCommentReplyAdapter({
      appId: "app-id",
      appSecret: "app-secret",
      writer: { reply },
    });
    const context = {
      inboxEventId: "event-id",
      projectId: "project-id",
      source: "feishu",
      eventType: "technical_design_comment_received",
      payload: {
        file_token: "document-token",
        file_type: "docx",
        comment_id: "comment-id",
      },
    };

    expect(adapter.supports(context)).toBe(true);
    await expect(adapter.reply(context, "已收到，可以开始开发。")).resolves.toEqual({
      providerReplyId: "provider-reply-id",
    });
    expect(reply).toHaveBeenCalledWith({
      fileToken: "document-token",
      fileType: "docx",
      commentId: "comment-id",
      content: "[SwarmHive Agent]\n已收到，可以开始开发。",
    });
  });

  test("does not claim unsupported event shapes", () => {
    const adapter = new FeishuCommentReplyAdapter({
      appId: "app-id",
      appSecret: "app-secret",
      writer: { reply: vi.fn() },
    });
    expect(adapter.supports({
      inboxEventId: "event-id",
      projectId: "project-id",
      source: "feishu",
      eventType: "confirmation_answer_received",
      payload: {},
    })).toBe(false);
  });
});
