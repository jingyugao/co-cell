import { createHash } from 'node:crypto';
import type { InputRequestRecord } from '../../protocol/input-request-types.js';
import type { AppNotification } from '../../protocol/notification-types.js';
import type { Usage } from '../../protocol/agent-protocol.js';
import type { Session, Turn } from '../../protocol/types.js';
import type { UserInputRequest } from '../../protocol/user-input-types.js';
import type { NativeRelayEvent } from '../execution/native-relay.js';

export type NativeBusinessEvent = {
  key: string;
  sessionId: string;
  threadId: string;
  turnId: string;
  kind: 'turn' | 'input' | 'usage' | 'question';
  receivedAt: string;
  source: 'live' | 'history';
  payload: {
    turn?: { status: Turn['status']; startedAt?: string; completedAt?: string; error?: string; prompt?: string };
    input?: InputRequestRecord;
    usage?: { value: Usage; observedAt: string; sourceAt?: string; totalTokens?: number };
    question?: UserInputRequest;
  };
};

type NativeEventReturn = {
  session: Session;
  turn: Turn;
  input?: InputRequestRecord;
  notification?: AppNotification;
};

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).filter(key => record[key] !== undefined).sort()
    .map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
}

function hash(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

function uuidFromHash(digest: string): string {
  const chars = digest.slice(0, 32).split('');
  chars[12] = '5';
  chars[16] = ((parseInt(chars[16]!, 16) & 0x3) | 0x8).toString(16);
  const hex = chars.join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function stableId(value: unknown): string {
  return uuidFromHash(hash(value));
}

function iso(value: unknown): string | undefined {
  if (typeof value !== 'number' && typeof value !== 'string') return undefined;
  const date = typeof value === 'number'
    ? new Date(value > 100_000_000_000 ? value : value * 1000)
    : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function sourceTime(message: Record<string, any>, receivedAt: number): string {
  return emittedTime(message) ?? new Date(receivedAt).toISOString();
}

function emittedTime(message: Record<string, any>): string | undefined {
  const value = message.emittedAtMs ?? message.params?.emittedAtMs;
  if (typeof value === 'number') {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
  }
  if (typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value)) {
    const date = new Date(Number(value));
    return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
  }
  return iso(value);
}

function turnStatus(value: unknown): Turn['status'] | undefined {
  if (value === 'completed') return 'completed';
  if (['interrupted', 'cancelled', 'canceled', 'aborted'].includes(String(value))) return 'cancelled';
  if (value === 'failed') return 'failed';
  if (['inProgress', 'in_progress', 'running'].includes(String(value))) return 'running';
  return undefined;
}

function normalizedTurn(raw: Record<string, any>, message: Record<string, any>, method: string) {
  const status = turnStatus(raw.status) ?? (method === 'turn/completed' ? 'completed' : 'running');
  const startedAt = iso(raw.startedAt)
    ?? (method === 'turn/started' ? emittedTime(message) : undefined);
  const completedAt = status === 'running' ? undefined
    : iso(raw.completedAt) ?? emittedTime(message);
  return {
    status,
    ...(startedAt ? { startedAt } : {}),
    ...(completedAt ? { completedAt } : {}),
    ...(typeof raw.error?.message === 'string' ? { error: raw.error.message } : {}),
    ...(typeof raw.prompt === 'string' ? { prompt: raw.prompt } : {}),
  } satisfies NonNullable<NativeBusinessEvent['payload']['turn']>;
}

function questionReplyId(prompt: string): string | undefined {
  const match = /<send_user_message_question_reply>\s*([\s\S]+?)\s*<\/send_user_message_question_reply>/.exec(prompt);
  if (!match) return undefined;
  try {
    const decoded: unknown = JSON.parse(JSON.parse(match[1]!)[0]?.questionItemId);
    return Array.isArray(decoded) && decoded[0] === 'request_user_input_async' && typeof decoded[1] === 'string'
      ? decoded[1] : undefined;
  } catch { return undefined; }
}

function eventKey(event: Omit<NativeBusinessEvent, 'key'>): string {
  let identity: unknown;
  if (event.kind === 'input') {
    const input = event.payload.input!;
    identity = ['input', event.sessionId, input.id];
  } else {
    const payload = event.kind === 'turn' ? event.payload.turn
      : event.kind === 'usage' ? { value: event.payload.usage?.value,
        ...(event.payload.usage?.sourceAt ? { sourceAt: event.payload.usage.sourceAt } : {}),
        ...(event.payload.usage?.totalTokens !== undefined ? { totalTokens: event.payload.usage.totalTokens } : {}) }
        : event.payload.question && { id: event.payload.question.id, questions: event.payload.question.questions };
    identity = [event.kind, event.sessionId, event.threadId, event.turnId, payload];
  }
  return hash(identity);
}

function businessEvent(event: Omit<NativeBusinessEvent, 'key'>): NativeBusinessEvent {
  return { ...event, key: eventKey(event) };
}

/** Convert the observed App Server frames into stable, business-level records. */
export function normalizeNativeEvents(event: NativeRelayEvent): NativeBusinessEvent[] {
  const message = event.message;
  const request = event.request;
  if (event.direction !== 'server' || message.error) return [];
  const source = event.connectionId === 'history' ? 'history' : 'live';
  const receivedAt = new Date(event.receivedAt).toISOString();
  const messageTime = sourceTime(message, event.receivedAt);
  const threadId = message.params?.threadId ?? request?.params?.threadId;
  if (typeof threadId !== 'string' || !threadId) return [];

  const rawTurn = message.method === 'turn/started' || message.method === 'turn/completed'
    ? message.params?.turn : request?.method === 'turn/start' ? message.result?.turn : undefined;
  const nativeTurnId = rawTurn?.id ?? message.params?.turnId ?? message.result?.turnId ?? request?.params?.expectedTurnId;
  if (typeof nativeTurnId !== 'string' || !nativeTurnId) return [];
  const events: NativeBusinessEvent[] = [];

  if (rawTurn) {
    const turn = normalizedTurn(rawTurn, message, message.method ?? request?.method ?? 'turn/start');
    if (turn) events.push(businessEvent({ sessionId: event.sessionId, threadId, turnId: nativeTurnId,
      kind: 'turn', receivedAt, source, payload: { turn } }));
  }

  if (request && ['turn/start', 'turn/steer'].includes(request.method)
    && message.result !== undefined && !message.error) {
    const inputParts = Array.isArray(request.params?.input) ? request.params.input : [];
    const prompt = inputParts.filter((part: any) => part?.type === 'text')
      .map((part: any) => typeof part.text === 'string' ? part.text : '').join('\n');
    const images = inputParts.filter((part: any) => part?.type === 'localImage' && typeof part.path === 'string')
      .map((part: any) => part.path as string);
    const requestId = questionReplyId(prompt);
    const input: InputRequestRecord = {
      id: stableId(['native-input', event.sessionId, event.connectionId, typeof request.id, request.id]),
      sessionId: event.sessionId,
      turnId: localTurnId(event.sessionId, nativeTurnId),
      type: requestId ? 'question_reply' : request.method === 'turn/start' ? 'message' : 'steer',
      method: request.method as InputRequestRecord['method'],
      params: request.params && typeof request.params === 'object' ? structuredClone(request.params) : {},
      input: prompt,
      ...(images.length ? { images } : {}),
      status: 'accepted',
      nativeTurnId,
      ...(requestId ? { requestId } : {}),
      createdAt: messageTime,
      acceptedAt: messageTime,
    };
    events.push(businessEvent({ sessionId: event.sessionId, threadId, turnId: nativeTurnId,
      kind: 'input', receivedAt, source, payload: { input } }));
  }

  const params = message.params;
  if (['item/started', 'item/completed'].includes(message.method)
    && params?.item?.type === 'agentMessage' && params.item.delivery === 'async'
    && Array.isArray(params.item.questions) && params.item.questions.length) {
    const question: UserInputRequest = {
      id: params.item.id,
      questions: structuredClone(params.item.questions),
      status: 'pending',
      createdAt: messageTime,
    };
    events.push(businessEvent({ sessionId: event.sessionId, threadId, turnId: nativeTurnId,
      kind: 'question', receivedAt, source, payload: { question } }));
  }

  if (message.method === 'thread/tokenUsage/updated') {
    const rawUsage = params?.tokenUsage?.last;
    if (rawUsage && [rawUsage.inputTokens, rawUsage.cachedInputTokens, rawUsage.outputTokens,
      rawUsage.reasoningOutputTokens].every(Number.isFinite)) {
      const value: Usage = {
        input_tokens: rawUsage.inputTokens,
        cached_input_tokens: rawUsage.cachedInputTokens,
        cache_write_input_tokens: Number.isFinite(rawUsage.cacheWriteInputTokens) ? rawUsage.cacheWriteInputTokens : 0,
        output_tokens: rawUsage.outputTokens,
        reasoning_output_tokens: rawUsage.reasoningOutputTokens,
      };
      const sourceAt = emittedTime(message);
      const rawTotalTokens = params?.tokenUsage?.total?.totalTokens;
      const totalTokens = Number.isSafeInteger(rawTotalTokens) && rawTotalTokens >= 0 ? rawTotalTokens : undefined;
      events.push(businessEvent({ sessionId: event.sessionId, threadId, turnId: nativeTurnId,
        kind: 'usage', receivedAt, source, payload: { usage: { value, observedAt: messageTime,
          ...(sourceAt ? { sourceAt } : {}), ...(totalTokens !== undefined ? { totalTokens } : {}) } } }));
    }
  }
  return events;
}

function localTurnId(sessionId: string, nativeTurnId: string): string {
  const digest = createHash('sha256').update(`${sessionId}:${nativeTurnId}`).digest('hex');
  return /^[0-9a-f-]{36}$/i.test(nativeTurnId) ? nativeTurnId
    : `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`;
}

function terminal(status: Turn['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

function notificationFor(session: Session, turn: Turn, event: NativeBusinessEvent, projectName?: string): AppNotification {
  const status = turn.status;
  const type = status === 'completed' ? 'turn_completed' : status === 'cancelled' ? 'turn_cancelled' : 'turn_failed';
  const label = status === 'completed' ? '执行完成' : status === 'cancelled' ? '已停止' : '执行失败';
  return {
    id: stableId(['native-terminal-notification', event.sessionId, event.threadId, event.turnId, status]),
    type,
    title: `【${projectName ?? '无项目'}】${label}: ${session.title}`,
    body: turn.prompt.slice(0, 100),
    sessionId: session.id,
    sessionTitle: session.title,
    ...(projectName ? { projectName } : {}),
    turnId: turn.id,
    createdAt: event.receivedAt,
  };
}

/** Apply one normalized record to a clone; persistence and deduplication are caller-owned. */
export function nativeTurnKey(sessionId: string, turnId: string): string {
  return localTurnId(sessionId, turnId);
}

export function applyNativeEvent(session: Session, event: NativeBusinessEvent,
  options: { projectName?: string; inputExists?: boolean; usageObservedAt?: string; usageTotalTokens?: number } = {}): NativeEventReturn {
  if (session.id !== event.sessionId || (session.threadId && session.threadId !== event.threadId))
    throw new Error('Native event does not belong to this session or thread');
  const next = structuredClone(session);
  if (!next.threadId) next.threadId = event.threadId;
  const id = localTurnId(session.id, event.turnId);
  let turn = next.turns.find(value => value.nativeTurnId === event.turnId || value.id === id);
  const previousStatus = turn?.status;
  if (!turn) {
    turn = { id, nativeTurnId: event.turnId, prompt: '', images: [], items: [], status: 'running',
      codexAccepted: true, type: 'message', startedAt: event.payload.turn?.startedAt ?? event.receivedAt };
    next.turns.push(turn);
    next.turnCount = (next.turnCount ?? 0) + 1;
  }

  let input: InputRequestRecord | undefined;
  if (event.kind === 'turn' && event.payload.turn) {
    const observed = event.payload.turn;
    if (observed.status !== 'running' || !terminal(turn.status)) turn.status = observed.status;
    turn.codexAccepted = true;
    if (observed.startedAt) turn.startedAt = observed.startedAt;
    if (terminal(turn.status)) {
      if (observed.completedAt) turn.completedAt = observed.completedAt;
      else turn.completedAt ??= event.receivedAt;
      delete turn.phase;
      delete turn.retry;
    }
    if (observed.error) turn.error = observed.error;
    if (observed.prompt && !turn.prompt) turn.prompt = observed.prompt;
  } else if (event.kind === 'input' && event.payload.input && !options.inputExists) {
    input = structuredClone(event.payload.input);
    if (input.method === 'turn/start') {
      if (input.input) turn.prompt = input.input;
      if (input.images?.length) turn.images = [...input.images];
      turn.type = input.type;
    } else if (input.method === 'turn/steer') {
      turn.additionalUserInputs = [...(turn.additionalUserInputs ?? []), input.input];
    }
    turn.codexAccepted = true;
  } else if (event.kind === 'question' && event.payload.question) {
    const question = event.payload.question;
    turn.userInputRequests ??= [];
    const existing = turn.userInputRequests.find(value => value.id === question.id);
    if (existing) {
      const preserved = { ...question, createdAt: existing.createdAt };
      if (existing.status === 'answered') Object.assign(preserved, {
        status: existing.status, answeredAt: existing.answeredAt, answer: existing.answer,
        answers: existing.answers, answerTurnId: existing.answerTurnId,
      });
      else if (existing.status === 'queued' || existing.deliveryStatus) Object.assign(preserved, {
        status: existing.status, deliveryStatus: existing.deliveryStatus,
      });
      turn.userInputRequests[turn.userInputRequests.indexOf(existing)] = preserved;
    } else turn.userInputRequests.push(structuredClone(question));
  } else if (event.kind === 'usage' && event.payload.usage) {
    const { value, observedAt, sourceAt, totalTokens } = event.payload.usage;
    const turnUsageIsCurrent = sourceAt
      ? !options.usageObservedAt || Date.parse(options.usageObservedAt) <= Date.parse(sourceAt)
      : totalTokens !== undefined
        ? options.usageTotalTokens === undefined || options.usageTotalTokens < totalTokens
        : turn.sdkUsage === undefined;
    if (turnUsageIsCurrent) {
      turn.sdkUsage = structuredClone(value);
      const currentObservedAt = next.contextUsage?.observedAt;
      if (!currentObservedAt || Date.parse(currentObservedAt) <= Date.parse(observedAt)) {
        next.contextUsage = { inputTokens: value.input_tokens, cachedInputTokens: value.cached_input_tokens,
          outputTokens: value.output_tokens, model: next.settings.model, observedAt, source: 'rollout' };
      }
    }
  }

  if (turn.prompt && next.title === '新任务') next.title = turn.prompt.slice(0, 60);
  next.turns.sort((left, right) => left.startedAt.localeCompare(right.startedAt));
  next.status = next.turns.some(value => value.status === 'running') ? 'running'
    : next.turns.at(-1)?.status ?? 'idle';
  next.updatedAt = event.receivedAt;
  const updatedTurn = next.turns.find(value => value.id === turn!.id)!;
  const shouldNotify = event.kind === 'turn' && terminal(updatedTurn.status)
    && !terminal(previousStatus ?? 'running')
    && (event.source === 'live' || previousStatus === 'running');
  return { session: next, turn: updatedTurn, ...(input ? { input } : {}),
    ...(shouldNotify ? { notification: notificationFor(next, updatedTurn, event, options.projectName) } : {}) };
}
