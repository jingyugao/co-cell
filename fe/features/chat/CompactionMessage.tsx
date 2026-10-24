import { useEffect, useState } from 'react';
import type { CompactionContent, Turn } from '../../../protocol/types';
import type { ItemStatus } from '../../../protocol/agent-protocol';
import { api } from '../../lib/api';
import Markdown, { type MarkdownResources } from './Markdown';
import './CompactionMessage.css';

type Resources = MarkdownResources & { sessionId?: string; threadId?: string };
type Props = Resources & { itemId?: string; segment?: number; summary?: string | null;
  timestamp?: string; status?: ItemStatus; turnEnded?: boolean };

export default function CompactionMessage({ itemId, segment, summary, timestamp, status = 'completed', turnEnded,
  sessionId, threadId, ...resources }: Props) {
  const [open, setOpen] = useState(false);
  const [content, setContent] = useState<CompactionContent>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const query = new URLSearchParams(itemId ? { itemId } : { segment: String(segment) });
  if (threadId) query.set('threadId', threadId);
  const url = `/api/sessions/${encodeURIComponent(sessionId ?? '')}/compaction?${query}`;

  useEffect(() => {
    if (!open || status !== 'completed' || summary !== undefined || content || !sessionId) return;
    const controller = new AbortController();
    let active = true;
    setLoading(true); setError('');
    void api<CompactionContent>(url, { signal: controller.signal }).then(value => {
      if (active) { setContent(value); setLoading(false); }
    }).catch(error => {
      if (active) { setError(error instanceof Error ? error.message : '压缩内容暂时无法加载'); setLoading(false); }
    });
    return () => { active = false; controller.abort(); };
  }, [open, status, summary, content, sessionId, url, attempt]);

  const label = status === 'in_progress' ? turnEnded ? '上下文压缩已中断' : '正在压缩上下文…'
    : status === 'failed' ? '上下文压缩失败' : '上下文已压缩';
  const body = summary !== undefined ? summary : content?.summary;
  return <div className="compaction-message">
    <div className="compact-divider" role="status"><span>{label}</span>
      {status === 'completed' && <button type="button" className="compaction-link" aria-expanded={open}
        onClick={() => setOpen(value => !value)}>{open ? '收起压缩内容' : '查看压缩内容'}</button>}
      {timestamp && <time className="message-time" dateTime={timestamp}>{new Date(timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })}</time>}
    </div>
    {open && <section className="compaction-content" aria-label="压缩内容" aria-busy={loading}>
      {loading || (summary === undefined && !content && !error && sessionId) ? <p className="muted">正在读取压缩内容…</p>
        : error ? <div role="alert"><p>{error}</p><button type="button" className="compaction-link" onClick={() => setAttempt(value => value + 1)}>重试</button></div>
          : body ? <Markdown text={body} {...resources} />
            : <p className="muted">此次压缩未保存可读摘要，可能只有加密内容，无法还原。</p>}
    </section>}
  </div>;
}

/** Rollout boundaries and streamed items can describe the same completed compact. */
export function isCompactionBoundaryItem(turn: Turn, index: number) {
  return turn.items[index]?.type === 'context_compaction'
    && Boolean(turn.compactions?.some(boundary => boundary.itemId
      ? boundary.itemId === turn.items[index].id : boundary.beforeItemIndex === index));
}

export function CompactionBoundaries({ turn, index, ...resources }: { turn: Turn; index: number } & Resources) {
  return turn.compactions?.filter(boundary => index === turn.items.length
    ? boundary.beforeItemIndex >= index : boundary.beforeItemIndex === index)
    .map(boundary => <CompactionMessage key={boundary.segment} itemId={boundary.itemId} segment={boundary.segment} summary={boundary.summary}
      timestamp={boundary.timestamp} {...resources} />);
}
