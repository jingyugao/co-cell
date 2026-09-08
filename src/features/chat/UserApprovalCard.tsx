import { useRef, useState } from 'react';
import type { UserApproval } from '../../../shared/approval-types';
import type { Session, Turn } from '../../../shared/types';
import { api, errorMessage } from '../../lib/api';
import './UserApprovalCard.css';

const statusLabels: Record<UserApproval['status'], string> = {
  pending: '等待用户确认',
  approved: '用户已同意执行',
  rejected: '用户已拒绝',
  cancelled: '确认请求已取消',
  expired: '确认请求已失效',
};

// A decision response may arrive after newer streamed items or a session switch.
export function mergeApprovalDecision(current: Session | null, sessionId: string, turnId: string, resolved: UserApproval): Session | null {
  if (current?.id !== sessionId || resolved.status === 'pending') return current;
  return { ...current, turns: current.turns.map(turn => turn.id === turnId ? {
    ...turn, approvals: turn.approvals?.map(item => item.id === resolved.id && item.status === 'pending' ? resolved : item),
  } : turn) };
}

export default function UserApprovalCard({ approval, sessionId, turnId, turnStatus, onResolved }: {
  approval: UserApproval;
  sessionId: string;
  turnId: string;
  turnStatus: Turn['status'];
  onResolved: (approval: UserApproval) => void;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const submitting = useRef(false);
  const pending = approval.status === 'pending' && turnStatus === 'running';
  const label = approval.status === 'pending' && !pending ? '任务已结束，确认请求已失效' : statusLabels[approval.status];

  async function decide(decision: 'approved' | 'rejected') {
    if (!pending || submitting.current) return;
    submitting.current = true;
    setSaving(true); setError('');
    try {
      const session = await api<Session>(`/api/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}/approvals/${encodeURIComponent(approval.id)}`, {
        method: 'POST', body: JSON.stringify({ decision }),
      });
      const resolved = session.turns.find(turn => turn.id === turnId)?.approvals?.find(item => item.id === approval.id);
      if (!resolved || resolved.status === 'pending') throw new Error('尚未收到确认结果，请重试。');
      onResolved(resolved);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      submitting.current = false;
      setSaving(false);
    }
  }

  return <section className={`user-approval-card${pending ? ' pending' : ''}`} aria-label={`操作确认：${approval.title}`} aria-busy={saving}>
    <header><strong>{approval.title}</strong><span role="status">{label}</span></header>
    <dl><dt>执行目标</dt><dd>{approval.target}</dd><dt>操作内容</dt><dd><pre tabIndex={0} aria-label="待确认的完整操作"><code>{approval.action}</code></pre></dd><dt>影响评估</dt><dd>{approval.impact}</dd></dl>
    {pending && <>
      <p className="user-approval-note">同意仅适用于本次展示的目标和操作内容。Agent 正在等待你的决定。</p>
      <div className="user-approval-actions"><button type="button" className="secondary-button" disabled={saving} onClick={() => void decide('rejected')}>拒绝</button><button type="button" className="primary-button" disabled={saving} onClick={() => void decide('approved')}>同意执行</button>{saving && <span role="status">正在保存决定…</span>}</div>
    </>}
    {approval.status === 'approved' && <p className="user-approval-note">已授权执行；实际执行结果见后续工具记录。</p>}
    {approval.resolvedAt && <time className="user-approval-time" dateTime={approval.resolvedAt}>{new Date(approval.resolvedAt).toLocaleString()}</time>}
    {error && pending && <div className="inline-error" role="alert">{error}</div>}
  </section>;
}
