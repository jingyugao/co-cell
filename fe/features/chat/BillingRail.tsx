import { Fragment, useEffect, useState } from 'react';
import type { Turn } from '../../../protocol/types';
import { sessionBlockCosts } from '../../../util/block-costs';
import type { TurnCostSummary } from '../../../util/block-costs';
import './BillingRail.css';

const money = (value: number | null) => value === null ? '未知' : `$${value.toFixed(6)}`;
const pct = (value: number, total: number) => total > 0 ? `${(value / total * 100).toFixed(0)}%` : '—';

export default function BillingRail({ turns, sessionId, selectedBlockId, onSelectBlock }: {
  turns: Turn[]; sessionId: string; selectedBlockId?: string;
  onSelectBlock: (blockId: string, turnId: string, itemIds?: string[]) => void;
}) {
  const [turnSummaries, setTurnSummaries] = useState<TurnCostSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [expandedTurn, setExpandedTurn] = useState<string | null>(null);

  const revision = turns.map(turn => `${turn.id}:${turn.status}:${turn.contextUsage?.length ?? 0}`).join('|');

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setTurnSummaries([]); setLoading(true); setError(false);
      fetch(`/api/sessions/${sessionId}/billing`, { signal: controller.signal })
        .then(response => { if (!response.ok) throw Error('billing'); return response.json(); })
        .then((value: { turns: TurnCostSummary[] }) => {
          if (!controller.signal.aborted) {
            // 后端返回 SessionCostBreakdown，包含 turns（TurnCostBreakdown 数组）
            setTurnSummaries(value.turns ?? []);
          }
        })
        .catch(() => { if (!controller.signal.aborted) setError(true); })
        .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    }, 750);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [sessionId, revision]);

  // 也使用局部数据计算费用（如果后端数据还没加载完）
  const localBlocks = sessionBlockCosts(turns);
  const localSummaries = localBlocks.turnSummaries;

  // 优先使用后端数据，降级到本地
  const summaries = turnSummaries.length > 0 ? turnSummaries : localSummaries;

  // 计算总费用
  const totalCost = summaries.reduce((s, t) => s + t.totalCost, 0);
  const totalHistoryCost = summaries.reduce((s, t) => s + t.historyCost, 0);
  const totalNewInputCost = summaries.reduce((s, t) => s + t.newInputCost, 0);
  const totalOutputCost = summaries.reduce((s, t) => s + t.outputCost, 0);

  // 找出最大费用用于颜色缩放
  const maxCost = Math.max(...summaries.map(t => t.totalCost), Number.EPSILON);

  const toggleExpand = (turnId: string) => {
    setExpandedTurn(prev => prev === turnId ? null : turnId);
    // 同时滚动到对应 turn
    const turn = turns.find(t => t.id === turnId);
    if (turn) {
      const firstItem = turn.items[0];
      if (firstItem) {
        onSelectBlock(`turn-${turnId}`, turnId, [firstItem.id]);
      }
    }
  };

  return <aside className="billing-rail" aria-label="费用估算">
    <header>
      <span>预估会话费用</span>
      <strong>{summaries.length ? `$${totalCost.toFixed(5)}` : '—'}</strong>
      <small>USD 估算 · {summaries.length} 次交互</small>
    </header>

    <div className="billing-rail-list">
      {loading && <small className="billing-rail-hint">费用加载中…</small>}
      {error && <small className="billing-rail-hint billing-rail-error">加载失败，使用本地预估</small>}

      {/* 费用构成头部摘要 */}
      {summaries.length > 0 && (
        <div className="billing-summary-legend">
          <div className="billing-legend-row">
            <span className="billing-legend-dot billing-dot-history" />
            <small>历史（缓存）</small>
            <small>{money(totalHistoryCost)}</small>
            <small className="billing-legend-pct">{pct(totalHistoryCost, totalCost)}</small>
          </div>
          <div className="billing-legend-row">
            <span className="billing-legend-dot billing-dot-newInput" />
            <small>新输入</small>
            <small>{money(totalNewInputCost)}</small>
            <small className="billing-legend-pct">{pct(totalNewInputCost, totalCost)}</small>
          </div>
          <div className="billing-legend-row">
            <span className="billing-legend-dot billing-dot-output" />
            <small>输出</small>
            <small>{money(totalOutputCost)}</small>
            <small className="billing-legend-pct">{pct(totalOutputCost, totalCost)}</small>
          </div>
        </div>
      )}

      {/* 每 turn 费用卡片 */}
      {summaries.map((turn, index) => {
        const isExpanded = expandedTurn === turn.turnId;
        return (
          <Fragment key={turn.turnId}>
            {(index === 0 || turn.turnIndex !== summaries[index - 1].turnIndex - 1) &&
              <div className="billing-segment-divider">第 {turn.turnIndex + 1} 轮</div>}
            <button
              className={`billing-rail-turn ${isExpanded ? 'billing-turn-expanded' : ''}`}
              onClick={() => toggleExpand(turn.turnId)}
              aria-expanded={isExpanded}
            >
              {/* 三部分费用条形 */}
              <div className="billing-cost-bars">
                {turn.historyCost > 0 && (
                  <div
                    className="billing-bar billing-bar-history"
                    style={{ flex: turn.historyCost / maxCost }}
                    title={`历史上下文: ${money(turn.historyCost)} (缓存费率)`}
                  >
                    <span className="billing-bar-label">历史</span>
                  </div>
                )}
                {turn.newInputCost > 0 && (
                  <div
                    className="billing-bar billing-bar-newInput"
                    style={{ flex: turn.newInputCost / maxCost }}
                    title={`新输入: ${money(turn.newInputCost)} (非缓存费率)`}
                  >
                    <span className="billing-bar-label">输入</span>
                  </div>
                )}
                {turn.outputCost > 0 && (
                  <div
                    className="billing-bar billing-bar-output"
                    style={{ flex: turn.outputCost / maxCost }}
                    title={`输出: ${money(turn.outputCost)}`}
                  >
                    <span className="billing-bar-label">输出</span>
                  </div>
                )}
              </div>

              {/* Turn 行信息 */}
              <div className="billing-turn-row">
                <span className="billing-turn-num">#{turn.turnIndex + 1}</span>
                <span className="billing-turn-cost">{money(turn.totalCost)}</span>
              </div>

              {/* 展开后的详情 */}
              {isExpanded && (
                <div className="billing-turn-detail">
                  <div className="billing-detail-row">
                    <span>历史上下文（缓存）</span>
                    <span>{money(turn.historyCost)}</span>
                  </div>
                  <div className="billing-detail-row">
                    <span>新输入（非缓存）</span>
                    <span>{money(turn.newInputCost)}</span>
                  </div>
                  <div className="billing-detail-row">
                    <span>输出</span>
                    <span>{money(turn.outputCost)}</span>
                  </div>
                  <hr className="billing-detail-divider" />
                  <div className="billing-detail-row billing-detail-total">
                    <span>小计</span>
                    <span>{money(turn.totalCost)}</span>
                  </div>
                  <small className="billing-detail-reason">{turn.summary}</small>
                </div>
              )}
            </button>
          </Fragment>
        );
      })}

      {!summaries.length && !loading && (
        <p className="billing-rail-empty">
          {turns.length === 0 ? '暂无对话记录' : '费用计算中…'}
        </p>
      )}
    </div>

    <footer>
      <span className="billing-rail-gradient" />
      <div className="billing-footer-legend">
        <span className="billing-legend-dot billing-dot-history" /> 历史（缓存）
        <span className="billing-legend-dot billing-dot-newInput" /> 新输入
        <span className="billing-legend-dot billing-dot-output" /> 输出
      </div>
      <small>费用为基于 OpenAI tiktoken 的预估，假设始终使用提示缓存</small>
    </footer>
  </aside>;
}