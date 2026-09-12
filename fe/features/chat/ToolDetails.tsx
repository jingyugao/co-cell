import { useState } from 'react';
import type { ThreadItem } from '../../../protocol/agent-protocol';
import './ToolDetails.css';

type View = 'input' | 'output' | 'raw';
const labels: Record<View, string> = { input: '输入参数', output: '输出结果', raw: '事件 JSON' };

function inspect(item: ThreadItem): { input?: unknown; output?: unknown; note?: string } {
  switch (item.type) {
    case 'mcp_tool_call': return { input: item.arguments, output: { status: item.status, result: item.result, error: item.error } };
    case 'command_execution': return {
      input: { command: item.command },
      output: { status: item.status, exit_code: item.exit_code, aggregated_output: item.aggregated_output },
      note: '执行摘要提供的是执行命令，未包含原始工具调用的全部参数。',
    };
    case 'file_change': return {
      output: { changes: item.changes, status: item.status },
      note: '这里展示文件变更摘要。实际 apply_patch 补丁请在顶部「原始工具消息」中查看。',
    };
    case 'web_search': return { input: { query: item.query }, note: '执行摘要提供搜索词，未提供搜索结果正文。' };
    default: {
      const raw = item as unknown as Record<string, unknown>;
      return { input: raw.arguments, output: raw.result, note: '完整 JSON 展示平台归并后的 item 字段。' };
    }
  }
}

export default function ToolDetails({ item }: { item: ThreadItem }) {
  const fields = inspect(item);
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<View>(fields.input === undefined ? 'raw' : 'input');
  const [copyStatus, setCopyStatus] = useState('');
  const value = view === 'raw' ? item : view === 'input' ? fields.input : fields.output;
  // JSON work is deferred until expanded, including for large command outputs.
  const json = open && value !== undefined ? JSON.stringify(value, null, 2) : undefined;
  async function copy() {
    if (json === undefined) return;
    try { await navigator.clipboard.writeText(json); setCopyStatus('已复制'); }
    catch { setCopyStatus('复制失败，请手动选择下方内容'); }
  }
  return <details className="tool-inspector" onToggle={event => { setOpen(event.currentTarget.open); setCopyStatus(''); }}>
    <summary>参数与执行摘要</summary>
    {open && <div className="tool-inspector-body">
      <div className="tool-inspector-meta"><code>{item.type}</code><span>ID: {item.id}</span></div>
      <div className="tool-inspector-toolbar">
        <div role="group" aria-label="工具数据视图">
          {(Object.keys(labels) as View[]).map(key => <button key={key} type="button" aria-pressed={view === key} onClick={() => { setView(key); setCopyStatus(''); }}>{labels[key]}</button>)}
        </div>
        <button type="button" disabled={json === undefined} onClick={() => void copy()}>复制 JSON</button>
      </div>
      <div className="tool-inspector-note">{view === 'raw' ? '这是平台归并后的执行事件快照。Agent 的实际工具调用和返回结果请查看顶部「原始工具消息」。' : fields.note}</div>
      {json === undefined ? <p className="tool-inspector-empty">执行摘要未提供{labels[view]}字段。可在顶部「原始工具消息」查看实际调用记录。</p> : <pre aria-label={labels[view]}><code>{json}</code></pre>}
      {copyStatus && <div className="tool-inspector-note" role="status">{copyStatus}</div>}
    </div>}
  </details>;
}
