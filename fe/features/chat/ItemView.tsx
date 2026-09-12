import type { ThreadItem } from '../../../protocol/agent-protocol';
import type { ReactNode } from 'react';
import type { Turn } from '../../../protocol/types';
import type { UserApprovalInput } from '../../../protocol/approval-types';
import { Icon } from '../../components/Icon';
import Markdown, { MarkdownLink, type MarkdownResources } from './Markdown';
import ToolDetails from './ToolDetails';
import { UserApprovalDetails } from './UserApprovalCard';

function approvalInput(value: unknown): UserApprovalInput | null {
  if (!value || typeof value !== 'object') return null;
  const input = value as Record<string, unknown>;
  if (typeof input.title !== 'string' || typeof input.target !== 'string' || typeof input.action !== 'string' || typeof input.impact !== 'string') return null;
  return { title: input.title, target: input.target, action: input.action, impact: input.impact };
}

const formatTime = (value?: string) => value && Number.isFinite(Date.parse(value))
  ? new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) : '';

export default function ItemView({ item, turnStatus, timestamp, projectId, workingDirectory, onOpenFile }: { item: ThreadItem; turnStatus: Turn['status']; timestamp?: string } & MarkdownResources) {
  const resources = { projectId, workingDirectory, onOpenFile };
  const time = formatTime(timestamp);
  const withTime = (node: ReactNode) => <>{node}{time && <time className="message-time" dateTime={timestamp}>{time}</time>}</>;
  const turnEnded = turnStatus === 'cancelled' || turnStatus === 'failed' || turnStatus === 'completed';
  const endedLabel = turnStatus === 'cancelled' ? '已停止' : turnStatus === 'failed' ? '已中断' : '已结束';
  switch (item.type) {
    case 'context_compaction': return <div className="compact-divider" role="status">{withTime(<>{item.status === 'in_progress' ? (turnEnded ? '上下文压缩已中断' : '正在压缩上下文…') : item.status === 'failed' ? '上下文压缩失败' : '上下文已压缩'}</>)}</div>;
    case 'agent_message': return <div className="agent-message">{withTime(<Markdown text={item.text} {...resources} />)}</div>;
    case 'reasoning': return <details className="reasoning"><summary><span className="tiny-orbit" />思考摘要<Icon name="chevron" size={12} />{time && <time className="message-time" dateTime={timestamp}>{time}</time>}</summary><Markdown text={item.text} {...resources} /></details>;
    case 'command_execution': return <details className={`tool-card ${item.status === 'in_progress' && turnEnded ? 'ended' : item.status}`}><summary><Icon name="terminal" /><span className="tool-label">运行命令</span><code className="command-preview">{item.command}</code><span className="tool-state">{item.status === 'in_progress' ? (turnEnded ? endedLabel : <span className="spinner" />) : item.exit_code === 0 ? <Icon name="check" size={14} /> : `exit ${item.exit_code ?? '—'}`}</span><Icon name="chevron" size={13} /></summary><pre className="terminal-output">$ {item.command}{'\n\n'}{item.aggregated_output || (item.status === 'in_progress' && !turnEnded ? '等待命令输出…' : '（无输出）')}</pre><ToolDetails item={item} /></details>;
    case 'file_change': return <details className={`tool-card ${item.status}`} open><summary><Icon name="code" /><span>修改了 {item.changes.length} 个文件</span><span className="tool-state">{item.status === 'failed' ? '失败' : <Icon name="check" size={14} />}</span><Icon name="chevron" size={13} /></summary><div className="file-list">{item.changes.map((change, i) => <div key={i}><span className={`file-badge ${change.kind}`}>{change.kind === 'add' ? '+' : change.kind === 'delete' ? '−' : 'M'}</span><MarkdownLink href={(change.path.startsWith('/') ? change.path : `./${change.path}`).split('/').map(encodeURIComponent).join('/')} resources={resources}><code>{change.path}</code></MarkdownLink></div>)}</div><ToolDetails item={item} /></details>;
    case 'mcp_tool_call': {
      const approval = item.server === 'swarm_approvals' && item.tool === 'request_user_approval' ? approvalInput(item.arguments) : null;
      return <details className={`tool-card ${item.status === 'in_progress' && turnEnded ? 'ended' : item.status}`} open={approval ? true : undefined}><summary><Icon name="code" /><span>{approval ? `请求用户确认：${approval.title}` : `${item.server} / ${item.tool}`}</span><span className="tool-state">{item.status === 'in_progress' ? (turnEnded ? endedLabel : approval ? '等待审核' : <span className="spinner" />) : item.status === 'failed' ? '失败' : approval ? '审核已返回' : <Icon name="check" size={14} />}</span><Icon name="chevron" size={13} /></summary>{approval && <div className="user-approval-card"><UserApprovalDetails approval={approval} {...resources} /></div>}<ToolDetails item={item} /></details>;
    }
    case 'web_search': return <details className="tool-card"><summary><Icon name="globe" /><span>搜索网页</span><span className="muted">{item.query}</span></summary><ToolDetails item={item} /></details>;
    case 'todo_list': return <div className="todo-list">{item.items.map((todo, i) => <div key={i} className={todo.completed ? 'done' : ''}><span className="todo-check">{todo.completed && <Icon name="check" size={12} />}</span>{todo.text}</div>)}</div>;
    case 'error': return <div className="inline-error">{item.message}</div>;
  }
  // Preserve visibility if the server emits a newly supported item type.
  const unknownItem = item as { type: string; status?: string };
  return <details className="tool-card"><summary><Icon name="code" /><span>{unknownItem.type}</span><span className="tool-state">{unknownItem.status || ''}</span><Icon name="chevron" size={13} /></summary><ToolDetails item={item} /></details>;
}
