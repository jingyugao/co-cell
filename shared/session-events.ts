import type { AgentEvent, Session, Turn } from './types.js';

/** Apply SDK lifecycle events consistently in persistent state and the browser. */
export function applyTurnEvent(turn: Turn, event: AgentEvent): Turn {
  switch (event.type) {
    case 'runtime.retry':
      if (event.retry === null) return { ...turn, retry: undefined };
      if (turn.status === 'completed' || turn.status === 'cancelled') return turn;
      return { ...turn, status: 'running', phase: 'running', error: undefined, retry: { ...event.retry } };
    case 'turn.started':
      return { ...turn, status: 'running', phase: 'running', retry: undefined };
    case 'item.started': case 'item.updated': case 'item.completed': {
      const items = [...turn.items];
      const index = items.findIndex(item => item.id === event.item.id);
      if (index === -1) items.push(event.item); else items[index] = event.item;
      return { ...turn, items, phase: turn.phase === 'finalizing' ? 'finalizing' : 'running' };
    }
    case 'turn.completed':
      return { ...turn, status: 'completed', phase: 'finalizing', usage: event.usage, error: undefined, retry: undefined };
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
    turns: session.turns.map(turn => turn.id === turnId ? applyTurnEvent(turn, event) : turn),
  };
}
