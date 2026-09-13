import { useEffect, useMemo, useState } from 'react';
import type { RawToolMessage, RawToolPage } from '../../../protocol/types';
import './RawToolMessages.css';

type ToolExchange = { key: string; call?: RawToolMessage; outputs: RawToolMessage[] };
type View = 'input' | 'output' | 'raw';
const labels: Record<View, string> = { input: '原始输入', output: '原始输出', raw: '消息 JSON' };
const isCall = (message: RawToolMessage) => message.payload.type === 'function_call' || message.payload.type === 'custom_tool_call';

function groupMessages(messages: RawToolMessage[]): ToolExchange[] {
  const groups: ToolExchange[] = [];
  const byCallId = new Map<string, ToolExchange>();
  for (const message of messages) {
    const callId = message.payload.call_id;
    let group = callId ? byCallId.get(callId) : undefined;
    if (!group || (isCall(message) && group.call)) {
      group = { key: message.id, outputs: [] };
      groups.push(group);
      if (callId) byCallId.set(callId, group);
    }
    if (isCall(message)) group.call = message;
    else group.outputs.push(message);
  }
  return groups;
}

function display(value: unknown): string | undefined {
  return typeof value === 'string' ? value : value === undefined ? undefined : JSON.stringify(value, null, 2);
}

function ToolExchangeView({ exchange, initiallyOpen }: { exchange: ToolExchange; initiallyOpen: boolean }) {
  const [open, setOpen] = useState(initiallyOpen);
  const [view, setView] = useState<View>(exchange.call ? 'input' : 'output');
  const [copyStatus, setCopyStatus] = useState('');
  const { call, outputs } = exchange;
  const callId = call?.payload.call_id || outputs[0]?.payload.call_id;
  const name = call?.payload.name || (call ? call.payload.type : '工具输出（未找到调用）');
  const input = call?.payload.input ?? call?.payload.arguments;
  const records = call ? [call, ...outputs] : outputs;
  const copyText = open ? view === 'input' ? input
    : view === 'output' ? (outputs.length === 1 ? display(outputs[0].payload.output) : outputs.length ? JSON.stringify(outputs.map(record => record.payload.output), null, 2) : undefined)
      : JSON.stringify(records.map(record => record.payload), null, 2) : undefined;
  async function copy(value: string | undefined) {
    if (value === undefined) return;
    try { await navigator.clipboard.writeText(value); setCopyStatus('已复制'); }
    catch { setCopyStatus('复制失败，请手动选择内容'); }
  }
  return <details className="raw-tool-exchange" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary><span className="raw-tool-chevron">›</span><strong>{name}</strong><span className="raw-tool-output-status">{outputs.length ? '已收到输出' : '尚未收到输出'}</span></summary>
    {open && <div className="raw-tool-exchange-body">
      <div className="raw-tool-meta"><code>{call?.payload.type || outputs[0]?.payload.type}</code>{callId && <span>call_id: <code>{callId}</code></span>}{(call?.timestamp || outputs[0]?.timestamp) && <time>{call?.timestamp || outputs[0]?.timestamp}</time>}</div>
      <div className="raw-tool-toolbar"><div role="group" aria-label={`${name} 消息视图`}>{(Object.keys(labels) as View[]).map(key => <button type="button" key={key} aria-pressed={view === key} onClick={() => { setView(key); setCopyStatus(''); }}>{labels[key]}</button>)}</div><button type="button" disabled={copyText === undefined} onClick={() => void copy(copyText)}>{view === 'raw' ? '复制全部 JSON' : '复制内容'}</button></div>
      {view === 'input' && (input === undefined ? <p className="raw-tool-note">{call ? '该调用消息没有 input 或 arguments 字段。' : '日志中尚未找到对应的调用消息。'}</p> : <><p className="raw-tool-note">字段：{call?.payload.input !== undefined ? 'input' : 'arguments'} · 保留原始字符串</p><pre aria-label="原始输入"><code>{input}</code></pre></>)}
      {view === 'output' && (outputs.length ? outputs.map(record => <div className="raw-tool-record" key={record.id}><p className="raw-tool-note">{record.payload.type}{record.timestamp ? ` · ${record.timestamp}` : ''}</p>{record.payload.output === undefined ? <p className="raw-tool-note">消息没有 output 字段，请查看消息 JSON。</p> : <pre aria-label="原始输出"><code>{display(record.payload.output)}</code></pre>}</div>) : <p className="raw-tool-note">尚未收到输出。面板会继续读取日志，这不表示工具仍在运行。</p>)}
      {view === 'raw' && <><p className="raw-tool-note">会话记录中的工具 payload，保留原始字段和值；JSON 缩进仅用于阅读。</p>{records.map(record => <div className="raw-tool-record" key={record.id}><div className="raw-tool-record-heading"><code>{record.payload.type}</code><button type="button" onClick={() => void copy(JSON.stringify(record.payload, null, 2))}>复制此消息</button></div><pre aria-label={`${record.payload.type} JSON`}><code>{JSON.stringify(record.payload, null, 2)}</code></pre></div>)}</>}
      {copyStatus && <p className="raw-tool-note" role="status">{copyStatus}</p>}
    </div>}
  </details>;
}

export default function RawToolMessages({ sessionId, onClose }: { sessionId: string | null; onClose: () => void }) {
  const [messages, setMessages] = useState<RawToolMessage[]>([]);
  const [availability, setAvailability] = useState<RawToolPage['availability']>('pending');
  const [threadId, setThreadId] = useState<string | null>(null);
  const [location, setLocation] = useState<'local' | 'sandbox'>('local');
  const [sandboxId, setSandboxId] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [skippedLines, setSkippedLines] = useState(0);
  const [reload, setReload] = useState(0);
  const groups = useMemo(() => groupMessages(messages), [messages]);

  useEffect(() => {
    setMessages([]); setAvailability('pending'); setThreadId(null); setLocation('local'); setSandboxId(undefined); setError(''); setSkippedLines(0); setLoading(Boolean(sessionId));
    if (!sessionId) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cursor = 0;
    const seen = new Set<string>();
    async function poll() {
      try {
        let hasMore = true;
        while (hasMore && !controller.signal.aborted) {
          const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId!)}/raw-tools?cursor=${cursor}`, { signal: controller.signal });
          const body = await response.json();
          if (!response.ok) throw new Error(body.error || `请求失败 (${response.status})`);
          if (controller.signal.aborted) return;
          const page = body as RawToolPage;
          setAvailability(page.availability); setThreadId(page.threadId); setLocation(page.location || 'local'); setSandboxId(page.sandboxId); setError('');
          const fresh = page.messages.filter(record => { if (seen.has(record.id)) return false; seen.add(record.id); return true; });
          if (fresh.length) setMessages(current => [...current, ...fresh]);
          if (page.nextCursor > cursor) setSkippedLines(current => current + page.skippedLines);
          hasMore = page.hasMore && page.nextCursor > cursor;
          cursor = page.nextCursor;
        }
      } catch (err) {
        if (!controller.signal.aborted) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!controller.signal.aborted) { setLoading(false); timer = setTimeout(() => void poll(), 1500); }
      }
    }
    void poll();
    return () => { controller.abort(); if (timer) clearTimeout(timer); };
  }, [sessionId, reload]);

  return <aside className="raw-tools-panel" aria-label="原始工具消息">
    <header className="raw-tools-heading"><h2>原始工具消息</h2><button type="button" disabled={!sessionId} onClick={() => setReload(value => value + 1)} title="从头重新读取会话日志">重新读取</button><button type="button" className="icon-button" aria-label="关闭原始工具消息" onClick={onClose}>✕</button></header>
    <div className="raw-tools-content"><div className="raw-tools-source"><strong>{location === 'sandbox' ? 'Codex Sandbox 会话记录' : 'Codex 本机会话记录'}</strong><p>展示 Agent 实际发出的工具调用及返回结果：包含 exec 输入代码、函数参数和输出。按 call_id 关联，独立于 页面的执行摘要。</p>{sandboxId && <p className="raw-tools-thread">Sandbox: <code>{sandboxId}</code></p>}{threadId && <p className="raw-tools-thread">Thread: <code>{threadId}</code></p>}<span>{messages.length} 条消息 · {groups.length} 组调用 / 输出{sessionId && ' · 每 1.5 秒刷新'}</span></div>
      {error && <div className="inline-error" role="alert">{error}<button type="button" className="raw-tool-retry" onClick={() => setReload(value => value + 1)}>重试</button></div>}
      {skippedLines > 0 && <p className="raw-tool-note">有 {skippedLines} 行日志无法解析，已跳过；已读取的工具消息仍可查看。</p>}
      {!sessionId ? <div className="raw-tools-empty">开始任务或选择已有会话后查看原始工具消息。</div>
        : loading && !messages.length ? <div className="raw-tools-empty" role="status"><span className="spinner" />正在读取原始工具消息…</div>
          : !messages.length && !error ? <div className="raw-tools-empty" role="status">{availability === 'missing' ? (location === 'sandbox' ? '未找到此任务的 Sandbox 会话记录，沙箱或记录可能已不可用。' : '未找到此会话的本机记录。记录可能已移除，或来自其他设备。') : availability === 'pending' ? '正在等待 Codex 会话记录，生成后会自动显示。' : '此会话记录中暂时没有工具调用或工具输出。'}</div> : null}
      <div className="raw-tools-list">{groups.map((exchange, index) => <ToolExchangeView key={exchange.key} exchange={exchange} initiallyOpen={index === 0} />)}</div>
    </div>
  </aside>;
}
