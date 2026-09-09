import { useEffect, useState } from 'react';
import type { RetryState, Turn } from '../../../shared/types';

function RetryProgress({ retry }: { retry: RetryState }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    setNow(Date.now());
    if (retry.status !== 'waiting') return;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [retry.nextRetryAt, retry.status]);
  const deadline = Date.parse(retry.nextRetryAt);
  const seconds = Number.isFinite(deadline) ? Math.max(0, Math.ceil((deadline - now) / 1000)) : 0;
  const label = retry.status === 'retrying' ? '正在重试模型请求'
    : seconds > 0 ? `模型繁忙，${seconds} 秒后重试` : '模型繁忙，等待重试开始';
  return <div className="working-indicator" role="status"><span className="spinner" />{label}（{retry.attempt}/{retry.maxRetries}）</div>;
}
export default function TurnProgress({ turn }: { turn: Turn }) {
  if (turn.phase === 'finalizing') return <div className="muted turn-note" role="status">{turn.status === 'completed' ? '回复已完成，正在结束任务…' : '正在结束任务…'}</div>;
  if (turn.status !== 'running') return null;
  if (turn.approvals?.some(approval => approval.status === 'pending')) return <div className="working-indicator" role="status">等待你确认操作，请在确认卡片中选择同意执行或拒绝。</div>;
  if (turn.retry) return <RetryProgress retry={turn.retry} />;
  const commandRunning = turn.items.some(item => item.type === 'command_execution' && item.status === 'in_progress');
  const toolRunning = turn.items.some(item => item.type === 'mcp_tool_call' && item.status === 'in_progress');
  const hasReply = turn.items.some(item => item.type === 'agent_message' && item.text.trim());
  const label = turn.phase === 'recovering' ? '正在重新连接运行中的任务…'
    : turn.phase === 'starting' ? '正在准备本轮 Codex 任务…'
    : commandRunning ? '正在执行命令…'
      : toolRunning ? '正在调用工具…'
        : !turn.phase ? '正在处理任务…'
          : hasReply ? '正在继续处理任务…' : '正在生成回复…';
  return <div className="working-indicator" role="status"><span className="spinner" />{label}</div>;
}
