import type { Session } from './types.js';
import type { NativeTurnOptions } from '../packages/agentcore/src/index.mjs';

/** CoCell handles this JSON-RPC request on the browser's existing socket;
 * it is never forwarded to Codex. Only successful renewals extend the lease. */
export const NATIVE_CONNECTION_RENEW_METHOD = 'cocell/connection/renew';
export const NATIVE_CONNECTION_TTL_MS = 60_000;
export const NATIVE_CONNECTION_EXPIRED = 4000;
export const NATIVE_CONNECTION_INACTIVE = 4001;

/** Prepare a native thread without starting or taking ownership of a turn.
 * Connect to websocketPath and initialize. Resume an existing threadId; when it
 * is null, start a thread on that socket immediately before the first input.
 * Codex JSON-RPC frames pass through unchanged; reconnecting never resubmits input.
 * Renew the connection lease during workspace polling via
 * cocell/connection/renew with {} params; the result contains ttlMs. */
export interface NativeSessionConnection {
  session: Session;
  websocketPath: string;
  threadId: string | null;
  /** Non-sensitive native thread/start options; provider credentials stay in the Sandbox. */
  threadOptions: Record<string, unknown>;
  turnOptions: NativeTurnOptions;
}

/** Persist the native identity before submitting the first turn. Safe to repeat. */
export interface BindNativeThreadRequest { threadId: string }

/** Read from Codex thread/queue/list; never reconstructed from CoCell storage. */
export interface NativeQueuedSubmission {
  id: string;
  clientUserMessageId: string;
  input: Array<{ type: string; text?: string; path?: string; url?: string }>;
}
