import { useEffect, useRef } from 'react';
import type { Turn } from '../../../protocol/types';
import type { ToolItem } from '../../../util/thread-item-groups';
import type { MarkdownResources } from './Markdown';
import { Icon } from '../../components/Icon';
import ItemView from './ItemView';
import './ToolCallGroup.css';

export default function ToolCallGroup({ entries, turnStatus, ...resources }: {
  entries: { item: ToolItem; timestamp?: string; anchorId?: string; highlighted?: boolean }[];
  turnStatus: Turn['status'];
} & MarkdownResources) {
  const details = useRef<HTMLDetailsElement>(null);
  const highlightedAnchor = entries.find(entry => entry.highlighted)?.anchorId;
  useEffect(() => {
    if (!highlightedAnchor || !details.current) return;
    details.current.open = true;
    document.getElementById(highlightedAnchor)?.scrollIntoView({ block: 'nearest' });
  }, [highlightedAnchor]);

  const pending = entries.some(({ item }) => 'status' in item && item.status === 'in_progress');
  const running = pending && turnStatus === 'running';
  const failed = entries.filter(({ item }) => 'status' in item && (item.status === 'failed'
    || item.type === 'command_execution' && item.status === 'completed' && item.exit_code != null && item.exit_code !== 0)).length;
  const status = running ? '执行中' : pending
    ? (turnStatus === 'cancelled' ? '已停止' : turnStatus === 'failed' ? '已中断' : '已结束') : '已完成';
  const latest = entries.at(-1)?.item;
  const preview = latest?.type === 'command_execution' ? latest.command : latest?.type === 'mcp_tool_call'
    ? `${latest.server} / ${latest.tool}` : latest?.type === 'web_search' ? latest.query : latest ? `修改 ${latest.changes.length} 个文件` : '';
  return <details ref={details} className={`tool-call-group${running ? ' running' : ''}${failed ? ' failed' : ''}`}>
    <summary>
      <span className="tool-call-group-heading"><Icon name="terminal" size={16} /><strong>工具调用</strong><span className="tool-call-count">{entries.length} 次</span><span className="tool-call-group-state">{running && <span className="spinner" />}{status}{failed > 0 && <span className="tool-call-failures">{failed} 次失败</span>}</span><Icon name="chevron" size={14} /></span>
      {preview && <span className="tool-call-group-preview">{preview}</span>}
    </summary>
    <div className="tool-call-group-content">{entries.map(entry => <div key={entry.item.id} id={entry.anchorId} className={entry.highlighted ? 'billing-item-selected' : undefined}>
      <ItemView item={entry.item} turnStatus={turnStatus} timestamp={entry.timestamp} {...resources} />
    </div>)}</div>
  </details>;
}
