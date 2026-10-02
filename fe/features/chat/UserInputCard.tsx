import { useState } from 'react';
import type { Session } from '../../../protocol/types';
import type { UserInputRequest } from '../../../protocol/user-input-types';
import { api, errorMessage } from '../../lib/api';
import './UserInputCard.css';
export default function UserInputCard({ request, sessionId, turnId, onAnswered }: { request: UserInputRequest; sessionId: string; turnId: string; onAnswered: (session: Session) => void }) {
  const [selected, setSelected] = useState(() => request.questions.map(q => q.options?.[0] ?? ''));
  const [custom, setCustom] = useState(() => request.questions.map(() => ''));
  const [saving, setSaving] = useState(false); const [error, setError] = useState('');
  const answers = request.questions.map((q,i) => custom[i]?.trim() || selected[i]);
  async function submit() { if (saving || answers.some(answer => !answer)) return; setSaving(true); setError(''); try { const answer = answers.length === 1 ? answers[0] : answers.map((a,i) => `${i+1}. ${request.questions[i].title}\n${a}`).join('\n\n'); onAnswered(await api<Session>(`/api/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}/user-input/${encodeURIComponent(request.id)}`, { method:'POST', body:JSON.stringify({answer}) })); } catch (e) { setError(errorMessage(e)); } finally { setSaving(false); } }
  return <section className="user-input-card" aria-label="CoCell 的问题"><header><strong>CoCell 想问你</strong><span>{request.status === 'pending' ? '等待回答' : request.status === 'queued' ? '回答已收到' : '已回答'}</span></header>{request.status === 'pending' ? <>{request.questions.map((q,i) => <fieldset key={i} disabled={saving}><legend>{q.title}</legend>{q.options?.map(option => <label key={option} className="user-input-option"><input type="radio" name={`${request.id}-${i}`} checked={selected[i] === option && !custom[i]} onChange={() => { setSelected(v => v.map((x,j) => j===i?option:x)); setCustom(v => v.map((x,j) => j===i?'':x)); }} />{option}</label>)}<label className="user-input-custom">{q.options ? '或输入其他回答' : '你的回答'}<textarea rows={2} maxLength={20000} value={custom[i]} onChange={e => setCustom(v => v.map((x,j) => j===i?e.target.value:x))} /></label></fieldset>)}<button type="button" className="primary-button" disabled={saving || answers.some(answer => !answer)} onClick={() => void submit()}>{saving ? '正在发送…' : '发送回答'}</button></> : request.answer && <p className="user-input-answer">{request.answer}</p>}{error && <div className="inline-error" role="alert">{error}</div>}</section>;
}
