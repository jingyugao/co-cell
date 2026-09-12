import type { Turn } from '../../../shared/types';

export default function TurnContextStatus({ turn }: { turn: Turn }) {
  // Historical failures without an SDK receipt must remain unknown.
  const accepted = turn.codexAccepted === true || Boolean(turn.items.length || turn.contextUsage?.length || turn.sdkUsage);
  if (accepted) return null;
  const text = turn.codexAccepted === false
    ? turn.status === 'running' ? '等待 Codex 接收' : '未收到 Codex 接收回执'
    : '历史记录 · 未确认 Codex 接收状态';
  return <span className="turn-context-status" title="平台保存的是提交记录；是否进入上下文以 Codex 原生记录为准。">{text}</span>;
}
