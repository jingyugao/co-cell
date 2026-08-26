import * as Lark from "@larksuiteoapi/node-sdk";

import type {
  ExternalEventReplyAdapter,
  ProjectEventReplyContext,
} from "../events/project-event-interactions.js";

const safeLarkLogger: Lark.Logger = {
  error: () => undefined,
  warn: () => undefined,
  info: () => undefined,
  debug: () => undefined,
  trace: () => undefined,
};

type FeishuFileType = "doc" | "docx" | "sheet" | "file" | "slides" | "bitable" | "apps";

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function safeError(value: unknown): Error {
  if (value instanceof Error) {
    const response = value as Error & { response?: { data?: { msg?: unknown; message?: unknown } } };
    return new Error(
      string(response.response?.data?.msg) ??
      string(response.response?.data?.message) ??
      value.message,
    );
  }
  return new Error(String(value));
}

export interface FeishuCommentWriter {
  reply(input: {
    fileToken: string;
    fileType: FeishuFileType;
    commentId: string;
    content: string;
  }): Promise<{ providerReplyId?: string }>;
}

class LarkCommentWriter implements FeishuCommentWriter {
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

  async reply(input: {
    fileToken: string;
    fileType: FeishuFileType;
    commentId: string;
    content: string;
  }): Promise<{ providerReplyId?: string }> {
    try {
      const response = await this.client.drive.v1.fileCommentReply.create({
        path: {
          file_token: input.fileToken,
          comment_id: input.commentId,
        },
        params: {
          file_type: input.fileType,
          user_id_type: "open_id",
        },
        data: {
          content: {
            elements: [{
              type: "text_run",
              text_run: { text: input.content },
            }],
          },
        },
      });
      if (typeof response.code === "number" && response.code !== 0) {
        throw new Error(response.msg ?? `Feishu comment reply failed with code ${response.code}`);
      }
      return response.data?.reply_id
        ? { providerReplyId: response.data.reply_id }
        : {};
    } catch (error) {
      throw safeError(error);
    }
  }
}

export class FeishuCommentReplyAdapter implements ExternalEventReplyAdapter {
  readonly source = "feishu";
  private readonly writer: FeishuCommentWriter;

  constructor(options: {
    appId: string;
    appSecret: string;
    writer?: FeishuCommentWriter;
  }) {
    this.writer = options.writer ?? new LarkCommentWriter(options.appId, options.appSecret);
  }

  supports(context: ProjectEventReplyContext): boolean {
    return context.eventType === "technical_design_comment_received" &&
      Boolean(string(context.payload.file_token)) &&
      Boolean(string(context.payload.file_type)) &&
      Boolean(string(context.payload.comment_id));
  }

  async reply(
    context: ProjectEventReplyContext,
    content: string,
  ): Promise<{ providerReplyId?: string }> {
    const fileToken = string(context.payload.file_token);
    const fileType = string(context.payload.file_type) as FeishuFileType | undefined;
    const commentId = string(context.payload.comment_id);
    if (!fileToken || !fileType || !commentId) {
      throw new Error("Feishu comment reply context is incomplete");
    }
    return this.writer.reply({
      fileToken,
      fileType,
      commentId,
      content: `[SwarmHive Agent]\n${content}`,
    });
  }
}
