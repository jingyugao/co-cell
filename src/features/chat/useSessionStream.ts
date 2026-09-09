import { useEffect, useState } from 'react';
import type { Session, StreamMessage } from '../../../shared/types';
import { applySdkEvent } from '../../../shared/session-events';
import { api, errorMessage } from '../../lib/api';

function applyStream(current: Session | null, data: StreamMessage): Session | null {
  if (data.type === 'snapshot' || data.type === 'state') return data.session;
  if (!current) return current;
  return applySdkEvent(current, data.turnId, data.event);
}

function preserveTransientFailures(canonical: Session, current: Session | null): Session {
  if (!current || current.id !== canonical.id) return canonical;
  const missing = current.turns.filter(turn =>
    (turn.status === 'failed' || turn.status === 'cancelled')
    && !canonical.turns.some(other => other.id === turn.id
      || (turn.nativeTurnId && (other.id === turn.nativeTurnId || other.nativeTurnId === turn.nativeTurnId))));
  if (!missing.length) return canonical;
  return { ...canonical, turns: [...canonical.turns, ...missing].sort((a, b) => a.startedAt.localeCompare(b.startedAt)) };
}

export function useSessionStream({ selected, enabled, onState, onError }: {
  selected: string | null;
  enabled: boolean;
  onState: () => Promise<void>;
  onError: (error: string) => void;
}) {
  const [session, setSession] = useState<Session | null>(null);
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    // Wait until saved selections have been validated before showing history.
    if (!enabled) return;
    setSession(null); setConnected(false);
    if (!selected) { localStorage.removeItem('codex-session'); return; }
    localStorage.setItem('codex-session', selected);
    let alive = true;
    let revision = 0;
    const source = new EventSource(`/api/sessions/${selected}/events`);
    source.onopen = () => { if (alive) setConnected(true); };
    source.onerror = () => { if (alive) setConnected(false); };
    source.onmessage = event => {
      if (!alive) return;
      try {
        const data = JSON.parse(event.data) as StreamMessage;
        const eventRevision = ++revision;
        let applied: Session | null = null;
        setSession(current => {
          applied = data.type === 'state' ? preserveTransientFailures(data.session, current) : applyStream(current, data);
          return applied;
        });
        if (data.type === 'state') void onState().catch(() => {});
        if (data.type === 'state' && data.session.status !== 'running') {
          // Native history now includes the completed call and its block costs.
          // Keep a failed local submission visible until a real page reload.
          void api<Session>(`/api/sessions/${selected}`).then(value => {
            if (!alive || revision !== eventRevision) return;
            setSession(current => alive && revision === eventRevision && current === applied
              ? preserveTransientFailures(value, current) : current);
          }).catch(error => { if (alive && revision === eventRevision) onError(errorMessage(error)); });
        }
      } catch { onError('会话事件解析失败，请刷新页面重试。'); }
    };
    // The SSE snapshot is authoritative; this request also exposes missing sessions.
    api<Session>(`/api/sessions/${selected}`)
      .then(value => { if (alive) setSession(current => current || value); })
      .catch(error => { if (alive) onError(errorMessage(error)); });
    return () => { alive = false; source.close(); };
  }, [selected, enabled, onState, onError]);

  return { session, setSession, connected };
}
