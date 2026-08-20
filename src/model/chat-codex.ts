import { ChatOpenAI } from "@langchain/openai";

import { FileChatGptTokenProvider } from "../auth/codex-oauth.js";

export const CHATGPT_CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";

export interface CodexModelOptions {
  model?: string;
  instructions: string;
  originator?: string;
  tokenProvider?: FileChatGptTokenProvider;
}

/**
 * Experimental, unofficial ChatGPT OAuth adapter matching LangChain Python's
 * `_ChatOpenAICodex` wire constraints. It intentionally pins the endpoint so
 * the OAuth bearer cannot be sent to a caller-controlled URL.
 */
export async function createCodexModel(
  options: CodexModelOptions,
): Promise<ChatOpenAI> {
  if (!options.instructions.trim()) {
    throw new Error("Codex instructions must not be empty");
  }
  const token = await (options.tokenProvider ?? new FileChatGptTokenProvider()).getToken();
  return new ChatOpenAI({
    model: options.model ?? process.env.CODEX_MODEL ?? "gpt-5.6-sol",
    apiKey: token.access_token,
    useResponsesApi: true,
    streaming: true,
    streamUsage: true,
    zdrEnabled: true,
    modelKwargs: {
      instructions: options.instructions,
      store: false,
      parallel_tool_calls: false,
    },
    configuration: {
      baseURL: CHATGPT_CODEX_BASE_URL,
      defaultHeaders: {
        ...(token.account_id
          ? { "ChatGPT-Account-Id": token.account_id }
          : {}),
        originator:
          options.originator ??
          process.env.LANGCHAIN_CODEX_ORIGINATOR ??
          "agent-staff",
      },
    },
  });
}
