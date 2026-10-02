import { useEffect, useMemo, useState } from 'react';
import type { Session } from '../../../protocol/types';
import { Icon } from '../../components/Icon';
import './WatchView.css';

function compact(text: string, limit = 220) {
  const plain = text.replace(/```[\s\S]*?```/g, '').replace(/[#*_`>]/g, '').replace(/\s+/g, ' ').trim();
  return plain.length > limit ? `${plain.slice(0, limit - 1)}…` : plain;
}

export default function WatchView({ session, projectName, busy, onStop, onRetry, onOpenPhone }: {
  session: Session | null;
  projectName?: string;
  busy?: boolean;
  onStop: () => void;
  onRetry: () => void;
  onOpenPhone: () => void;
}) {
  const [showAnswer, setShowAnswer] = useState(false);
  const turn = session?.turns.at(-1);
  const answer = useMemo(() => [...(turn?.items ?? [])].reverse().find(item => item.type === 'agent_message')?.text ?? '', [turn]);
  const tools = turn?.items.filter(item => ['command_execution', 'mcp_tool_call', 'file_change', 'web_search'].includes(item.type)) ?? [];
  const failed = tools.filter(item => 'status' in item && item.status === 'failed').length;
  const state = session?.status ?? 'idle';
  const stateLabel = state === 'running' ? '执行中' : state === 'completed' ? '已完成' : state === 'failed' ? '执行失败' : state === 'cancelled' ? '已停止' : '就绪';
  useEffect(() => { setShowAnswer(false); }, [session?.id, turn?.id, state]);
  return <main className="watch-view" aria-label="手表模式">
    <header className="watch-header"><span className="watch-brand">CoCell</span><span className={`watch-state ${state}`}>{stateLabel}</span></header>
    <h1 title={session?.title}>{session?.title || '暂无会话'}</h1>
    {projectName && <p className="watch-project">{projectName}</p>}
    {state === 'running' ? <section className="watch-status" role="status"><span className="spinner" />{turn?.phase === 'running' || tools.length ? '正在执行工具' : '正在思考'}<small>{tools.length ? `已调用 ${tools.length} 次` : '等待结果'}</small>{failed > 0 && <small className="watch-failure">失败 {failed} 次</small>}</section> : answer ? <section className="watch-answer"><button className="watch-answer-toggle" onClick={() => setShowAnswer(value => !value)} aria-expanded={showAnswer}>{showAnswer ? '最终回答' : compact(answer, 110)}</button>{showAnswer && <p>{compact(answer, 1200)}</p>}</section> : turn?.error ? <p className="watch-error">{compact(turn.error, 180)}</p> : <p className="watch-empty">暂无最终回答</p>}
    <div className="watch-actions">
      {state === 'running' && <button disabled={busy} onClick={onStop}><Icon name="stop" size={14} />停止</button>}
      {state === 'failed' && <button disabled={busy} onClick={onRetry}><Icon name="refresh" size={14} />重试</button>}
      {(state === 'cancelled' || state === 'completed') && <button disabled={busy} onClick={onRetry}>继续</button>}
      <button onClick={onOpenPhone}>打开手机</button>
    </div>
  </main>;
}
