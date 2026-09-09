import { getEncoding } from 'js-tiktoken';
import type { Turn } from '../../shared/types.js';
const encoding = getEncoding('o200k_base');

/** Derived on read from native history; no platform block ledger is required. */
export function estimateNativeBlocks(turns: Turn[]): Turn[] {
  const counts = new Map<string, number>();
  return turns.map(turn => ({ ...turn, contextUsage: turn.contextUsage?.map(call => {
    const { blockTexts, ...usage } = call;
    if (!blockTexts) return usage;
    return { ...usage, blockTokenizer: 'js-tiktoken/o200k_base@1.0.21',
      blockEstimates: blockTexts.map(block => {
        let tokens = counts.get(block.id);
        if (tokens === undefined) { tokens = encoding.encode(block.text, [], []).length; counts.set(block.id, tokens); }
        return { id: block.id, label: block.label, turnId: block.turnId,
          inputTokens: block.direction === 'input' ? tokens : 0,
          outputTokens: block.direction === 'output' ? tokens : 0 };
      }),
    };
  }) }));
}
