import type { Usage } from '../protocol/agent-protocol.js';
import type { ContextUsage } from '../protocol/types.js';

/** Only complete per-request observations can be summed as turn usage. */
export function sumRequestUsage(calls: ContextUsage[] | undefined): Usage | undefined {
  if (!calls?.length || calls.some(call => call.cachedInputTokens === undefined || call.outputTokens === undefined)) return undefined;
  return calls.reduce<Usage>((sum, call) => ({
    input_tokens: sum.input_tokens + call.inputTokens,
    cached_input_tokens: sum.cached_input_tokens + call.cachedInputTokens!,
    output_tokens: sum.output_tokens + call.outputTokens!,
    cache_write_input_tokens: sum.cache_write_input_tokens + (call.rawUsage?.cache_write_input_tokens ?? 0),
    reasoning_output_tokens: sum.reasoning_output_tokens + (call.rawUsage?.reasoning_output_tokens ?? call.rawUsage?.output_tokens_details?.reasoning_tokens ?? 0),
  }), { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, cache_write_input_tokens: 0, reasoning_output_tokens: 0 });
}
