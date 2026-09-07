import { useEffect, useState } from 'react';
import type { Session, StreamMessage } from '../../../shared/types';
import { applySdkEvent } from '../../../shared/session-events';
import { api, errorMessage } from '../../lib/api';

function applyStream(current: Session | null, data: StreamMessage): Session | null {
  if (data.type === 'snapshot' || data.type === 'state') return data.session;
  if (!current) return current;
  return applySdkEvent(current, data.turnId, data.event);
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
    const source = new EventSource(`/api/sessions/${selected}/events`);
    source.onopen = () => { if (alive) setConnected(true); };
    source.onerror = () => { if (alive) setConnected(false); };
    source.onmessage = event => {
      if (!alive) return;
      try {
        const data = JSON.parse(event.data) as StreamMessage;
        setSession(current => applyStream(current, data));
        if (data.type === 'state') void onState().catch(() => {});
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
