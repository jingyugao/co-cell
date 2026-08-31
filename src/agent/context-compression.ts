export const CONVERSATION_SUMMARY_TRIGGER_TOKENS = 40_000;
export const CONVERSATION_SUMMARY_TRIGGER_MESSAGES = 60;
export const CONVERSATION_SUMMARY_KEEP_TOKENS = 12_000;
export const CONVERSATION_SUMMARY_INPUT_TOKENS = 32_000;

export interface ContextCompressionConfig {
  triggerTokens: number;
  triggerMessages: number;
  keepTokens: number;
  summaryInputTokens: number;
}

export const DEFAULT_CONTEXT_COMPRESSION_CONFIG: Readonly<ContextCompressionConfig> = {
  triggerTokens: CONVERSATION_SUMMARY_TRIGGER_TOKENS,
  triggerMessages: CONVERSATION_SUMMARY_TRIGGER_MESSAGES,
  keepTokens: CONVERSATION_SUMMARY_KEEP_TOKENS,
  summaryInputTokens: CONVERSATION_SUMMARY_INPUT_TOKENS,
};

function positiveInteger(value: number, name: keyof ContextCompressionConfig): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Context compression ${name} must be a positive integer`);
  }
  return value;
}

/** Resolve and validate the bounds used by LangChain's summarization middleware. */
export function resolveContextCompressionConfig(
  overrides: Partial<ContextCompressionConfig> = {},
): ContextCompressionConfig {
  const triggerTokens = positiveInteger(
    overrides.triggerTokens ?? DEFAULT_CONTEXT_COMPRESSION_CONFIG.triggerTokens,
    "triggerTokens",
  );
  const triggerMessages = positiveInteger(
    overrides.triggerMessages ?? DEFAULT_CONTEXT_COMPRESSION_CONFIG.triggerMessages,
    "triggerMessages",
  );
  const keepTokens = positiveInteger(
    overrides.keepTokens ?? Math.min(
      DEFAULT_CONTEXT_COMPRESSION_CONFIG.keepTokens,
      Math.max(1, Math.floor(triggerTokens * 0.3)),
    ),
    "keepTokens",
  );
  const summaryInputTokens = positiveInteger(
    overrides.summaryInputTokens ?? Math.min(
      DEFAULT_CONTEXT_COMPRESSION_CONFIG.summaryInputTokens,
      triggerTokens,
    ),
    "summaryInputTokens",
  );
  if (keepTokens >= triggerTokens) {
    throw new Error(
      "Context compression keepTokens must be smaller than triggerTokens",
    );
  }
  return {
    triggerTokens,
    triggerMessages,
    keepTokens,
    summaryInputTokens,
  };
}

function environmentInteger(
  environment: NodeJS.ProcessEnv,
  name: string,
): number | undefined {
  const raw = environment[name]?.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

/** Load optional deployment overrides without coupling the Agent runtime to .env. */
export function loadContextCompressionConfig(
  environment: NodeJS.ProcessEnv = process.env,
): ContextCompressionConfig {
  const triggerTokens = environmentInteger(
    environment,
    "AGENT_CONTEXT_COMPRESSION_TRIGGER_TOKENS",
  );
  const triggerMessages = environmentInteger(
    environment,
    "AGENT_CONTEXT_COMPRESSION_TRIGGER_MESSAGES",
  );
  const keepTokens = environmentInteger(
    environment,
    "AGENT_CONTEXT_COMPRESSION_KEEP_TOKENS",
  );
  const summaryInputTokens = environmentInteger(
    environment,
    "AGENT_CONTEXT_COMPRESSION_SUMMARY_INPUT_TOKENS",
  );
  return resolveContextCompressionConfig({
    ...(triggerTokens !== undefined ? { triggerTokens } : {}),
    ...(triggerMessages !== undefined ? { triggerMessages } : {}),
    ...(keepTokens !== undefined ? { keepTokens } : {}),
    ...(summaryInputTokens !== undefined ? { summaryInputTokens } : {}),
  });
}
