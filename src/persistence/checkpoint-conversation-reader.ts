import { BaseMessage, isAIMessage, isToolMessage } from "@langchain/core/messages";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";

import type {
  AgentConversationMessage,
  AgentConversationResponse,
} from "../contracts/workbench.js";
import { redactSensitiveText } from "../security/redact.js";

function supportedRole(value: string): value is AgentConversationMessage["role"] {
  return value === "human" || value === "ai" || value === "tool" || value === "system";
}

export function serializeConversationMessages(messages: unknown[]): AgentConversationMessage[] {
  return messages.flatMap((value, index) => {
    if (!BaseMessage.isInstance(value) || !supportedRole(value.type)) return [];
    const toolCalls = isAIMessage(value)
      ? (value.tool_calls ?? []).map((call) => ({
          id: call.id ?? `tool-call-${index}`,
          name: call.name,
          args: call.args,
        }))
      : [];
    return [{
      id: value.id ?? `message-${index}`,
      role: value.type,
      name: value.name ?? null,
      content: redactSensitiveText(value.text),
      toolCallId: isToolMessage(value) ? value.tool_call_id : null,
      toolCalls,
      status: isToolMessage(value) ? value.status ?? null : null,
    }];
  });
}

export interface AgentConversationReader {
  getConversation(threadId: string): Promise<AgentConversationResponse>;
}

export class PostgresAgentConversationReader implements AgentConversationReader {
  private readonly saver: PostgresSaver;

  constructor(
    connectionString: string,
    schema?: string,
  ) {
    this.saver = PostgresSaver.fromConnString(
      connectionString,
      schema ? { schema } : undefined,
    );
  }

  async getConversation(threadId: string): Promise<AgentConversationResponse> {
    const tuple = await this.saver.getTuple({ configurable: { thread_id: threadId } });
    const rawMessages = tuple?.checkpoint.channel_values.messages;
    return {
      threadId,
      checkpointId:
        typeof tuple?.config.configurable?.checkpoint_id === "string"
          ? tuple.config.configurable.checkpoint_id
          : null,
      messages: serializeConversationMessages(Array.isArray(rawMessages) ? rawMessages : []),
    };
  }

  close(): Promise<void> {
    return this.saver.end();
  }
}
