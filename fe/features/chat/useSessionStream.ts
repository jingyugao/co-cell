import { useEffect, useRef, useState } from 'react';
import type { Session, SessionTurnPage, StreamMessage, Turn } from '../../../protocol/types';
import { applySdkEvent } from '../../../util/session-events';
import { api, errorMessage } from '../../lib/api';

function applyStream(current: Session | null, data: StreamMessage): Session | null {
  if (data.type === 'snapshot' || data.type === 'state') return data.session;
  if (!current) return current;
  const next = applySdkEvent(current, data.turnId, data.event);
  // The server event is live only for this connected page. Do not let a later
  // history replay turn it into a durable chat message.
  if (data.event.type !== 'turn.failed') return next;
  return { ...next, turns: next.turns.map(turn => turn.id === data.turnId && !turn.codexAccepted
    ? { ...turn, clientFailure: true as const } : turn) };
}

/** Keep only a failed submission created by this still-open browser page. */
function preserveClientFailures(canonical: Session, current: Session | null): Session {
  if (!current || current.id !== canonical.id) return canonical;
  const turns = canonical.turns.map(turn => {
    const previous = current.turns.find(candidate => candidate.id === turn.id || (turn.nativeTurnId && candidate.nativeTurnId === turn.nativeTurnId));
    // Covers failures where the runtime exits before it can emit `turn.failed`.
    return turn.status === 'failed' && !turn.codexAccepted && previous?.status === 'running'
      ? { ...turn, clientFailure: true as const } : turn;
  });
  const missing = current.turns.filter(turn => turn.clientFailure
    && !turns.some(other => other.id === turn.id
      || (turn.nativeTurnId && (other.id === turn.nativeTurnId || other.nativeTurnId === turn.nativeTurnId))));
  if (!missing.length && turns.every((turn, index) => turn === canonical.turns[index])) return canonical;
  return { ...canonical, turns: [...turns, ...missing].sort((a, b) => a.startedAt.localeCompare(b.startedAt)) };
}

export function mergeSession(current: Session | null, incoming: Session): Session {
  if (!current || current.id !== incoming.id || incoming.settings.executionMode !== 'sandbox') return preserveClientFailures(incoming, current);
  const key = (turn: Turn) => turn.nativeTurnId ?? turn.id;
  const turns = new Map(current.turns.map(turn => [key(turn), turn]));
  for (const turn of incoming.turns) {
    const previous = turns.get(key(turn));
    turns.set(key(turn), previous ? { ...previous, ...turn,
      prompt: turn.prompt || previous.prompt,
      items: turn.items.length ? turn.items : previous.items,
      userInputRequests: turn.userInputRequests ?? previous.userInputRequests } : turn);
  }
  const merged: Session = { ...incoming, turns: [...turns.values()].sort((left, right) => left.startedAt.localeCompare(right.startedAt)),
    historyNextCursor: current.historyNextCursor !== undefined ? current.historyNextCursor : incoming.historyNextCursor };
  return preserveClientFailures(merged, current);
}

export function useSessionStream({ selected, enabled, onState, onError }: {
  selected: string | null;
  enabled: boolean;
  onState: () => Promise<void>;
  onError: (error: string) => void;
}) {
  const [session, setSession] = useState<Session | null>(null);
  const [connected, setConnected] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const loadingOlderRef = useRef(false);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
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
    setSession(null); setConnected(false); setLoadingOlder(false); loadingOlderRef.current = false;
    setLoadingHistory(Boolean(selected));
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
        setSession(current => data.type === 'state' || data.type === 'snapshot'
          ? mergeSession(current, data.session) : applyStream(current, data));
        if (refreshWorkspace) void onStateRef.current().catch(() => {});
        if (refreshHistory) {
          // Native history now includes the completed call and its block costs.
          // Keep a failed local submission visible until a real page reload.
          void api<Session>(`/api/sessions/${selected}`).then(value => {
            if (!alive || revision !== eventRevision) return;
            setSession(current => alive && revision === eventRevision ? mergeSession(current, value) : current);
          }).catch(error => { if (alive && revision === eventRevision) onErrorRef.current(errorMessage(error)); });
        }
      } catch { onErrorRef.current('会话事件解析失败，请刷新页面重试。'); }
    };
    // The SSE snapshot is authoritative; this request also exposes missing sessions.
    api<Session>(`/api/sessions/${selected}`)
      .then(value => { if (alive) setSession(current => mergeSession(current, value)); })
      .catch(error => { if (alive) onErrorRef.current(errorMessage(error)); })
      .finally(() => { if (alive) setLoadingHistory(false); });
    return () => { alive = false; source.close(); };
  }, [selected, enabled]);

  const loadOlder = async (beforeMerge?: () => void) => {
    const cursor = session?.historyNextCursor;
    const id = selected;
    if (!id || !cursor || loadingOlderRef.current) return false;
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    try {
      const page = await api<SessionTurnPage>(
        `/api/sessions/${encodeURIComponent(id)}/turns?cursor=${encodeURIComponent(cursor)}`);
      if (selectedRef.current !== id) return false;
      beforeMerge?.();
      setSession(current => {
        if (current?.id !== id) return current;
        return { ...mergeSession(current, { ...current, turns: page.turns }), historyNextCursor: page.nextCursor };
      });
      return true;
    } catch (error) { if (selectedRef.current === id) onErrorRef.current(errorMessage(error)); return false; }
    finally { loadingOlderRef.current = false; setLoadingOlder(false); }
  };

  const updateSession = (value: Session | null | ((current: Session | null) => Session | null)) => {
    setSession(current => {
      const next = typeof value === 'function' ? value(current) : value;
      return next ? mergeSession(current, next) : next;
    });
  };

  return { session, setSession: updateSession, connected, loadOlder, loadingOlder, loadingHistory };
}
