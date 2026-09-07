import type { ThreadItem } from '@openai/codex-sdk';
import type { Turn } from '../../../shared/types';
import { Icon } from '../../components/Icon';
import Markdown from './Markdown';
import ToolDetails from './ToolDetails';

export default function ItemView({ item, turnStatus, projectId }: { item: ThreadItem; turnStatus: Turn['status']; projectId?: string }) {
  const turnEnded = turnStatus === 'cancelled' || turnStatus === 'failed' || turnStatus === 'completed';
  const endedLabel = turnStatus === 'cancelled' ? '已停止' : turnStatus === 'failed' ? '已中断' : '已结束';
  switch (item.type) {
    case 'agent_message': return <div className="agent-message"><Markdown text={item.text} projectId={projectId} /></div>;
    case 'reasoning': return <details className="reasoning"><summary><span className="tiny-orbit" />思考摘要<Icon name="chevron" size={12} /></summary><Markdown text={item.text} projectId={projectId} /></details>;
    case 'command_execution': return <details className={`tool-card ${item.status === 'in_progress' && turnEnded ? 'ended' : item.status}`}><summary><Icon name="terminal" /><span className="tool-label">运行命令</span><code className="command-preview">{item.command}</code><span className="tool-state">{item.status === 'in_progress' ? (turnEnded ? endedLabel : <span className="spinner" />) : item.exit_code === 0 ? <Icon name="check" size={14} /> : `exit ${item.exit_code ?? '—'}`}</span><Icon name="chevron" size={13} /></summary><pre className="terminal-output">$ {item.command}{'\n\n'}{item.aggregated_output || (item.status === 'in_progress' && !turnEnded ? '等待命令输出…' : '（无输出）')}</pre><ToolDetails item={item} /></details>;
    case 'file_change': return <details className={`tool-card ${item.status}`} open><summary><Icon name="code" /><span>修改了 {item.changes.length} 个文件</span><span className="tool-state">{item.status === 'failed' ? '失败' : <Icon name="check" size={14} />}</span><Icon name="chevron" size={13} /></summary><div className="file-list">{item.changes.map((change, i) => <div key={i}><span className={`file-badge ${change.kind}`}>{change.kind === 'add' ? '+' : change.kind === 'delete' ? '−' : 'M'}</span><code>{change.path}</code></div>)}</div><ToolDetails item={item} /></details>;
    case 'mcp_tool_call': return <details className={`tool-card ${item.status === 'in_progress' && turnEnded ? 'ended' : item.status}`}><summary><Icon name="code" /><span>{item.server} / {item.tool}</span><span className="tool-state">{item.status === 'in_progress' ? (turnEnded ? endedLabel : <span className="spinner" />) : item.status === 'failed' ? '失败' : <Icon name="check" size={14} />}</span><Icon name="chevron" size={13} /></summary><ToolDetails item={item} /></details>;
    case 'web_search': return <details className="tool-card"><summary><Icon name="globe" /><span>搜索网页</span><span className="muted">{item.query}</span></summary><ToolDetails item={item} /></details>;
    case 'todo_list': return <div className="todo-list">{item.items.map((todo, i) => <div key={i} className={todo.completed ? 'done' : ''}><span className="todo-check">{todo.completed && <Icon name="check" size={12} />}</span>{todo.text}</div>)}</div>;
    case 'error': return <div className="inline-error">{item.message}</div>;
  }
  // Native Codex can emit item types before the SDK's TypeScript union includes them.
  const unknownItem = item as { type: string; status?: string };
  return <details className="tool-card"><summary><Icon name="code" /><span>{unknownItem.type}</span><span className="tool-state">{unknownItem.status || ''}</span><Icon name="chevron" size={13} /></summary><ToolDetails item={item} /></details>;
}
