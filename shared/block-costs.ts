import type { Turn } from './types';
import { MODEL_TOKEN_RATES, estimateTokenCostUsd } from './model-costs';

export interface BlockEstimate {
  id: string;
  label: string;
  inputTokens: number;
  outputTokens: number;
  turnId?: string;
  itemId?: string;
}

/** Allocate aggregate cached usage proportionally: its block boundary is unknown. */
export function sessionBlockCosts(turns: Turn[]) {
  const blocks = new Map<string, { id: string; label: string; cost: number; inputCost: number; outputCost: number; calls: number; turnId: string; itemId?: string; tokens: number; segment: number }>();
  let total = 0, unassigned = 0, unknownCalls = 0;
  for (const turn of turns) for (const call of turn.contextUsage ?? []) {
    const cost = estimateTokenCostUsd(call.model, call);
    const rates = call.model ? MODEL_TOKEN_RATES[call.model] : undefined;
    if (cost === null || !rates) { unknownCalls++; continue; }
    total += cost;
    const estimates = call.blockEstimates ?? [];
    const inputSum = estimates.reduce((sum, block) => sum + block.inputTokens, 0);
    const outputSum = estimates.reduce((sum, block) => sum + block.outputTokens, 0);
    const inputScale = inputSum > call.inputTokens ? call.inputTokens / inputSum : 1;
    const outputScale = outputSum > call.outputTokens! ? call.outputTokens! / outputSum : 1;
    const inputCost = ((call.inputTokens - call.cachedInputTokens!) * rates.inputUsdPerMillion + call.cachedInputTokens! * rates.cachedInputUsdPerMillion) / 1e6;
    let assigned = 0;
    for (const estimate of estimates) {
      const input = call.inputTokens ? inputCost * estimate.inputTokens * inputScale / call.inputTokens : 0;
      const output = estimate.outputTokens * outputScale * rates.outputUsdPerMillion / 1e6;
      const owner = turns.find(candidate => candidate.id === estimate.turnId || candidate.nativeTurnId === estimate.turnId);
      const block = blocks.get(estimate.id) ?? { id: estimate.id, label: estimate.label, cost: 0, inputCost: 0, outputCost: 0, calls: 0, turnId: owner?.id ?? turn.id, itemId: estimate.itemId, tokens: estimate.inputTokens || estimate.outputTokens, segment: call.segment ?? 0 };
      block.inputCost += input; block.outputCost += output; block.cost += input + output; block.calls++;
      blocks.set(estimate.id, block); assigned += input + output;
    }
    unassigned += Math.max(0, cost - assigned);
  }
  return { blocks: [...blocks.values()], total, unassigned, unknownCalls };
}
