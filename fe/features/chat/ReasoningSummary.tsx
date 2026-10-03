import type { ThreadItem } from '../../../protocol/agent-protocol';
import Markdown, { type MarkdownResources } from './Markdown';
import { Icon } from '../../components/Icon';
import './ReasoningSummary.css';

type ReasoningItem = Extract<ThreadItem, { type: 'reasoning' }>;
export { groupThreadItems } from '../../../util/thread-item-groups';

export default function ReasoningSummary({ entries, pending = false, ...resources }: {
  entries: { item: ReasoningItem; timestamp?: string; anchorId?: string; highlighted?: boolean }[];
  pending?: boolean;
} & MarkdownResources) {
  if (!entries.length) return null;
  const visible = entries.filter(entry => entry.item.text.trim());
  const latest = visible.at(-1) ?? entries.at(-1)!;
  const preview = latest.item.text.replace(/(?:^|\n)\s{0,3}#{1,6}\s+/g, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1').replace(/\s+/g, ' ').trim();
  const time = (timestamp?: string) => timestamp && Number.isFinite(Date.parse(timestamp))
    ? <time className="message-time" dateTime={timestamp}>{new Date(timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })}</time> : null;
  const className = `reasoning reasoning-summary${entries.some(entry => entry.highlighted) ? ' billing-item-selected' : ''}`;
  const anchors = entries.map(entry => entry.anchorId && <span key={entry.item.id} id={entry.anchorId} className="reasoning-anchor" aria-hidden="true" />);
  if (!visible.length) return <div className={`${className} reasoning-unavailable`} role={pending ? 'status' : undefined}>
    {anchors}
    <div className="reasoning-summary-heading">{pending ? <span className="spinner" /> : <span className="tiny-orbit" />}<span>{pending ? '正在思考…' : '思考过程'}</span>{entries.length > 1 && <span className="reasoning-count">{entries.length} 段</span>}{time(latest.timestamp)}</div>
    <p className="reasoning-unavailable-note">{pending ? '模型尚未提供可显示的摘要' : '模型未提供可显示的摘要'}</p>
  </div>;
  return <details className={className}>
    <summary>
      {anchors}
      <span className="reasoning-summary-heading">{pending ? <span className="spinner" /> : <span className="tiny-orbit" />}<span>{pending ? '正在思考…' : '思考摘要'}</span>{visible.length > 1 && <span className="reasoning-count">{visible.length} 段</span>}<Icon name="chevron" size={12} />{time(latest.timestamp)}</span>
      <span className="reasoning-preview">{preview}</span>
    </summary>
    <div className="reasoning-summary-content">{visible.map((entry, index) => <section key={entry.item.id} className={entry.highlighted ? 'billing-item-selected' : undefined}>
      {visible.length > 1 && <div className="reasoning-entry-heading"><span>第 {index + 1} 段</span>{time(entry.timestamp)}</div>}
      <Markdown text={entry.item.text} {...resources} />
    </section>)}{visible.length < entries.length && <p className="reasoning-unavailable-note">另有 {entries.length - visible.length} 段未提供可显示的摘要</p>}</div>
  </details>;
}
