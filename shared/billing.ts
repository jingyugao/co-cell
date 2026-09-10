import type { Session, Turn } from './types.js';

export interface TokenRates {
  inputPerToken: number;
  cachedInputPerToken: number;
  outputPerToken: number;
}

export interface BillingTotals {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  uncachedInputTokens: number;
  cost: number | null;
  priceVersion?: string;
}

export interface EstimatedSegment {
  id: string;
  localTokens: number;
  allocatedTokens: number;
  minTokens: number;
  maxTokens: number;
}

/**
 * Proportionally allocates provider-reported uncached input across a changed
 * segment. The result is explicitly an estimate; provider serialization may
 * differ from the local tokenizer.
 */
export function estimateChangedInputSegments(
  segments: Array<{ id: string; text: string }>,
  providerUncachedTokens: number,
  tokenize: (text: string) => number,
): { estimated: true; providerUncachedTokens: number; localTokens: number; segments: EstimatedSegment[] } {
  const measured = segments.map(segment => ({ ...segment, localTokens: Math.max(0, Math.floor(tokenize(segment.text))) }));
  const localTokens = measured.reduce((sum, segment) => sum + segment.localTokens, 0);
  const total = Math.max(0, Math.floor(providerUncachedTokens));
  return { estimated: true, providerUncachedTokens: total, localTokens,
    segments: measured.map(segment => {
      const allocatedTokens = localTokens ? Math.round(total * segment.localTokens / localTokens) : 0;
      // Without the provider's cache boundary, any segment could contain all
      // of the measured uncached tail. These are conservative error bounds.
      return { id: segment.id, localTokens: segment.localTokens, allocatedTokens, minTokens: 0, maxTokens: total };
    }),
  };
}

/** Sum provider-reported usage and calculate cost for one turn. */
export function calculateTurnBilling(turn: Pick<Turn, 'contextUsage' | 'usage'>, rates: TokenRates, priceVersion?: string): BillingTotals {
  const calls = turn.contextUsage ?? [];
  const totals = calls.reduce((out, call) => {
    out.inputTokens += call.inputTokens;
    out.cachedInputTokens += call.cachedInputTokens ?? 0;
    out.outputTokens += call.outputTokens ?? 0;
    return out;
  }, { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 });
  const complete = calls.length > 0 && calls.every(call => call.cachedInputTokens !== undefined && call.outputTokens !== undefined);
  const uncachedInputTokens = Math.max(0, totals.inputTokens - totals.cachedInputTokens);
  return { ...totals, uncachedInputTokens,
    cost: complete ? uncachedInputTokens * rates.inputPerToken + totals.cachedInputTokens * rates.cachedInputPerToken + totals.outputTokens * rates.outputPerToken : null,
    ...(priceVersion ? { priceVersion } : {}),
  };
}

export function sumBilling(values: BillingTotals[], priceVersion?: string): BillingTotals {
  const total = values.reduce<BillingTotals>((out, value) => ({
    inputTokens: out.inputTokens + value.inputTokens,
    cachedInputTokens: out.cachedInputTokens + value.cachedInputTokens,
    outputTokens: out.outputTokens + value.outputTokens,
    uncachedInputTokens: out.uncachedInputTokens + value.uncachedInputTokens,
    cost: out.cost === null || value.cost === null ? null : out.cost + value.cost,
  }), { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, uncachedInputTokens: 0, cost: 0 });
  return { ...total, ...(priceVersion ? { priceVersion } : {}) };
}

export function calculateSessionBilling(session: Pick<Session, 'turns'>, rates: TokenRates, priceVersion?: string): BillingTotals {
  return sumBilling(session.turns.map(turn => calculateTurnBilling(turn, rates, priceVersion)), priceVersion);
}
