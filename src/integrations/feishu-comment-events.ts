import * as Lark from "@larksuiteoapi/node-sdk";

import type {
  PostgresProjectEventBus,
  ProjectEventPublishResult,
  SingleAgentProjectEventDispatcher,
} from "../events/project-event-bus.js";
import { feishuDocumentResource } from "../events/project-event-bus.js";

type UnknownRecord = Record<string, unknown>;

const safeLarkLogger: Lark.Logger = {
  error: () => undefined,
  warn: () => undefined,
  info: () => undefined,
  debug: () => undefined,
  trace: () => undefined,
};

function object(value: unknown): UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : {};
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.trim().length > 0)?.trim();
}

function safeError(value: unknown): Error {
  if (value instanceof Error) {
    const response = object(object(value).response);
    const data = object(response.data);
    const apiMessage = firstString(data.msg, data.message);
    if (apiMessage) return new Error(apiMessage);
    return new Error(value.message);
  }
  return new Error(String(value));
}

function contentText(value: unknown, depth = 0): string {
  if (depth > 8 || value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) {
    return value.map((item) => contentText(item, depth + 1)).filter(Boolean).join("\n");
  }
  const item = object(value);
  const direct = firstString(item.text, item.content_text);
  if (direct) return direct;
  for (const key of ["content", "elements", "text_run", "docs_link", "body"]) {
    const nested = contentText(item[key], depth + 1);
    if (nested) return nested;
  }
  return "";
}

export function documentToken(documentUrl: string): string | undefined {
  return feishuDocumentResource(documentUrl)?.fileToken;
}

export interface FeishuCommentNotice {
  event_id?: string;
  uuid?: string;
  create_time?: string;
  notice_meta?: {
    file_type?: "doc" | "docx" | "sheet" | "bitable" | "slides" | "file";
    file_token?: string;
    from_user_id?: {
      union_id?: string;
      user_id?: string;
      open_id?: string;
    };
    notice_type?: "add_comment" | "add_reply";
  };
  comment_id?: string;
  reply_id?: string;
  is_mentioned?: boolean;
}

export interface FeishuCommentReader {
  getComment(input: {
    fileToken: string;
    fileType: "doc" | "docx" | "sheet" | "bitable" | "slides" | "file";
    commentId: string;
  }): Promise<unknown>;
}

export interface FeishuCommentEventSubscriberOptions {
  appId: string;
  appSecret: string;
  eventBus: Pick<PostgresProjectEventBus,
    "recordExternalEvent" | "matchingSubscriptionCount" | "publishExternalEvent">;
  dispatcher: Pick<SingleAgentProjectEventDispatcher, "dispatch">;
  reader?: FeishuCommentReader;
  onReady?: () => void;
  onError?: (error: Error, notice?: FeishuCommentNotice) => void;
  onEvent?: (input: {
    notice: FeishuCommentNotice;
    outcome: "unmatched" | "ignored" | "delivered" | "duplicate";
    publishResult?: ProjectEventPublishResult;
  }) => void;
}

interface NormalizedComment {
  replyId: string | null;
  author: string;
  content: string;
  createdAt: string | null;
}

function normalizeComment(response: unknown, replyId?: string): NormalizedComment | undefined {
  const root = object(response);
  const data = object(root.data);
  const items = Array.isArray(data.items) ? data.items : [];
  const comment = object(items[0]);
  const replyList = object(comment.reply_list);
  const replies = Array.isArray(replyList.replies) ? replyList.replies : [];
  const selected = replyId
    ? replies.find((item) => firstString(object(item).reply_id, object(item).id) === replyId)
    : replies[0];
  const reply = object(selected);
  const content = contentText(reply.content ?? reply);
  if (!content) return undefined;
  return {
    replyId: firstString(reply.reply_id, reply.id) ?? null,
    author: firstString(reply.user_name, reply.user_id) ?? "unknown",
    content,
    createdAt: reply.create_time === undefined ? null : String(reply.create_time),
  };
}

class LarkCommentReader implements FeishuCommentReader {
  private readonly client: Lark.Client;

  constructor(appId: string, appSecret: string) {
    this.client = new Lark.Client({
      appId,
      appSecret,
      appType: Lark.AppType.SelfBuild,
      domain: Lark.Domain.Feishu,
      logger: safeLarkLogger,
    });
  }

  async getComment(input: {
    fileToken: string;
    fileType: "doc" | "docx" | "sheet" | "bitable" | "slides" | "file";
    commentId: string;
  }): Promise<unknown> {
    return this.client.drive.v1.fileComment.batchQuery({
      path: { file_token: input.fileToken },
      params: {
        file_type: input.fileType,
        user_id_type: "open_id",
      },
      data: {
        comment_ids: [input.commentId],
        need_relation: true,
      },
    });
  }
}

export class FeishuCommentEventSubscriber {
  private readonly reader: FeishuCommentReader;
  private wsClient?: Lark.WSClient;

  constructor(private readonly options: FeishuCommentEventSubscriberOptions) {
    this.reader = options.reader ?? new LarkCommentReader(options.appId, options.appSecret);
  }

  async start(): Promise<void> {
    if (this.wsClient) return;
    const eventDispatcher = new Lark.EventDispatcher({
      logger: safeLarkLogger,
    }).register({
      "drive.notice.comment_add_v1": async (notice) => this.handleNotice(notice),
    });
    const wsClient = new Lark.WSClient({
      appId: this.options.appId,
      appSecret: this.options.appSecret,
      domain: Lark.Domain.Feishu,
      logger: safeLarkLogger,
      autoReconnect: true,
      handshakeTimeoutMs: 15_000,
      onReady: this.options.onReady,
      onError: (error) => this.options.onError?.(error),
    });
    this.wsClient = wsClient;
    try {
      await wsClient.start({ eventDispatcher });
    } catch (error) {
      if (this.wsClient === wsClient) this.wsClient = undefined;
      throw error;
    }
  }

  stop(): void {
    this.wsClient?.close();
    this.wsClient = undefined;
  }

  async handleNotice(notice: FeishuCommentNotice): Promise<void> {
    try {
      const fileToken = firstString(notice.notice_meta?.file_token);
      const commentId = firstString(notice.comment_id);
      const fileType = notice.notice_meta?.file_type;
      if (!fileToken || !commentId || !fileType) {
        throw new Error("Feishu comment event is missing file_token, file_type, or comment_id");
      }
      if (!["doc", "docx", "sheet", "bitable", "slides", "file"].includes(fileType)) {
        throw new Error(`Unsupported Feishu comment file type: ${fileType}`);
      }
      const externalEventId = firstString(notice.event_id, notice.uuid)
        ?? `${fileToken}:${commentId}:${notice.reply_id ?? "root"}`;
      const resourceId = `${fileType}:${fileToken}`;
      const rawPayload = {
        file_token: fileToken,
        file_type: fileType,
        comment_id: commentId,
        reply_id: notice.reply_id ?? null,
        notice_type: notice.notice_meta?.notice_type,
        is_mentioned: notice.is_mentioned,
        created_at: notice.create_time ?? null,
      };
      await this.options.eventBus.recordExternalEvent({
        source: "feishu",
        externalEventId,
        resourceType: "document",
        resourceId,
        eventType: "drive.notice.comment_add_v1",
        payload: rawPayload,
      });
      const matchedSubscriptionCount = await this.options.eventBus.matchingSubscriptionCount({
        source: "feishu",
        resourceType: "document",
        resourceId,
        eventType: "drive.notice.comment_add_v1",
      });
      if (matchedSubscriptionCount === 0) {
        this.options.onEvent?.({ notice, outcome: "unmatched" });
        return;
      }

      const response = await this.reader.getComment({ fileToken, fileType, commentId });
      const root = object(response);
      if (typeof root.code === "number" && root.code !== 0) {
        throw new Error(firstString(root.msg) ?? `Feishu comment query failed with code ${root.code}`);
      }
      const comment = normalizeComment(response, notice.reply_id);
      if (!comment || comment.content.startsWith("[SwarmHive Agent]")) {
        this.options.onEvent?.({ notice, outcome: "ignored" });
        return;
      }
      const eventAuthor = notice.notice_meta?.from_user_id;
      const author = firstString(
        eventAuthor?.open_id,
        eventAuthor?.user_id,
        eventAuthor?.union_id,
        comment.author,
      ) ?? "unknown";
      const publishResult = await this.options.eventBus.publishExternalEvent({
        source: "feishu",
        externalEventId,
        resourceType: "document",
        resourceId,
        eventType: "drive.notice.comment_add_v1",
        payload: {
          ...rawPayload,
          reply_id: notice.reply_id ?? comment.replyId,
          author,
          content: comment.content,
          created_at: comment.createdAt ?? notice.create_time ?? null,
        },
      });
      await this.options.dispatcher.dispatch(publishResult.deliveredProjectIds);
      this.options.onEvent?.({
        notice,
        outcome: publishResult.deliveredProjectIds.length > 0 ? "delivered" : "duplicate",
        publishResult,
      });
    } catch (error) {
      const sanitized = safeError(error);
      this.options.onError?.(sanitized, notice);
      throw sanitized;
    }
  }
}
