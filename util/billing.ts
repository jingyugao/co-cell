/**
 * 费用预估模块 — 不追求真实计费，只用于预估计费，方便查看费用原因。
 *
 * 核心模型（假设总是使用提示缓存）：
 * - 第一个 turn：全部输入按非缓存计费（首次写入缓存），输出按输出计费
 * - 后续每个 turn：之前全部历史上下文按缓存费率计费，当前新增输入按非缓存计费
 * - 清晰展示每个 turn 的费用构成：历史上下文占多少、新输入占多少、输出占多少
 */
import type { Session, Turn, ContextUsage } from '../protocol/types.js';
import { countTokens, extractTurnText } from './tokenizer.js';
import type { ModelTokenRates } from './model-costs.js';

export interface TokenRates {
  inputPerToken: number;
  cachedInputPerToken: number;
  outputPerToken: number;
}

// ─── 类型定义 ─────────────────────────────────────────────────────

/** 单个 turn 的费用分解。 */
export interface TurnCostBreakdown {
  turnId: string;
  /** 会话中第几个 turn（从 0 开始）。 */
  turnIndex: number;
  segment: number;

  /** 累计历史上下文的预估 token 数（之前所有 turn 的文本）。 */
  estimatedHistoryTokens: number;
  /** 当前 turn 新增输入（prompt + 工具结果）的预估 token 数。 */
  estimatedNewInputTokens: number;
  /** 当前 turn 输出的预估 token 数。 */
  estimatedOutputTokens: number;

  /** 历史上下文的费用（缓存费率）。 */
  historyCost: number;
  /** 新输入的费用（非缓存费率）。 */
  newInputCost: number;
  /** 输出的费用（输出费率）。 */
  outputCost: number;
  /** 该 turn 总费用。 */
  totalCost: number;

  /** 该 turn 中是否存在上下文压缩（compaction），压缩后历史重新计费。 */
  hasCompaction: boolean;
  /** 压缩后的新 segment 编号（0 表示无压缩）。 */
  effectiveSegment: number;

  /** Provider 报告的 token 数（仅在可供参考时）。 */
  providerInputTokens?: number;
  providerCachedTokens?: number;
  providerOutputTokens?: number;

  /** 该 turn 包含的 model 调用次数。 */
  callCount: number;

  /** 人类可读的费用原因摘要。 */
  summary: string;
}

/** 整个会话的费用预估汇总。 */
export interface SessionCostBreakdown {
  turns: TurnCostBreakdown[];
  /** 会话总费用。 */
  totalCost: number;
  /** 所有 turn 的历史上下文费用之和。 */
  totalHistoryCost: number;
  /** 所有 turn 的新输入费用之和。 */
  totalNewInputCost: number;
  /** 所有 turn 的输出费用之和。 */
  totalOutputCost: number;
  /** 使用的模型名称。 */
  model: string;
  /** 定价版本。 */
  priceVersion?: string;
  /** 总预估 token 数（历史 + 新输入 + 输出）。 */
  totalTokens: number;
}

/** 向后兼容的计费总计类型。 */
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

// ─── 核心预估逻辑 ─────────────────────────────────────────────────

/**
 * 对会话进行费用预估。
 * 使用 tiktoken（OpenAI 库）对文本 token 计数，应用简化的缓存模型：
 * - 第一个 turn 全部输入按非缓存
 * - 后续 turn 的历史上下文按缓存，新输入按非缓存
 */
export function estimateSessionCosts(
  turns: Turn[],
  model: string,
  rates: ModelTokenRates,
  priceVersion?: string,
): SessionCostBreakdown {
  const breakdowns: TurnCostBreakdown[] = [];

  // 用于追踪累计历史 token 数和每个 segment 的独立状态
  let cumulativeHistoryTokens = 0;
  let currentSegmentHistoryTokens = 0;
  let segment = 0;

  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i];

    // 检查是否有 compaction
    const hasCompaction = (turn.compactions?.length ?? 0) > 0;
    if (hasCompaction) {
      // compaction 后重新开始计费历史
      segment++;
      currentSegmentHistoryTokens = 0;
      cumulativeHistoryTokens = 0;
    }

    // 提取当前 turn 的文本内容用于 token 计数
    const turnText = extractTurnText(turn);
    const newInputTokens = countTokens(turnText);

    // 预估输出 token 数
    let estimatedOutputTokens = 0;
    // 从 Provider 数据获取输出 token 数（如果有）
    const callCount = turn.contextUsage?.length ?? 0;
    const providerCachedTokens = sumContextUsage(turn.contextUsage, 'cachedInputTokens');
    const providerInputTokens = sumContextUsage(turn.contextUsage, 'inputTokens');
    const providerOutputTokens = sumContextUsage(turn.contextUsage, 'outputTokens');
    // 优先使用 provider 报告的输出 token 数
    if (providerOutputTokens > 0) {
      estimatedOutputTokens = providerOutputTokens;
    } else {
      // 回退到本地预估：输出文本 token 数
      const outputText = turn.items
        .filter(item => item.type === 'agent_message' || item.type === 'reasoning')
        .map(item => 'text' in item ? item.text : '')
        .join('\n');
      estimatedOutputTokens = countTokens(outputText);
    }

    // 区分历史 token 和新增 token
    // 在 compaction 后的第一个 turn，没有历史上下文（从 0 开始）
    const historyTokens = currentSegmentHistoryTokens;
    const totalInputTokens = newInputTokens;
    // 当前 turn 完成后，将其内容加入历史 token
    currentSegmentHistoryTokens += totalInputTokens;
    cumulativeHistoryTokens += totalInputTokens;

    // 应用费率计算费用
    const historyCost = historyTokens * rates.cachedInputUsdPerMillion / 1_000_000;
    const newInputCost = totalInputTokens * rates.inputUsdPerMillion / 1_000_000;
    const outputCost = estimatedOutputTokens * rates.outputUsdPerMillion / 1_000_000;
    const totalCost = historyCost + newInputCost + outputCost;

    // 生成费用原因摘要
    const summaryParts: string[] = [];
    if (historyTokens > 0) {
      summaryParts.push(`历史上下文 ${historyTokens.toLocaleString()} tokens × 缓存费率 $${rates.cachedInputUsdPerMillion}/M = $${historyCost.toFixed(6)}`);
    }
    summaryParts.push(`新输入 ${totalInputTokens.toLocaleString()} tokens × $${rates.inputUsdPerMillion}/M = $${newInputCost.toFixed(6)}`);
    summaryParts.push(`输出 ${estimatedOutputTokens.toLocaleString()} tokens × $${rates.outputUsdPerMillion}/M = $${outputCost.toFixed(6)}`);
    if (hasCompaction) {
      summaryParts.push('——此 turn 之前发生了上下文压缩，历史重置');
    }

    breakdowns.push({
      turnId: turn.id,
      turnIndex: i,
      segment,
      estimatedHistoryTokens: historyTokens,
      estimatedNewInputTokens: totalInputTokens,
      estimatedOutputTokens,
      historyCost,
      newInputCost,
      outputCost,
      totalCost,
      hasCompaction,
      effectiveSegment: hasCompaction ? segment : (turn.segment ?? segment),
      providerInputTokens,
      providerCachedTokens,
      providerOutputTokens,
      callCount,
      summary: summaryParts.join('；'),
    });
  }

  const totalHistoryCost = breakdowns.reduce((s, t) => s + t.historyCost, 0);
  const totalNewInputCost = breakdowns.reduce((s, t) => s + t.newInputCost, 0);
  const totalOutputCost = breakdowns.reduce((s, t) => s + t.outputCost, 0);
  const totalCost = totalHistoryCost + totalNewInputCost + totalOutputCost;
  const totalTokens = breakdowns.reduce((s, t) => s + t.estimatedHistoryTokens + t.estimatedNewInputTokens + t.estimatedOutputTokens, 0);

  return {
    turns: breakdowns,
    totalCost,
    totalHistoryCost,
    totalNewInputCost,
    totalOutputCost,
    model,
    ...(priceVersion ? { priceVersion } : {}),
    totalTokens,
  };
}

// ─── 向后兼容（旧接口） ───────────────────────────────────────────

export function estimateChangedInputSegments(
  segments: Array<{ id: string; text: string }>,
  providerUncachedTokens: number,
  _tokenize?: (text: string) => number,
): { estimated: true; providerUncachedTokens: number; localTokens: number; segments: EstimatedSegment[] } {
  const measured = segments.map(segment => ({ ...segment, localTokens: Math.max(0, Math.floor(countTokens(segment.text))) }));
  const localTokens = measured.reduce((sum, segment) => sum + segment.localTokens, 0);
  const total = Math.max(0, Math.floor(providerUncachedTokens));
  return {
    estimated: true, providerUncachedTokens: total, localTokens,
    segments: measured.map(segment => {
      const allocatedTokens = localTokens ? Math.round(total * segment.localTokens / localTokens) : 0;
      return { id: segment.id, localTokens: segment.localTokens, allocatedTokens, minTokens: 0, maxTokens: total };
    }),
  };
}

export function calculateTurnBilling(turn: Pick<Turn, 'contextUsage' | 'usage'>, _rates: TokenRates, priceVersion?: string): BillingTotals {
  const calls = turn.contextUsage ?? [];
  const totals = calls.reduce((out, call) => {
    out.inputTokens += call.inputTokens;
    out.cachedInputTokens += call.cachedInputTokens ?? 0;
    out.outputTokens += call.outputTokens ?? 0;
    return out;
  }, { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 });
  const complete = calls.length > 0 && calls.every(call => call.cachedInputTokens !== undefined && call.outputTokens !== undefined);
  const uncachedInputTokens = Math.max(0, totals.inputTokens - totals.cachedInputTokens);
  return {
    ...totals, uncachedInputTokens,
    cost: complete ? totals.cachedInputTokens + totals.outputTokens + uncachedInputTokens : null,
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

/** @deprecated 使用 estimateSessionCosts 替代 */
export function calculateSessionBilling(session: Pick<Session, 'turns'>, _rates: TokenRates, priceVersion?: string): BillingTotals {
  return sumBilling(session.turns.map(turn => calculateTurnBilling(turn, {
    inputPerToken: 0, cachedInputPerToken: 0, outputPerToken: 0,
  }, priceVersion)), priceVersion);
}

// ─── 辅助函数 ─────────────────────────────────────────────────────

function sumContextUsage(usage: ContextUsage[] | undefined, field: 'inputTokens' | 'cachedInputTokens' | 'outputTokens'): number {
  if (!usage?.length) return 0;
  return usage.reduce((sum, call) => {
    const val = call[field];
    return sum + (typeof val === 'number' && Number.isFinite(val) ? val : 0);
  }, 0);
}