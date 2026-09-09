export interface ModelTokenRates {
  inputUsdPerMillion: number;
  cachedInputUsdPerMillion: number;
  outputUsdPerMillion: number;
}

/** Standard short-context API prices, in USD per million tokens. */
export const MODEL_TOKEN_RATES: Readonly<Record<string, ModelTokenRates>> = {
  'gpt-6-astra': { inputUsdPerMillion: 10, cachedInputUsdPerMillion: 1, outputUsdPerMillion: 50 },
  'gpt-5.6-sol': { inputUsdPerMillion: 4, cachedInputUsdPerMillion: 0.4, outputUsdPerMillion: 20 },
  'gpt-5.6-terra': { inputUsdPerMillion: 2, cachedInputUsdPerMillion: 0.2, outputUsdPerMillion: 12 },
  'gpt-5.6-luna': { inputUsdPerMillion: 0.2, cachedInputUsdPerMillion: 0.02, outputUsdPerMillion: 1.2 },
};

export function estimateTokenCostUsd(model: string | undefined, usage: { inputTokens: number; cachedInputTokens?: number; outputTokens?: number }): number | null {
  const rates = model ? MODEL_TOKEN_RATES[model] : undefined;
  if (!rates || usage.outputTokens === undefined) return null;
  const cached = Math.min(Math.max(usage.cachedInputTokens ?? 0, 0), usage.inputTokens);
  return ((usage.inputTokens - cached) * rates.inputUsdPerMillion + cached * rates.cachedInputUsdPerMillion + usage.outputTokens * rates.outputUsdPerMillion) / 1_000_000;
}
