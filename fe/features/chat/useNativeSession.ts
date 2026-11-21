import { useCallback, useEffect, useRef, useState } from 'react';
import { markPageLoad, pageLoadFailure } from '../../lib/page-load';
import type { NativeSessionConnection, NativeQueuedSubmission } from '../../../protocol/native-app-server';
import { NATIVE_CONNECTION_INACTIVE } from '../../../protocol/native-app-server';
import type { Session, Turn } from '../../../protocol/types';
import type { UserInputRequest } from '../../../protocol/user-input-types';
import { applySdkEvent } from '../../../util/session-events';
import { appendAdditionalUserInput, recordNativeUserInput, withNativeUserInput } from '../../../util/user-input';
import { api, errorMessage } from '../../lib/api';
import { NativeAppServerClient, nativeWebSocketUrl, readQuietSnapshot } from '../../lib/native-app-server';
import { NativeAppServerEventAdapter } from '../../lib/native-app-server-adapter';
import { mergeSession } from './useSessionStream';

type Connection = NativeSessionConnection;
type Submission = { prompt: string; images: string[] };
type NativeQuestion = { sessionId: string; turnId: string; rpcId: string | number; questionIds: string[];
  client: NativeAppServerClient; request: UserInputRequest };
const nativeIds = (session: Session): Session => ({ ...session, turns: session.turns.map(turn => turn.nativeTurnId ? { ...turn, id: turn.nativeTurnId } : turn) });
const toRpcError = (error: unknown) => error instanceof Error ? error : new Error(String(error));

export function useNativeSession({ selected, enabled, session, setSession, onError }: {
  selected: string | null; enabled: boolean; session: Session | null;
  setSession: (value: Session | null | ((current: Session | null) => Session | null)) => void;
  onError: (error: string) => void;
}) {
  const [connected, setConnected] = useState(false);
  const [queuedSubmissions, setQueuedSubmissions] = useState<NativeQueuedSubmission[]>([]);
  const queueRevision = useRef(0);
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
  const checkConnectionRef = useRef<(() => Promise<void>) | null>(null);
  const liveTurnIds = useRef(new Set<string>());
  const pendingStart = useRef<Submission | null>(null);
  const pendingSteers = useRef<Array<{ turnId: string; text: string; accepted: boolean; observed: boolean }>>([]);
  const observedUserItems = useRef(new Set<string>());
  const optionsRef = useRef<Connection['turnOptions']>({});
  const threadOptionsRef = useRef<Connection['threadOptions']>({});
  const connectionRef = useRef<Connection | null>(null);
  const threadRef = useRef('');
  const threadBoundRef = useRef(false);
  const selectedRef = useRef(selected); selectedRef.current = selected;
  const nativeQuestions = useRef(new Map<string, NativeQuestion>());

  const refreshQueue = useCallback(async () => {
    const client = clientRef.current, threadId = threadRef.current;
    const revision = ++queueRevision.current;
    if (!client || !threadId) { setQueuedSubmissions([]); return; }
    try {
      const items: NativeQueuedSubmission[] = [], cursors = new Set<string>();
      let cursor: string | undefined;
      do {
        const page = await client.request('thread/queue/list', { threadId, limit: 100, ...(cursor ? { cursor } : {}) });
        if (revision !== queueRevision.current || client !== clientRef.current || threadId !== threadRef.current) return;
        if (!Array.isArray(page.data)) throw new Error('Codex 未返回待执行消息列表');
        items.push(...page.data);
        cursor = page.nextCursor ?? undefined;
        if (cursor && cursors.has(cursor)) throw new Error('Codex 返回重复的队列游标');
        if (cursor) cursors.add(cursor);
      } while (cursor);
      setQueuedSubmissions(items);
    } catch (error) {
      if (client !== clientRef.current || revision !== queueRevision.current) return;
      // Older App Servers do not expose the experimental queue API.
      if (String((error as { code?: string }).code) === '-32601') { setQueuedSubmissions([]); return; }
      errorRef.current(errorMessage(error));
    }
  }, []);

  const withNativeQuestions = useCallback((current: Session): Session => ({ ...current, turns: current.turns.map(turn => {
    const questions = [...nativeQuestions.current.values()].filter(question => question.sessionId === current.id
      && question.turnId === (turn.nativeTurnId ?? turn.id));
    if (!questions.length) return turn;
    return { ...turn, userInputRequests: [...(turn.userInputRequests ?? []).filter(request => !questions.some(question => question.request.id === request.id)),
      ...questions.filter(question => question.request.status !== 'pending'
        || (question.client === clientRef.current && turn.status === 'running')).map(question => question.request)] };
  }) }), []);

  const acceptServerRequest = useCallback((message: { id?: string | number; method?: string; params?: Record<string, any> }) => {
    const params = message.params;
    const client = clientRef.current;
    if (message.method !== 'item/tool/requestUserInput' || message.id === undefined || !client
      || params?.threadId !== threadRef.current || !params.turnId || !Array.isArray(params.questions) || !params.questions.length) return false;
    const id = `request_user_input:${message.id}`;
    nativeQuestions.current.set(id, { sessionId: selectedRef.current!, turnId: params.turnId, rpcId: message.id,
      client, questionIds: params.questions.map((question: any) => question.id),
      request: { id, status: 'pending', createdAt: new Date().toISOString(), questions: params.questions.map((question: any) => ({
        title: question.question, ...(question.options ? { options: question.options.map((option: any) => option.label) } : {}),
      })) } });
    setSessionRef.current(current => current ? withNativeQuestions(current) : current);
    return true;
  }, [withNativeQuestions]);

  const refreshHistory = useCallback(async (id: string) => {
    const liveTurns = liveTurnIds.current;
    const normalized = nativeIds(await api<Session>(`/api/sessions/${encodeURIComponent(id)}`));
    if (selectedRef.current === id) setSessionRef.current(current => {
      if (liveTurns !== liveTurnIds.current || selectedRef.current !== id) return current;
      if (!current) return normalized;
      const merged = mergeSession(current, normalized);
      if (!liveTurns.size) return withNativeQuestions(merged);
      const local = new Map(current.turns.map(turn => [turn.nativeTurnId ?? turn.id, turn]));
      const turns = merged.turns.map(turn => liveTurns.has(turn.nativeTurnId ?? turn.id)
        ? { ...turn, ...local.get(turn.nativeTurnId ?? turn.id) } : turn);
      const latestLocal = [...local.values()].filter(turn => liveTurns.has(turn.nativeTurnId ?? turn.id))
        .sort((left, right) => right.startedAt.localeCompare(left.startedAt))[0];
      const keepTerminalStatus = latestLocal && latestLocal.status !== 'running'
        && turns.some(turn => turn.id === latestLocal.id && turn.status !== 'running');
      return withNativeQuestions({ ...merged, ...(keepTerminalStatus ? { status: current.status } : {}), turns });
    });
  }, [withNativeQuestions]);

  const applyEvent = useCallback((message: { method?: string; params?: Record<string, any> }) => {
    const method = message.method ?? ''; const params = message.params ?? {};
    if (method === 'thread/tokenUsage/updated' && params.tokenUsage?.last) {
      const usage = params.tokenUsage.last;
      setSessionRef.current(current => current?.id === selectedRef.current ? { ...current, contextUsage: {
        inputTokens: usage.inputTokens ?? 0, cachedInputTokens: usage.cachedInputTokens ?? 0,
        outputTokens: usage.outputTokens ?? 0, observedAt: new Date().toISOString(),
      } } : current);
    }
    if (method === 'serverRequest/resolved' || method === 'turn/completed') {
      for (const question of nativeQuestions.current.values()) {
        if (question.request.status === 'pending' && (method === 'serverRequest/resolved'
          ? question.rpcId === params.requestId : question.turnId === params.turn?.id)) question.request = { ...question.request, status: 'answered' };
      }
      setSessionRef.current(current => current ? withNativeQuestions(current) : current);
    }
    const eventTurnId = String(params.turnId ?? params.turn?.id ?? '');
    if ((method === 'item/started' || method === 'item/completed') && params.item?.type === 'userMessage' && params.item.id && eventTurnId) {
      const text = (params.item.content ?? []).filter((part: any) => part.type === 'text').map((part: any) => part.text ?? '').join('');
      liveTurnIds.current.add(eventTurnId);
      if (!observedUserItems.current.has(params.item.id)) {
        observedUserItems.current.add(params.item.id);
        const turn = sessionRef.current?.turns.find(turn => turn.id === eventTurnId || turn.nativeTurnId === eventTurnId);
        const original = turn && !turn.userInputItemId && turn.prompt === text && !turn.additionalUserInputs?.length;
        const known = turn?.userInputItemId === params.item.id || turn?.additionalUserInputPositions?.some(position => position.itemId === params.item.id);
        if (!original && !known) {
          const pending = pendingSteers.current.find(input => input.turnId === eventTurnId && input.text === text && !input.observed);
          if (pending) {
            pending.observed = true;
            if (pending.accepted) pendingSteers.current = pendingSteers.current.filter(input => input !== pending);
          }
        }
      }
      setSessionRef.current(current => {
        if (!current || current.id !== selectedRef.current) return current;
        return { ...current, turns: current.turns.map(turn => turn.id === eventTurnId || turn.nativeTurnId === eventTurnId
          ? recordNativeUserInput(turn, params.item.id, text) : turn) };
      });
      return;
    }
    const events = adapterRef.current.accept({ method, params });
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
        return withNativeQuestions({ ...updated, status, turns });
      });
      if (event.type === 'turn.completed' || event.type === 'turn.failed') {
        terminalTurnIds.current.add(nativeId);
        activeTurnId.current = null; pendingStart.current = null;
        const selectedId = selectedRef.current; if (selectedId) void refreshHistory(selectedId).catch(() => {});
      }
    }
  }, [refreshHistory, withNativeQuestions]);

  const acceptEvent = useCallback((message: { method?: string; params?: Record<string, any> }) => {
    if (message.params?.threadId && message.params.threadId !== threadRef.current) return;
    if (message.method === 'thread/queue/changed' && message.params?.threadId === threadRef.current) {
      void refreshQueue(); return;
    }
    if (/^(turn|item)\//.test(message.method ?? '')) threadChangeVersion.current++;
    if (bufferingEvents.current && message.method !== 'thread/tokenUsage/updated' && message.method !== 'serverRequest/resolved') return;
    applyEvent(message);
  }, [applyEvent, refreshQueue]);

  useEffect(() => {
    ++queueRevision.current;
    setQueuedSubmissions([]);
    if (!enabled || !selected) { markConnected(false); return; }
    pendingSteers.current = []; observedUserItems.current.clear();
    for (const [key, question] of nativeQuestions.current) if (question.sessionId !== selected) nativeQuestions.current.delete(key);
    const id = selected; threadRef.current = ''; threadBoundRef.current = false; connectionRef.current = null; liveTurnIds.current = new Set(); activeTurnId.current = null; pendingStart.current = null; terminalTurnIds.current.clear(); let alive = true; let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let retryDelay = 500; let generation = 0; let connectionInactive = false;
    let client: NativeAppServerClient | undefined;
    let historyRetry: ReturnType<typeof setTimeout> | undefined;
    const readHistory = () => api<Session>(`/api/sessions/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(15_000) });
    const applySnapshot = (latest: Session) => {
      const history = nativeIds(latest);
      const currentTurn = [...history.turns].reverse().find(turn => turn.status === 'running');
      // Only events after this snapshot may take precedence over history.
      liveTurnIds.current = new Set();
      adapterRef.current.seed(currentTurn?.items ?? []);
      activeTurnId.current = currentTurn?.id ?? null;
      for (const turn of history.turns) if (turn.status !== 'running') terminalTurnIds.current.add(turn.id);
      setSessionRef.current(current => selectedRef.current === id ? withNativeQuestions(mergeSession(current, history)) : current);
    };
    const scheduleHistoryCheck = () => {
      clearTimeout(historyRetry);
      historyRetry = setTimeout(() => void checkConnection(), 5_000);
    };
    const scheduleRetry = () => {
      if (!alive || connectionInactive) return;
      if (retryTimer) clearTimeout(retryTimer);
      const delay = retryDelay; retryDelay = Math.min(retryDelay * 2, 10_000);
      retryTimer = setTimeout(() => {
        const reconcileUnboundThread = Boolean(threadRef.current && !threadBoundRef.current);
        void connect(reconcileUnboundThread).catch(() => {});
      }, delay);
    };
    const connect = async (refresh = false): Promise<void> => {
      clearTimeout(historyRetry);
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
        attemptClient = new NativeAppServerClient(nativeWebSocketUrl(connection.websocketPath), acceptEvent, error => {
          if (!alive || attempt !== generation || client !== attemptClient) return;
          client = undefined;
          if (clientRef.current === attemptClient) clientRef.current = null;
          setSessionRef.current(current => current ? withNativeQuestions(current) : current);
          markConnected(false);
          if (error?.closeCode === NATIVE_CONNECTION_INACTIVE) {
            connectionInactive = true;
            errorRef.current('项目或会话已不可用，对话连接已关闭。');
          }
          scheduleRetry();
        }, error => errorRef.current(error.message), acceptServerRequest);
        client = attemptClient;
        clientRef.current = attemptClient;
        markPageLoad('websocketStartedMs', id);
        await attemptClient.connect(connection.threadId);
        markPageLoad('websocketConnectedMs', id);
        if (!alive || attempt !== generation || client !== attemptClient) { attemptClient.close(); return; }
        void refreshQueue();
        const { value: history, quiet } = connection.threadId === null
          ? { value: connection.session, quiet: true }
          : await readQuietSnapshot(readHistory, () => threadChangeVersion.current);
        if (!alive || attempt !== generation || client !== attemptClient || clientRef.current !== attemptClient) return;
        markPageLoad('historyReadyMs', id);
        if (history.historyError) {
          setSessionRef.current(current => current?.id === id ? { ...current, historyError: history.historyError } : current);
        } else {
          applySnapshot(history);
        }
        if (history.historyError || !quiet) scheduleHistoryCheck();
        bufferingEvents.current = false;
        retryDelay = 500; markConnected(true);
      } catch (error) {
        if (!alive || attempt !== generation) return;
        pageLoadFailure('native_connection', 'failed', id);
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
    // Mobile browsers may keep a suspended WebSocket marked OPEN after the
    // network has disappeared. Probe it without interrupting pending RPCs.
    let probing = false;
    let visibilityVersion = 0;
    const checkConnection = async () => {
      if (!alive || probing || document.visibilityState !== 'visible' || !navigator.onLine || !connectedRef.current || !client) return;
      const checkedClient = client;
      const checkedGeneration = generation;
      const checkedVisibility = visibilityVersion;
      const stillCurrent = () => alive && checkedGeneration === generation && client === checkedClient
        && checkedVisibility === visibilityVersion && document.visibilityState === 'visible' && selectedRef.current === id;
      clearTimeout(historyRetry);
      probing = true;
      try {
        await checkedClient.request('thread/list', { limit: 1 }, 5_000);
        if (!stillCurrent() || !threadBoundRef.current) return;
        // Keep processing live deltas. A read crossed by a notification cannot
        // safely seed the adapter because native deltas have no offsets.
        const version = threadChangeVersion.current;
        try {
          const history = await readHistory();
          if (!stillCurrent()) return;
          if (version === threadChangeVersion.current && !history.historyError && history.threadId === threadRef.current) {
            applySnapshot(history);
          } else {
            scheduleHistoryCheck();
          }
        } catch {
          if (stillCurrent()) scheduleHistoryCheck();
        }
      } catch (error) {
        if (!stillCurrent() || (error instanceof Error && 'code' in error)) return;
        generation++;
        client = undefined;
        if (clientRef.current === checkedClient) clientRef.current = null;
        checkedClient.close();
        setSessionRef.current(current => current ? withNativeQuestions(current) : current);
        markConnected(false);
        scheduleRetry();
      } finally {
        probing = false;
        if (checkedVisibility !== visibilityVersion) void checkConnection();
      }
    };
    const onVisibilityChange = () => {
      if (document.visibilityState !== 'visible') visibilityVersion++;
      else void checkConnection();
    };
    const onPageShow = (event: PageTransitionEvent) => { if (event.persisted) void checkConnection(); };
    checkConnectionRef.current = checkConnection;
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('online', checkConnection);
    window.addEventListener('pageshow', onPageShow);
    void connect().catch(() => {});
    return () => {
      checkConnectionRef.current = null;
      clearTimeout(historyRetry);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('online', checkConnection);
      window.removeEventListener('pageshow', onPageShow);
      alive = false; generation++; refreshConnectionRef.current = null; bufferingEvents.current = false; if (retryTimer) clearTimeout(retryTimer); client?.close(); if (clientRef.current === client) clientRef.current = null; if (connectionRef.current?.session.id === id) connectionRef.current = null; markConnected(false);
    };
  }, [selected, enabled, acceptEvent, acceptServerRequest, refreshQueue, withNativeQuestions]);

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
      const pending = { turnId: expectedTurnId, text: prompt, accepted: false, observed: false };
      pendingSteers.current.push(pending);
      try {
        await client.request('turn/steer', { threadId, expectedTurnId, input: [{ type: 'text', text: prompt, text_elements: [] }] });
        assertCurrentConnection();
        pending.accepted = true;
        setSessionRef.current(value => value?.id === current.id ? { ...value, turns: value.turns.map(turn => turn.id === expectedTurnId || turn.nativeTurnId === expectedTurnId
          ? (pending.observed ? turn : appendAdditionalUserInput(turn, prompt)) : turn) } : value);
      } finally {
        if (pending.observed || !pending.accepted) pendingSteers.current = pendingSteers.current.filter(input => input !== pending);
      }
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
    const native = nativeQuestions.current.get(requestId);
    if (!native && requestId.startsWith('request_user_input:')) throw new Error('问题连接已更新，请等待重新连接后重试。');
    if (native) {
      if (native.client !== clientRef.current || native.sessionId !== selectedRef.current || native.request.status !== 'pending')
        throw new Error('问题连接已更新，请等待重新连接后重试。');
      native.client.respond(native.rpcId, { answers: Object.fromEntries(native.questionIds.map((id, index) => [id, { answers: [answers[index]] }])) });
      native.request = { ...native.request, status: 'answered', answers, answer: answers.join('\n\n'), answeredAt: new Date().toISOString() };
      setSessionRef.current(current => current ? withNativeQuestions(current) : current);
      return;
    }
    const current = sessionRef.current;
    const ownerTurn = current?.turns.find(turn => turn.userInputRequests?.some(item => item.id === requestId));
    const request = ownerTurn?.userInputRequests?.find(item => item.id === requestId);
    if (!current || !ownerTurn || !request) throw new Error('问题已更新，请刷新后重试。');
    const answer = answers.length === 1 ? answers[0] : answers.map((value, index) => `${index + 1}. ${questions[index].title}\n${value}`).join('\n\n');
    const updated = await api<Session>(`/api/sessions/${encodeURIComponent(current.id)}/turns/${encodeURIComponent(ownerTurn.id)}/user-input/${encodeURIComponent(requestId)}`, {
      method: 'POST', body: JSON.stringify({ answer, answers }),
    });
    if (selectedRef.current === current.id) setSessionRef.current(updated);
  }, [withNativeQuestions]);

  const refreshConnection = useCallback(async () => {
    const refresh = refreshConnectionRef.current;
    if (!refresh) throw new Error('会话连接尚未就绪');
    await refresh();
  }, []);

  const renewLease = useCallback(async () => {
    const client = clientRef.current;
    if (!connectedRef.current || !client) return;
    try { await client.renewLease(); }
    catch (error) {
      if (client === clientRef.current && !(error instanceof Error && 'code' in error)) void checkConnectionRef.current?.();
      throw error;
    }
  }, []);

  return { connected, queuedSubmissions, waitUntilConnected, refreshConnection, renewLease, send, stop, answer };
}
