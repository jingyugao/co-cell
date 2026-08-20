import { ChatOpenAI } from "@langchain/openai";

export interface OpenAICompatibleModelOptions {
  apiKey: string;
  baseURL: string;
  model: string;
  instructions: string;
}

export function normalizeOpenAIBaseUrl(value: string): string {
  const normalized = value.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//.test(normalized)) {
    throw new Error("OpenAI-compatible base URL must start with http:// or https://");
  }
  return normalized.endsWith("/v1") ? normalized : `${normalized}/v1`;
}

export function createOpenAICompatibleModel(
  options: OpenAICompatibleModelOptions,
): ChatOpenAI {
  if (!options.apiKey.trim()) throw new Error("OpenAI-compatible API key is required");
  if (!options.instructions.trim()) throw new Error("Model instructions must not be empty");
  return new ChatOpenAI({
    model: options.model,
    apiKey: options.apiKey,
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
      baseURL: normalizeOpenAIBaseUrl(options.baseURL),
    },
  });
}
