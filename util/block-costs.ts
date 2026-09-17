/**
 * 简化的 block 费用分摊 — 基于新的预估计费模型。
 *
 * 不再尝试猜测 provider 的缓存边界进行精细分摊。
 * 改为基于文本 token 估算输出每个 turn 的预估费用结果，
 * 方便前端展示每个 turn 的费用构成。
 */
import type { Turn } from '../protocol/types.js';
import { MODEL_TOKEN_RATES } from './model-costs.js';
import { estimateSessionCosts } from './billing.js';

export interface BlockCost {
  id: string;
  label: string;
  cost: number;
  inputCost: number;
  outputCost: number;
  calls: number;
  turnId: string;
  itemId?: string;
  tokens: number;
  segment: number;
  /** 费用构成标记 */
  costType: 'history' | 'newInput' | 'output';
}

export interface SessionBlockCostsResult {
  blocks: BlockCost[];
  total: number;
  unassigned: number;
  unknownCalls: number;
  /** 每个 turn 的费用摘要，用于前端展示费用原因 */
  turnSummaries: TurnCostSummary[];
}

export interface TurnCostSummary {
  turnId: string;
  turnIndex: number;
  historyCost: number;
  newInputCost: number;
  outputCost: number;
  totalCost: number;
  summary: string;
}

export function sessionBlockCosts(turns: Turn[]): SessionBlockCostsResult {
  // 确定使用的模型（取第一个 turn 中可用的模型名）
  const resolvedModel = findModel(turns);
  const rates = resolvedModel ? MODEL_TOKEN_RATES[resolvedModel] : undefined;
  if (!rates || !resolvedModel) {
    return { blocks: [], total: 0, unassigned: 0, unknownCalls: turns.length, turnSummaries: [] };
  }

  // 使用新的预估计费模型
  const estimate = estimateSessionCosts(turns, resolvedModel, rates);

  // 构建简化的 block 数据（每个 turn 对应 3 个 block：历史/新输入/输出）
  const blocks: BlockCost[] = [];
  let total = 0;

  for (const turnEst of estimate.turns) {
    if (turnEst.historyCost > 0) {
      blocks.push({
        id: `${turnEst.turnId}-history`,
        label: `Turn ${turnEst.turnIndex + 1} · 历史上下文`,
        cost: turnEst.historyCost,
        inputCost: turnEst.historyCost,
        outputCost: 0,
        calls: 1,
        turnId: turnEst.turnId,
        tokens: turnEst.estimatedHistoryTokens,
        segment: turnEst.segment,
        costType: 'history',
      });
      total += turnEst.historyCost;
    }
    if (turnEst.estimatedNewInputTokens > 0) {
      blocks.push({
        id: `${turnEst.turnId}-newInput`,
        label: `Turn ${turnEst.turnIndex + 1} · 新输入`,
        cost: turnEst.newInputCost,
        inputCost: turnEst.newInputCost,
        outputCost: 0,
        calls: 1,
        turnId: turnEst.turnId,
        tokens: turnEst.estimatedNewInputTokens,
        segment: turnEst.segment,
        costType: 'newInput',
      });
      total += turnEst.newInputCost;
    }
    if (turnEst.estimatedOutputTokens > 0) {
      blocks.push({
        id: `${turnEst.turnId}-output`,
        label: `Turn ${turnEst.turnIndex + 1} · 模型输出`,
        cost: turnEst.outputCost,
        inputCost: 0,
        outputCost: turnEst.outputCost,
        calls: 1,
        turnId: turnEst.turnId,
        tokens: turnEst.estimatedOutputTokens,
        segment: turnEst.segment,
        costType: 'output',
      });
      total += turnEst.outputCost;
    }
  }

  const turnSummaries: TurnCostSummary[] = estimate.turns.map(t => ({
    turnId: t.turnId,
    turnIndex: t.turnIndex,
    historyCost: t.historyCost,
    newInputCost: t.newInputCost,
    outputCost: t.outputCost,
    totalCost: t.totalCost,
    summary: t.summary,
  }));

  return { blocks, total, unassigned: 0, unknownCalls: 0, turnSummaries };
}

function findModel(turns: Turn[]): string | undefined {
  for (const turn of turns) {
    for (const call of turn.contextUsage ?? []) {
      if (call.model) return call.model;
    }
  }
  return turns.length > 0 ? 'gpt-5.6-terra' : undefined;
}