import { Fragment, useEffect, useState } from 'react';
import type { Turn } from '../../../protocol/types';
import { sessionBlockCosts } from '../../../util/block-costs';
import { estimateTokenCostUsd } from '../../../util/model-costs';
import './BillingRail.css';

const money = (value: number | null) => value === null ? '未知' : `$${value.toFixed(7)}`;
export default function BillingRail({ turns, sessionId, selectedBlockId, onSelectBlock }: {
  turns: Turn[]; sessionId: string; selectedBlockId?: string;
  onSelectBlock: (blockId: string, turnId: string, itemIds?: string[]) => void;
}) {
  const [details, setDetails] = useState<Turn[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const revision = turns.map(turn => `${turn.id}:${turn.status}:${turn.contextUsage?.length ?? 0}`).join('|');
  useEffect(() => {
    const controller = new AbortController();
    // The transcript is the primary content. Let it paint before the optional,
    // potentially expensive attribution pass starts; a stream update or route
    // change cancels the pending/read request.
    const timer = window.setTimeout(() => {
      setDetails([]); setLoading(true); setError(false);
      fetch(`/api/sessions/${sessionId}/billing`, { signal: controller.signal })
        .then(response => { if (!response.ok) throw Error('billing'); return response.json(); })
        .then(value => { if (!controller.signal.aborted) setDetails(value); })
        .catch(() => { if (!controller.signal.aborted) setError(true); })
        .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    }, 750);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [sessionId, revision]);
  const mapped = details.map(turn => ({ ...turn, nativeTurnId: turn.id,
    id: turns.find(value => (value.nativeTurnId ?? value.id) === turn.id)?.id ?? turn.id }));
  const { blocks, unassigned } = sessionBlockCosts(mapped);
  const costs = turns.flatMap(turn => (turn.contextUsage ?? []).map(call => estimateTokenCostUsd(call.model, call)));
  const total = costs.reduce<number>((sum, value) => sum + (value ?? 0), 0);
  const maximum = Math.max(...blocks.flatMap(block => [block.inputCost, block.outputCost]), Number.EPSILON);
  const selected = blocks.find(block => selectedBlockId === `${block.id}:input` || selectedBlockId === `${block.id}:output`);
  const direction = selectedBlockId?.endsWith(':input') ? 'input' : 'output';
  return <aside className="billing-rail" aria-label="消息自身费用估算">
    <header><span>整个会话费用</span><strong>{costs.length ? `$${total.toFixed(5)}` : '—'}</strong><small>{costs.some(value => value === null) ? '已知小计' : '总费用'} · USD 估算</small></header>
    <div className="billing-rail-list">
      <small>{loading ? '消息费用加载中…' : error ? '消息费用加载失败，不影响对话' : ''}</small>
      <div className="billing-call-labels"><span /> <span>入</span><span>出</span></div>
      {blocks.map((block, index) => <Fragment key={block.id}>
        {(index === 0 || block.segment !== blocks[index - 1].segment) && <div className="billing-segment-divider">第 {block.segment + 1} 段 · 消息自身费用</div>}
        <div className="billing-call-row"><span>{index + 1}</span>{(['input', 'output'] as const).map(side => {
          const cost = side === 'input' ? block.inputCost : block.outputCost;
          const title = `${block.label}\n此内容累计${side === 'input' ? '输入' : '输出'}费用（估算）：${money(cost)}\n本地文本 ${block.tokens} tokens · 参与 ${block.calls} 次调用`;
          return <button key={side} title={title} aria-label={title} aria-pressed={selectedBlockId === `${block.id}:${side}`}
            style={{ backgroundColor: `rgb(84 108 55 / ${0.15 + cost / maximum * 0.85})` }}
            onClick={() => onSelectBlock(`${block.id}:${side}`, block.turnId, block.itemId ? [block.itemId] : [])} />;
        })}</div>
      </Fragment>)}
      {!blocks.length && !loading && <p className="billing-rail-empty">暂无消息费用记录</p>}
      {selected && <section className="billing-call-detail"><strong>这段内容自身的费用</strong><p>{selected.label}</p>
        <p>{direction === 'input' ? '累计输入' : '累计输出'}：{money(direction === 'input' ? selected.inputCost : selected.outputCost)}</p>
        <small>文本 {selected.tokens} tokens · 参与 {selected.calls} 次调用</small>
        <p>输入包含后续作为历史上下文被携带的费用；不包含其他消息。</p>
        <small>本地 token 估算，缓存按每次调用的实际缓存比例分摊，非逐消息实际账单。</small>
      </section>}
      {!!blocks.length && <p className="billing-rail-empty">未归属开销：{money(unassigned)}</p>}
    </div>
    <footer><span className="billing-rail-gradient" />每行一段内容 · 左入右出<small>颜色表示该内容累计费用</small><small>逐消息费用为估算</small></footer>
  </aside>;
}
