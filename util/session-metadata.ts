import type { Session } from '../protocol/types.js';

/** CoCell owns the binding and display settings; Codex owns the conversation. */
export function sessionMetadata(session: Session): Session {
  const { turns: _turns, contextUsage: _usage, turnCount: _count, historyNextCursor: _cursor,
    historyError: _error, ...metadata } = session;
  return { ...metadata, status: session.threadId ? 'unknown' : 'idle', turns: [] };
}
