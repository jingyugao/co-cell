import type { AgentEvent, Session, Turn } from './types.js';
import { sumRequestUsage } from './usage.js';

/** Apply SDK lifecycle events consistently in persistent state and the browser. */
export function applyTurnEvent(turn: Turn, event: AgentEvent): Turn {
  switch (event.type) {
    case 'runtime.retry':
      if (event.retry === null) return { ...turn, retry: undefined };
      if (turn.status === 'completed' || turn.status === 'cancelled') return turn;
      return { ...turn, status: 'running', phase: 'running', error: undefined, retry: { ...event.retry } };
    case 'runtime.context_usage': {
      const call = event.contextUsage;
      const calls = [...(turn.contextUsage ?? [])];
      const index = calls.findIndex(previous => call.responseId ? previous.responseId === call.responseId
        : call.requestId ? previous.requestId === call.requestId : false);
      if (index >= 0) calls[index] = { ...call }; else calls.push({ ...call });
      return { ...turn, contextUsage: calls, usage: sumRequestUsage(calls) };
    }
    case 'turn.started':
      return { ...turn, codexAccepted: true, status: 'running', phase: 'running', retry: undefined };
    case 'item.started': case 'item.updated': case 'item.completed': {
      const items = [...turn.items];
      const index = items.findIndex(item => item.id === event.item.id);
      if (index === -1) items.push(event.item); else items[index] = event.item;
      // SDK items do not currently expose a stable timestamp. Capture the
      // first time we observe each item so the UI can display when that
      // message/tool segment started without mutating the SDK item shape.
      const itemTimestamps = { ...(turn.itemTimestamps ?? {}) };
      if (!itemTimestamps[event.item.id]) itemTimestamps[event.item.id] = new Date().toISOString();
      return { ...turn, items, itemTimestamps, phase: turn.phase === 'finalizing' ? 'finalizing' : 'running' };
    }
    case 'turn.completed':
      return { ...turn, status: 'completed', phase: 'finalizing', sdkUsage: event.usage, usage: sumRequestUsage(turn.contextUsage), error: undefined, retry: undefined };
    case 'turn.failed':
      return { ...turn, status: 'failed', phase: 'finalizing', error: event.error.message, retry: undefined };
    case 'error':
      // Codex can recover from transport errors and still emit turn.completed.
      return { ...turn, error: event.message };
    default: return turn;
  }
}

export function applySdkEvent(session: Session, turnId: string, event: AgentEvent): Session {
  return {
    ...session,
    ...(event.type === 'thread.started' ? { threadId: event.thread_id } : {}),
    ...(event.type === 'runtime.context_usage' ? { contextUsage: { ...event.contextUsage } } : {}),
    turns: session.turns.map(turn => turn.id === turnId ? applyTurnEvent(turn, event) : turn),
  };
}
