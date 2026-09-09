import { Fragment } from 'react';
import type { UserApproval } from '../../../shared/approval-types';
import type { ContextUsage, Turn } from '../../../shared/types';
import { estimateTokenCostUsd } from '../../../shared/model-costs';
import type { MarkdownResources } from './Markdown';
import ItemView from './ItemView';
import ToolDetails from './ToolDetails';
import UserApprovalCard from './UserApprovalCard';
import { matchApprovalItems } from './approval-items';

function ContextHeatmap({ steps }: { steps: ContextUsage[] | undefined }) {
  if (!steps?.length) return null;
  const costs = steps.map(step => estimateTokenCostUsd(step.model, step));
  const estimatedCosts = costs.filter((cost): cost is number => cost !== null);
  const hasCost = estimatedCosts.length === steps.length;
  const values = hasCost ? estimatedCosts : steps.map(step => step.inputTokens);
  const maximum = Math.max(...values, 1);
  const total = estimatedCosts.reduce((sum, cost) => sum + cost, 0);
  const cumulativeCosts = costs.reduce<number[]>((all, cost) => [...all, (all.at(-1) ?? 0) + (cost ?? 0)], []);
  const formatUsd = (amount: number) => amount >= 0.01 ? `$${amount.toFixed(3)}` : `$${amount.toFixed(5)}`;
  return <div className="context-heatmap">
    <div className="context-heatmap-heading"><span>{hasCost ? '模型步骤估算费用' : '模型步骤上下文'}</span><small>{hasCost ? '颜色越深，费用越高' : '颜色越深，输入 token 越多'}</small></div>
    <div className="context-heatmap-steps" role="list" aria-label={hasCost ? '模型步骤累计费用热力图' : '模型步骤上下文 token 热力图'}>
      {steps.map((step, index) => {
        const cost = costs[index];
        const intensity = 0.2 + (hasCost && cost !== null ? cost : step.inputTokens) / maximum * 0.8;
        const title = `第 ${index + 1} 步：输入 ${step.inputTokens.toLocaleString()} tokens${step.cachedInputTokens !== undefined ? `，缓存 ${step.cachedInputTokens.toLocaleString()} tokens` : ''}${step.outputTokens !== undefined ? `，输出 ${step.outputTokens.toLocaleString()} tokens` : ''}${cost !== null ? `，本步估算 ${formatUsd(cost)}，累计 ${formatUsd(cumulativeCosts[index])}` : ''}`;
        return <span key={`${step.observedAt}-${index}`} role="listitem" className="context-heatmap-step" style={{ backgroundColor: `rgb(84 108 55 / ${intensity})` }} title={title} aria-label={title}>{index + 1}</span>;
      })}
    </div>
    <div className="context-heatmap-scale"><span>第 1 步</span><span>{hasCost ? `${steps.length} 步 · 累计 ${formatUsd(total)}` : `${steps.length} 个模型步骤 · 最大 ${maximum.toLocaleString()} tokens`}</span></div>
  </div>;
}

/** Place decisions at their tool call, so later execution and replies stay below them. */
export default function TurnItems({ turn, sessionId, onApprovalResolved, ...resources }: {
  turn: Turn;
  sessionId: string;
  onApprovalResolved: (approval: UserApproval) => void;
} & MarkdownResources) {
  const { matches, unmatched } = matchApprovalItems(turn.items, turn.approvals ?? []);
  const renderApproval = (approval: UserApproval) => <UserApprovalCard key={approval.id}
    approval={approval} sessionId={sessionId} turnId={turn.id} turnStatus={turn.status}
    onResolved={onApprovalResolved} {...resources} />;
  return <>
    {turn.items.map(item => {
      const approval = matches.get(item.id);
      return approval ? <Fragment key={item.id}>{renderApproval(approval)}<ToolDetails item={item} /></Fragment>
        : <ItemView key={item.id} item={item} turnStatus={turn.status} timestamp={turn.itemTimestamps?.[item.id] || turn.startedAt} {...resources} />;
    })}
    {/* A request can arrive before its SDK item. Keep it actionable without inventing a match. */}
    {unmatched.map(renderApproval)}
    <ContextHeatmap steps={turn.contextUsage} />
  </>;
}
