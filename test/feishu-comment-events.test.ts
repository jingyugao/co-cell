import { describe, expect, test, vi } from "vitest";

import {
  documentToken,
  FeishuCommentEventSubscriber,
} from "../src/integrations/feishu-comment-events.js";

function eventBus(overrides: Record<string, unknown> = {}) {
  return {
    recordExternalEvent: vi.fn().mockResolvedValue("external-event-record-id"),
    matchingSubscriptionCount: vi.fn().mockResolvedValue(1),
    publishExternalEvent: vi.fn().mockResolvedValue({
      externalEventId: "event-1",
      matchedSubscriptionCount: 2,
      deliveredProjectIds: ["project-1", "project-2"],
      duplicateProjectIds: [],
    }),
    ...overrides,
  };
}

describe("Feishu document comment events", () => {
  test("extracts a document token from a Feishu URL", () => {
    expect(documentToken("https://example.feishu.cn/docx/TFC4d7WoSoc5sVxI3LucO3Jjn1c"))
      .toBe("TFC4d7WoSoc5sVxI3LucO3Jjn1c");
    expect(documentToken("not-a-url")).toBeUndefined();
  });

  test("loads the referenced reply, fans out through subscriptions, and dispatches projects", async () => {
    const bus = eventBus();
    const dispatch = vi.fn();
    const getComment = vi.fn().mockResolvedValue({
      code: 0,
      data: {
        items: [{
          comment_id: "comment-1",
          reply_list: {
            replies: [
              {
                reply_id: "reply-0",
                user_id: "ou_old",
                content: { elements: [{ text_run: { text: "旧回复" } }] },
              },
              {
                reply_id: "reply-1",
                user_id: "ou_author",
                create_time: 1_787_472_000,
                content: { elements: [{ text_run: { text: "方案通过，可以开始开发" } }] },
              },
            ],
          },
        }],
      },
    });
    const subscriber = new FeishuCommentEventSubscriber({
      appId: "app-id",
      appSecret: "app-secret",
      eventBus: bus,
      dispatcher: { dispatch },
      reader: { getComment },
    });

    await subscriber.handleNotice({
      event_id: "event-1",
      notice_meta: {
        file_type: "docx",
        file_token: "doc-token",
        notice_type: "add_reply",
        from_user_id: { open_id: "ou_human" },
      },
      comment_id: "comment-1",
      reply_id: "reply-1",
      is_mentioned: true,
    });

    expect(getComment).toHaveBeenCalledWith({
      fileToken: "doc-token",
      fileType: "docx",
      commentId: "comment-1",
    });
    expect(bus.recordExternalEvent).toHaveBeenCalledWith(expect.objectContaining({
      source: "feishu",
      resourceType: "document",
      resourceId: "docx:doc-token",
      eventType: "drive.notice.comment_add_v1",
    }));
    expect(bus.publishExternalEvent).toHaveBeenCalledWith(expect.objectContaining({
      externalEventId: "event-1",
      payload: expect.objectContaining({
        reply_id: "reply-1",
        author: "ou_human",
        content: "方案通过，可以开始开发",
      }),
    }));
    expect(dispatch).toHaveBeenCalledWith(["project-1", "project-2"]);
  });

  test("records but does not enrich an event with no project subscriptions", async () => {
    const bus = eventBus({ matchingSubscriptionCount: vi.fn().mockResolvedValue(0) });
    const getComment = vi.fn();
    const dispatch = vi.fn();
    const onEvent = vi.fn();
    const subscriber = new FeishuCommentEventSubscriber({
      appId: "app-id",
      appSecret: "app-secret",
      eventBus: bus,
      dispatcher: { dispatch },
      reader: { getComment },
      onEvent,
    });

    await subscriber.handleNotice({
      notice_meta: { file_type: "docx", file_token: "unknown-token" },
      comment_id: "comment-1",
    });

    expect(bus.recordExternalEvent).toHaveBeenCalledOnce();
    expect(getComment).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ outcome: "unmatched" }));
  });

  test("reports a safe API error and rejects so Feishu can retry the event", async () => {
    const onError = vi.fn();
    const apiError = Object.assign(new Error("Request failed with status code 400"), {
      response: {
        data: {
          code: 99991672,
          msg: "Access denied: docs:document.comment:read is required",
        },
      },
      config: { headers: { Authorization: "Bearer secret-token" } },
    });
    const subscriber = new FeishuCommentEventSubscriber({
      appId: "app-id",
      appSecret: "app-secret",
      eventBus: eventBus(),
      dispatcher: { dispatch: vi.fn() },
      reader: { getComment: vi.fn().mockRejectedValue(apiError) },
      onError,
    });

    await expect(subscriber.handleNotice({
      notice_meta: { file_type: "docx", file_token: "doc-token" },
      comment_id: "comment-1",
    })).rejects.toThrow("Access denied: docs:document.comment:read is required");
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Access denied: docs:document.comment:read is required" }),
      expect.any(Object),
    );
    expect(JSON.stringify(onError.mock.calls)).not.toContain("secret-token");
  });
});
