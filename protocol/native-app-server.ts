import type { Session } from './types.js';

/** Prepare a native thread without starting or taking ownership of a turn.
 * Connect to websocketPath and initialize. Resume an existing threadId; when it
 * is null, start a thread on that socket immediately before the first input.
 * JSON-RPC frames pass through unchanged; reconnecting never resubmits input. */
export interface NativeSessionConnection {
  session: Session;
  websocketPath: string;
  threadId: string | null;
  /** Non-sensitive native thread/start options; provider credentials stay in the Sandbox. */
  threadOptions: Record<string, unknown>;
  turnOptions: { model?: string; effort?: string };
}

/** Persist the native identity before submitting the first turn. Safe to repeat. */
export interface BindNativeThreadRequest { threadId: string }
