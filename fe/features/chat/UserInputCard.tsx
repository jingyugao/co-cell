import { useState } from 'react';
import type { Session } from '../../../protocol/types';
import type { UserInputRequest } from '../../../protocol/user-input-types';
import { api, errorMessage } from '../../lib/api';
import './UserInputCard.css';

export default function UserInputCard({ request, sessionId, turnId, onAnswered }: {
  request: UserInputRequest;
  sessionId: string;
  turnId: string;
  onAnswered: (session: Session) => void;
}) {
  const [selected, setSelected] = useState(() => request.questions.map(question => question.options?.[0] ?? ''));
  const [custom, setCustom] = useState(() => request.questions.map(() => ''));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const answers = request.questions.map((question, index) => ({ question: question.title, answer: custom[index]?.trim() || selected[index] }));

  async function submit() {
    if (saving || answers.some(item => !item.answer)) return;
    setSaving(true); setError('');
    try {
      const answer = answers.length === 1 ? answers[0].answer : answers.map((item, index) => `${index + 1}. ${item.question}\n${item.answer}`).join('\n\n');
      const session = await api<Session>(`/api/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}/user-input/${encodeURIComponent(request.id)}`, {
        method: 'POST', body: JSON.stringify({ answer }),
      });
      onAnswered(session);
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setSaving(false); }
  }

  return <section className="user-input-card" aria-label="CoCell 的问题">
    <header><strong>CoCell 想问你</strong><span>{request.status === 'pending' ? '等待回答' : request.status === 'queued' ? '回答已收到，等待当前任务结束' : '已回答'}</span></header>
    {request.status === 'pending' ? <>
      {request.questions.map((question, index) => <fieldset key={index} disabled={saving}>
        <legend>{question.title}</legend>
        {question.options?.map(option => <label key={option} className="user-input-option"><input type="radio" name={`${request.id}-${index}`} checked={selected[index] === option && !custom[index]} onChange={() => { setSelected(values => values.map((value, at) => at === index ? option : value)); setCustom(values => values.map((value, at) => at === index ? '' : value)); }} />{option}</label>)}
        <label className="user-input-custom">{question.options ? '或输入其他回答' : '你的回答'}<textarea rows={2} maxLength={20_000} value={custom[index]} onChange={event => setCustom(values => values.map((value, at) => at === index ? event.target.value : value))} /></label>
      </fieldset>)}
      <button type="button" className="primary-button" disabled={saving || answers.some(item => !item.answer)} onClick={() => void submit()}>{saving ? '正在发送…' : '发送回答'}</button>
    </> : request.answer && <p className="user-input-answer">{request.answer}</p>}
    {error && <div className="inline-error" role="alert">{error}</div>}
  </section>;
}
