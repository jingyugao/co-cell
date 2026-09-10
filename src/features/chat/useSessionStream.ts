import { useEffect, useRef, useState } from 'react';
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
  // Callers may recreate these handlers while refreshing workspace state. Keep
  // the EventSource lifecycle tied to the selected session, not callback
  // identity; otherwise a state event can cause a disconnect/reconnect loop.
  const onStateRef = useRef(onState);
  const onErrorRef = useRef(onError);
  useEffect(() => { onStateRef.current = onState; }, [onState]);
  useEffect(() => { onErrorRef.current = onError; }, [onError]);
  useEffect(() => {
    // Wait until saved selections have been validated before showing history.
    if (!enabled) return;
    setSession(null); setConnected(false);
    if (!selected) { localStorage.removeItem('codex-session'); return; }
    localStorage.setItem('codex-session', selected);
    let alive = true;
    let revision = 0;
    let historyKey: string | null = null;
    let workspaceKey: string | null = null;
    const source = new EventSource(`/api/sessions/${selected}/events`);
    source.onopen = () => { if (alive) setConnected(true); };
    source.onerror = () => { if (alive) setConnected(false); };
    source.onmessage = event => {
      if (!alive) return;
      try {
        const data = JSON.parse(event.data) as StreamMessage;
        let refreshHistory = false;
        let refreshWorkspace = false;
        let turnChanged = true;
        if (data.type === 'snapshot' || data.type === 'state') {
          const latest = data.session.turns.at(-1);
          const nextKey = JSON.stringify([data.session.status, latest?.id, latest?.status]);
          turnChanged = nextKey !== historyKey;
          // Reading native history updates sandbox metadata and emits state.
          // Only a turn transition should trigger another history read.
          refreshHistory = data.type === 'state' && nextKey !== historyKey && data.session.status !== 'running';
          historyKey = nextKey;
          const nextWorkspaceKey = JSON.stringify([nextKey, data.session.title, data.session.archivedAt,
            data.session.sandbox?.id, data.session.sandbox?.status]);
          refreshWorkspace = data.type === 'state' && nextWorkspaceKey !== workspaceKey;
          workspaceKey = nextWorkspaceKey;
        }
        if (turnChanged) ++revision;
        const eventRevision = revision;
        setSession(current => data.type === 'state' ? preserveTransientFailures(data.session, current) : applyStream(current, data));
        if (refreshWorkspace) void onStateRef.current().catch(() => {});
        if (refreshHistory) {
          // Native history now includes the completed call and its block costs.
          // Keep a failed local submission visible until a real page reload.
          void api<Session>(`/api/sessions/${selected}`).then(value => {
            if (!alive || revision !== eventRevision) return;
            setSession(current => alive && revision === eventRevision
              ? preserveTransientFailures(current ? { ...current, turns: value.turns, contextUsage: value.contextUsage } : value, current) : current);
          }).catch(error => { if (alive && revision === eventRevision) onErrorRef.current(errorMessage(error)); });
        }
      } catch { onErrorRef.current('会话事件解析失败，请刷新页面重试。'); }
    };
    // The SSE snapshot is authoritative; this request also exposes missing sessions.
    api<Session>(`/api/sessions/${selected}`)
      .then(value => { if (alive) setSession(current => current || value); })
      .catch(error => { if (alive) onErrorRef.current(errorMessage(error)); });
    return () => { alive = false; source.close(); };
  }, [selected, enabled]);

  return { session, setSession, connected };
}
