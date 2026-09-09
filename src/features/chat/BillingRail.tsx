import type { Turn } from '../../../shared/types';
import { MODEL_TOKEN_RATES } from '../../../shared/model-costs';
import './BillingRail.css';

const money = (value: number | null) => value === null ? '未知' : `$${value.toFixed(7)}`;
export default function BillingRail({ turns, selectedBlockId, onSelectBlock }: {
  turns: Turn[]; selectedBlockId?: string;
  onSelectBlock: (blockId: string, turnId: string, itemIds?: string[]) => void;
}) {
  const calls = turns.flatMap(turn => (turn.contextUsage ?? []).map((call, index) => {
    const rates = call.model ? MODEL_TOKEN_RATES[call.model] : undefined;
    const cached = call.cachedInputTokens;
    const input = rates && cached !== undefined ? ((call.inputTokens - Math.min(cached, call.inputTokens)) * rates.inputUsdPerMillion + Math.min(cached, call.inputTokens) * rates.cachedInputUsdPerMillion) / 1e6 : null;
    const output = rates && call.outputTokens !== undefined ? call.outputTokens * rates.outputUsdPerMillion / 1e6 : null;
    const outputIds = call.outputItemIds?.filter(id => turn.items.some(item => item.id === id)) ?? [];
    let inputIds: string[] = [];
    if (index === 0) inputIds = ['user-input'];
    else {
      const previous = turn.contextUsage?.[index - 1];
      const previousPositions = (previous?.outputItemIds ?? []).map(id => turn.items.findIndex(item => item.id === id)).filter(position => position >= 0);
      const nextPositions = outputIds.map(id => turn.items.findIndex(item => item.id === id));
      const last = Math.max(...previousPositions, -1);
      const next = Math.min(...nextPositions, turn.items.length);
      if (last >= 0) inputIds = turn.items.slice(last, Math.max(last + 1, next)).map(item => item.id);
    }
    return { call, turn, outputIds, inputIds, id: `${turn.id}:${call.responseId ?? call.requestId ?? index}`, input, output };
  }));
  const total = calls.reduce((sum, row) => sum + (row.input ?? 0) + (row.output ?? 0), 0);
  const partial = calls.some(row => row.input === null || row.output === null);
  const maximum = Math.max(...calls.flatMap(row => [row.input ?? 0, row.output ?? 0]), Number.EPSILON);
  const selected = calls.find(row => selectedBlockId === `${row.id}:input` || selectedBlockId === `${row.id}:output`);
  const direction = selectedBlockId?.endsWith(':input') ? 'input' : 'output';
  return <aside className="billing-rail" aria-label="每次调用输入输出费用">
    <header><span>会话费用</span><strong>{calls.length ? `$${total.toFixed(5)}` : '—'}</strong><small>{partial ? '已知小计' : '总费用'} · USD 估算</small></header>
    <div className="billing-rail-list">
      <div className="billing-call-labels"><span /> <span>入</span><span>出</span></div>
      {calls.map((row, index) => <div className="billing-call-row" key={row.id}><span>{index + 1}</span>{(['input', 'output'] as const).map(side => {
        const cost = row[side];
        const title = `Call ${index + 1} · ${side === 'input' ? '输入' : '输出'} ${money(cost)}\n${side === 'input' ? `输入 ${row.call.inputTokens}，缓存 ${row.call.cachedInputTokens ?? '未知'}` : `输出 ${row.call.outputTokens ?? '未知'}`} tokens`;
        return <button key={side} title={title} aria-label={title} aria-pressed={selectedBlockId === `${row.id}:${side}`}
          className={cost === null ? 'unknown' : undefined}
          style={cost === null ? undefined : { backgroundColor: `rgb(84 108 55 / ${0.15 + cost / maximum * 0.85})` }}
          onClick={() => onSelectBlock(`${row.id}:${side}`, row.turn.id, side === 'output' ? row.outputIds : row.inputIds)} />;
      })}</div>)}
      {!calls.length && <p className="billing-rail-empty">等待调用记录</p>}
      {selected && <section className="billing-call-detail"><strong>{direction === 'input' ? '输入上下文' : '生成内容'}</strong><p>{money(selected[direction])}</p>
        <small>{direction === 'input' ? `输入 ${selected.call.inputTokens} · 缓存 ${selected.call.cachedInputTokens ?? '未知'}` : `输出 ${selected.call.outputTokens ?? '未知'}`} tokens</small>
        <ul>{selected.call.blockEstimates?.filter(block => (direction === 'input' ? block.inputTokens : block.outputTokens) > 0).map(block => <li key={block.id} title={block.label}>{block.label}</li>)}</ul>
        <small>列出可恢复内容摘要；费用按本次实际用量计算。</small>
      </section>}
    </div>
    <footer><span className="billing-rail-gradient" />每行一次调用 · 左入右出<small>颜色越深，费用越高</small><small>实际 token × 配置单价</small></footer>
  </aside>;
}
