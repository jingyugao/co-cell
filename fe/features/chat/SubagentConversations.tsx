import { useEffect, useState } from 'react';
import type { SubagentConversation } from '../../../protocol/types';
import { Icon } from '../../components/Icon';
import { api } from '../../lib/api';
import type { MarkdownResources } from './Markdown';
import ItemView from './ItemView';
import './SubagentConversations.css';

export function useSubagentConversations(sessionId: string | null, running: boolean) {
  const [agents, setAgents] = useState<SubagentConversation[]>([]);
  const [error, setError] = useState(false);
  useEffect(() => {
    setAgents([]); setError(false);
    if (!sessionId) return;
    let active = true;
    const refresh = () => { void api<SubagentConversation[]>(`/api/sessions/${sessionId}/subagents`)
      .then(value => { if (active) { setAgents(value); setError(false); } })
      .catch(() => { if (active) setError(true); }); };
    refresh();
    if (running) {
      const timer = setInterval(refresh, 5000);
      return () => { active = false; clearInterval(timer); };
    }
    return () => { active = false; };
  }, [sessionId, running]);
  return { agents, error };
}

const stateLabel = (agent: SubagentConversation) => {
  const state = agent.turns.at(-1)?.status;
  return state === 'completed' ? '已完成' : state === 'failed' ? '失败' : state === 'cancelled' ? '已停止' : '执行中';
};

export default function SubagentConversations({ agents, ...resources }: { agents: SubagentConversation[] } & MarkdownResources) {
  if (!agents.length) return null;
  return <section className="subagent-group" aria-label="子代理对话">
    <div className="subagent-group-title"><Icon name="chat" size={15} /><strong>子代理对话</strong><span>{agents.length}</span></div>
    {agents.map(agent => <details key={agent.threadId} className="subagent-card">
      <summary><span className="subagent-avatar">{agent.path.split('/').at(-1)?.slice(0, 1).toUpperCase() || 'A'}</span><span className="subagent-identity"><strong>{agent.path.split('/').at(-1)}</strong><small>{agent.nickname ? `${agent.nickname} · ` : ''}{agent.path}</small></span><span className={`subagent-status ${agent.turns.at(-1)?.status ?? 'running'}`}>{stateLabel(agent)}</span><Icon name="chevron" size={14} /></summary>
      <div className="subagent-transcript">{agent.turns.flatMap(turn => turn.items.map(item => ({ turn, item }))).map(({ turn, item }) =>
        <ItemView key={`${turn.id}:${item.id}`} item={item} turnStatus={turn.status} timestamp={turn.itemTimestamps?.[item.id] ?? turn.startedAt} {...resources} />)}
        {!agent.turns.some(turn => turn.items.length) && <p className="subagent-empty">等待子代理输出…</p>}
      </div>
    </details>)}
  </section>;
}
