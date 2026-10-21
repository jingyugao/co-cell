import { useCallback, useEffect, useRef, useState } from 'react';
import type { NativeSessionConnection } from '../../../protocol/native-app-server';
import type { Session, Turn } from '../../../protocol/types';
import { applySdkEvent } from '../../../util/session-events';
import { withNativeUserInput } from '../../../util/user-input';
import { api, errorMessage } from '../../lib/api';
import { NativeAppServerClient, nativeWebSocketUrl, readQuietSnapshot } from '../../lib/native-app-server';
import { NativeAppServerEventAdapter } from '../../lib/native-app-server-adapter';
import { mergeSession } from './useSessionStream';

type Connection = NativeSessionConnection;
type Submission = { prompt: string; images: string[] };
const nativeIds = (session: Session): Session => ({ ...session, turns: session.turns.map(turn => turn.nativeTurnId ? { ...turn, id: turn.nativeTurnId } : turn) });
const toRpcError = (error: unknown) => error instanceof Error ? error : new Error(String(error));

export function useNativeSession({ selected, enabled, session, setSession, onError }: {
  selected: string | null; enabled: boolean; session: Session | null;
  setSession: (value: Session | null | ((current: Session | null) => Session | null)) => void;
  onError: (error: string) => void;
}) {
  const [connected, setConnected] = useState(false);
  const connectedRef = useRef(false);
  const clientRef = useRef<NativeAppServerClient | null>(null);
  const sessionRef = useRef(session); sessionRef.current = session;
  const setSessionRef = useRef(setSession); setSessionRef.current = setSession;
  const errorRef = useRef(onError); errorRef.current = onError;
  const markConnected = (value: boolean) => { connectedRef.current = value; setConnected(value); };
  const adapterRef = useRef(new NativeAppServerEventAdapter());
  const activeTurnId = useRef<string | null>(null);
  const bufferingEvents = useRef(false);
  const threadChangeVersion = useRef(0);
  const terminalTurnIds = useRef(new Set<string>());
  const refreshConnectionRef = useRef<(() => Promise<void>) | null>(null);
  const liveTurnIds = useRef(new Set<string>());
  const pendingStart = useRef<Submission | null>(null);
  const optionsRef = useRef<Connection['turnOptions']>({});
  const threadOptionsRef = useRef<Connection['threadOptions']>({});
  const connectionRef = useRef<Connection | null>(null);
  const threadRef = useRef('');
  const threadBoundRef = useRef(false);
  const selectedRef = useRef(selected); selectedRef.current = selected;

  const mergeHistory = useCallback((id: string, latest: Session) => {
    const normalized = nativeIds(latest);
    if (selectedRef.current === id) setSessionRef.current(current => {
      if (!current) return normalized;
      const merged = mergeSession(current, normalized);
      if (!liveTurnIds.current.size) return merged;
      const local = new Map(current.turns.map(turn => [turn.nativeTurnId ?? turn.id, turn]));
      const turns = merged.turns.map(turn => liveTurnIds.current.has(turn.nativeTurnId ?? turn.id)
        ? { ...turn, ...local.get(turn.nativeTurnId ?? turn.id) } : turn);
      const latestLocal = [...local.values()].filter(turn => liveTurnIds.current.has(turn.nativeTurnId ?? turn.id))
        .sort((left, right) => right.startedAt.localeCompare(left.startedAt))[0];
      const keepTerminalStatus = latestLocal && latestLocal.status !== 'running'
        && turns.some(turn => turn.id === latestLocal.id && turn.status !== 'running');
      return { ...merged, ...(keepTerminalStatus ? { status: current.status } : {}), turns };
    });
    return normalized;
  }, []);

  const refreshHistory = useCallback(async (id: string) =>
    mergeHistory(id, await api<Session>(`/api/sessions/${encodeURIComponent(id)}`)), [mergeHistory]);

  const applyEvent = useCallback((message: { method?: string; params?: Record<string, any> }) => {
    const method = message.method ?? ''; const params = message.params ?? {};
    if (params.threadId && params.threadId !== threadRef.current) return;
    const events = adapterRef.current.accept({ method, params });
    const eventTurnId = String(params.turnId ?? params.turn?.id ?? '');
    for (const event of events) {
      if (event.type === 'error') { errorRef.current(event.message); continue; }
      if (event.type === 'turn.started') {
        const startedId = event.turn_id ?? eventTurnId;
        terminalTurnIds.current.delete(startedId);
        activeTurnId.current = startedId || activeTurnId.current;
      }
      const nativeId = event.type === 'turn.started' ? event.turn_id ?? eventTurnId : eventTurnId || activeTurnId.current;
      if (!nativeId) continue;
      liveTurnIds.current.add(nativeId);
      const prompt = pendingStart.current?.prompt ?? '';
      const images = pendingStart.current?.images ?? [];
      setSessionRef.current(current => {
        if (!current || current.id !== selectedRef.current) return current;
        let base = current;
        let turn = base.turns.find(item => item.nativeTurnId === nativeId || item.id === nativeId);
        if (!turn && (event.type === 'turn.started' || pendingStart.current)) {
          const now = new Date().toISOString();
          turn = { id: nativeId, nativeTurnId: nativeId, prompt, images, status: 'running', phase: 'running', codexAccepted: true, items: [], startedAt: now };
          base = { ...base, status: 'running', threadId: threadRef.current, turns: [...base.turns, turn] };
        }
        if (!turn) return base;
        const updated = applySdkEvent({ ...base, threadId: threadRef.current }, turn.id, event);
        const nextTurn = updated.turns.find(item => item.id === turn!.id)!;
        const withInputs = withNativeUserInput(nextTurn);
        const terminal = event.type === 'turn.completed' || event.type === 'turn.failed';
        const finalTurn = terminal ? { ...withInputs, phase: undefined, retry: undefined,
          completedAt: turn.completedAt ?? new Date().toISOString() } : withInputs;
        const turns = updated.turns.map(item => item.id === turn!.id ? finalTurn : item);
        const status = event.type === 'turn.started' ? 'running' : event.type === 'turn.completed' ? 'completed' : event.type === 'turn.failed' ? (event.cancelled ? 'cancelled' : 'failed') : updated.status;
        return { ...updated, status, turns };
      });
      if (event.type === 'turn.completed' || event.type === 'turn.failed') {
        terminalTurnIds.current.add(nativeId);
        activeTurnId.current = null; pendingStart.current = null;
        const selectedId = selectedRef.current; if (selectedId) void refreshHistory(selectedId).catch(() => {});
      }
    }
  }, [refreshHistory]);

  const acceptEvent = useCallback((message: { method?: string; params?: Record<string, any> }) => {
    if (bufferingEvents.current) {
      const params = message.params ?? {};
      if (params.threadId && params.threadId !== threadRef.current) return;
      if (message.method === 'thread/tokenUsage/updated') { applyEvent(message); return; }
      if (/^(turn\/(started|completed|plan\/updated)|item\/(started|completed|agentMessage\/delta|reasoning\/.*Delta|reasoning\/summaryPartAdded|commandExecution\/outputDelta))$/.test(message.method ?? ''))
        threadChangeVersion.current++;
      return;
    }
    applyEvent(message);
  }, [applyEvent]);

  useEffect(() => {
    if (!enabled || !selected) { markConnected(false); return; }
    const id = selected; threadRef.current = ''; threadBoundRef.current = false; connectionRef.current = null; liveTurnIds.current.clear(); activeTurnId.current = null; pendingStart.current = null; terminalTurnIds.current.clear(); let alive = true; let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let retryDelay = 500; let generation = 0;
    let client: NativeAppServerClient | undefined;
    const scheduleRetry = () => {
      if (!alive) return;
      if (retryTimer) clearTimeout(retryTimer);
      const delay = retryDelay; retryDelay = Math.min(retryDelay * 2, 10_000);
      retryTimer = setTimeout(() => {
        const reconcileUnboundThread = Boolean(threadRef.current && !threadBoundRef.current);
        void connect(reconcileUnboundThread).catch(() => {});
      }, delay);
    };
    const connect = async (refresh = false): Promise<void> => {
      const attempt = ++generation;
      let attemptClient: NativeAppServerClient | undefined;
      try {
        if (refresh || !connectionRef.current) {
          const prepared = await api<Connection>(`/api/sessions/${encodeURIComponent(id)}/connection`, { method: 'POST' });
          if (!alive || attempt !== generation) return;
          if (refresh && client) { client.close(); if (clientRef.current === client) clientRef.current = null; client = undefined; }
          connectionRef.current = prepared;
          threadRef.current = prepared.threadId ?? '';
          threadBoundRef.current = Boolean(prepared.threadId);
          threadChangeVersion.current = 0;
          optionsRef.current = prepared.turnOptions;
          threadOptionsRef.current = prepared.threadOptions;
          setSessionRef.current(current => mergeSession(current, nativeIds(prepared.session)));
        }
        bufferingEvents.current = true;
        const connection = connectionRef.current;
        if (!connection) throw new Error('会话连接尚未准备好');
        attemptClient = new NativeAppServerClient(nativeWebSocketUrl(connection.websocketPath), acceptEvent, () => {
          if (!alive || attempt !== generation || client !== attemptClient) return;
          client = undefined;
          if (clientRef.current === attemptClient) clientRef.current = null;
          markConnected(false);
          scheduleRetry();
        }, error => errorRef.current(error.message));
        client = attemptClient;
        clientRef.current = attemptClient;
        await attemptClient.connect(connection.threadId);
        if (!alive || attempt !== generation || client !== attemptClient) { attemptClient.close(); return; }
        const { value: history, quiet } = connection.threadId === null
          ? { value: nativeIds(connection.session), quiet: true }
          : await (async () => {
            const snapshot = await readQuietSnapshot(
              () => api<Session>(`/api/sessions/${encodeURIComponent(id)}`), () => threadChangeVersion.current, 10_000);
            return { value: mergeHistory(id, snapshot.value), quiet: snapshot.quiet };
          })();
        if (!alive || attempt !== generation || client !== attemptClient || clientRef.current !== attemptClient) return;
        if (!quiet) errorRef.current('会话历史在初始化期间持续变化；已显示最近读取的历史，请稍后刷新。');
        const currentTurn = [...history.turns].reverse().find(turn => turn.status === 'running');
        adapterRef.current.seed(currentTurn?.items ?? []);
        // While reading the quiet snapshot, discard notifications already
        // represented in history; only events after this point are applied.
        bufferingEvents.current = false;
        activeTurnId.current = currentTurn ? currentTurn.nativeTurnId ?? currentTurn.id : null;
        for (const turn of history.turns) if (turn.status !== 'running') terminalTurnIds.current.add(turn.nativeTurnId ?? turn.id);
        retryDelay = 500; markConnected(true);
      } catch (error) {
        if (!alive || attempt !== generation) return;
        generation++;
        const previousClient = client;
        client = undefined;
        attemptClient?.close();
        if (previousClient && previousClient !== attemptClient) previousClient.close();
        if (clientRef.current === attemptClient || clientRef.current === previousClient) clientRef.current = null;
        markConnected(false);
        bufferingEvents.current = false;
        errorRef.current(errorMessage(error));
        scheduleRetry();
        throw error;
      }
    };
    refreshConnectionRef.current = async () => {
      if (!alive) throw new Error('会话连接已关闭');
      if (retryTimer) clearTimeout(retryTimer);
      await connect(true);
    };
    void connect().catch(() => {});
    return () => { alive = false; generation++; refreshConnectionRef.current = null; bufferingEvents.current = false; if (retryTimer) clearTimeout(retryTimer); client?.close(); if (clientRef.current === client) clientRef.current = null; if (connectionRef.current?.session.id === id) connectionRef.current = null; markConnected(false); };
  }, [selected, enabled, acceptEvent, mergeHistory, refreshHistory]);

  const send = useCallback(async (prompt: string, images: string[] = [], options: { expectedTurnId?: string; forceStart?: boolean } = {}) => {
    const client = clientRef.current; const current = sessionRef.current;
    if (!client || !current || !prompt.trim()) throw new Error('Codex App Server 尚未连接');
    const assertCurrentConnection = () => {
      if (selectedRef.current !== current.id || sessionRef.current?.id !== current.id || clientRef.current !== client)
        throw new Error('会话连接已切换，请在当前会话重试。');
    };
    assertCurrentConnection();
    const input = [{ type: 'text', text: prompt, text_elements: [] }, ...images.map(path => ({ type: 'localImage', path }))];
    let threadId = threadRef.current;
    if (!threadId) {
      const created = await client.request('thread/start', threadOptionsRef.current);
      assertCurrentConnection();
      threadId = String(created?.thread?.id ?? '');
      if (!threadId) throw new Error('Codex App Server 未返回新 thread ID');
      threadRef.current = threadId;
      threadBoundRef.current = false;
    }
    if (!threadBoundRef.current) {
      await api(`/api/sessions/${encodeURIComponent(current.id)}/thread`, {
        method: 'POST', body: JSON.stringify({ threadId }),
      });
      assertCurrentConnection();
      threadBoundRef.current = true;
      if (connectionRef.current) connectionRef.current = { ...connectionRef.current, threadId };
      setSessionRef.current(value => value?.id === current.id ? { ...value, threadId } : value);
    }
    assertCurrentConnection();
    if (options.expectedTurnId || (!options.forceStart && current.status === 'running')) {
      const expectedTurnId = options.expectedTurnId ?? activeTurnId.current ?? current.turns.at(-1)?.nativeTurnId ?? current.turns.at(-1)?.id;
      if (!expectedTurnId) throw new Error('无法确认当前运行中的 turn，请刷新状态。');
      await client.request('turn/steer', { threadId, expectedTurnId, input: [{ type: 'text', text: prompt, text_elements: [] }] });
      assertCurrentConnection();
      setSessionRef.current(value => value?.id === current.id ? { ...value, turns: value.turns.map(turn => turn.id === expectedTurnId || turn.nativeTurnId === expectedTurnId ? { ...turn, additionalUserInputs: [...(turn.additionalUserInputs ?? []), prompt] } : turn) } : value);
      return;
    }
    pendingStart.current = { prompt, images };
    adapterRef.current.seed([]);
    try {
      const result = await client.request('turn/start', { threadId, input, ...optionsRef.current });
      assertCurrentConnection();
      const turnId = result?.turn?.id;
      if (turnId) {
        if (terminalTurnIds.current.has(turnId)) activeTurnId.current = null;
        else activeTurnId.current = turnId;
        setSessionRef.current(value => {
          if (!value || value.id !== current.id || value.id !== selectedRef.current || value.turns.some(turn => turn.id === turnId || turn.nativeTurnId === turnId)) return value;
          const now = new Date().toISOString();
          const turn: Turn = { id: turnId, nativeTurnId: turnId, prompt, images, status: 'running', phase: 'running', codexAccepted: true, items: [], startedAt: now };
          return { ...value, status: 'running', threadId: threadRef.current, turns: [...value.turns, turn] };
        });
      }
    } catch (error) {
      // A transport failure can happen after App Server accepted the mutation.
      const stillCurrent = selectedRef.current === current.id && sessionRef.current?.id === current.id && clientRef.current === client;
      if (stillCurrent) {
        void refreshHistory(current.id).catch(() => {});
        if (!(error as { unknownOutcome?: boolean })?.unknownOutcome) await refreshConnectionRef.current?.().catch(() => {});
      }
      throw toRpcError(error);
    }
  }, [refreshHistory]);

  const waitUntilConnected = useCallback(async () => {
    const deadline = Date.now() + 15_000;
    while (!connectedRef.current && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
    if (!connectedRef.current) throw new Error('Codex App Server 连接超时，请稍后重试。');
  }, []);

  const stop = useCallback(async () => {
    const client = clientRef.current; const current = sessionRef.current;
    const turnId = activeTurnId.current ?? current?.turns.at(-1)?.nativeTurnId ?? current?.turns.at(-1)?.id;
    if (!client || !current || !turnId) throw new Error('当前没有可停止的 turn');
    await client.request('turn/interrupt', { threadId: threadRef.current, turnId });
  }, []);

  const answer = useCallback(async (requestId: string, questions: Array<{ title: string }>, answers: string[]) => {
    if (answers.length !== questions.length || answers.some(value => !value.trim())) throw new Error('请回答所有问题');
    const current = sessionRef.current;
    const ownerTurn = current?.turns.find(turn => turn.userInputRequests?.some(item => item.id === requestId));
    const request = ownerTurn?.userInputRequests?.find(item => item.id === requestId);
    const prompt = '<send_user_message_question_reply>\n' + JSON.stringify(questions.map((question, index) => ({
      answer: answers[index], question: question.title,
      questionItemId: JSON.stringify(['request_user_input_async', requestId, index]),
    }))) + '\n</send_user_message_question_reply>';
    if (!request) throw new Error('问题已更新，请刷新后重试。');
    if (ownerTurn?.status === 'running') await send(prompt, [], { expectedTurnId: ownerTurn.nativeTurnId ?? ownerTurn.id });
    else await send(prompt, [], { forceStart: true });
    const answer = answers.length === 1 ? answers[0] : answers.map((value, index) => `${index + 1}. ${questions[index].title}\n${value}`).join('\n\n');
    setSessionRef.current(current => current ? { ...current, turns: current.turns.map(turn => ({ ...turn, userInputRequests: turn.userInputRequests?.map(item => item.id === requestId ? { ...item, status: 'answered', answer, answers, answeredAt: new Date().toISOString() } : item) })) } : current);
  }, [send]);

  const refreshConnection = useCallback(async () => {
    const refresh = refreshConnectionRef.current;
    if (!refresh) throw new Error('会话连接尚未就绪');
    await refresh();
  }, []);

  return { connected, waitUntilConnected, refreshConnection, send, stop, answer };
}
