/** A decision applies only to the exact action and target shown in this request. */
export interface UserApprovalInput {
  title: string;
  target: string;
  action: string;
  impact: string;
}
export interface UserApproval extends UserApprovalInput {
  /** Unique identifier — the Codex MCP callId (`exec-<uuid>`). */
  id: string;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled' | 'expired';
  createdAt: string;
  resolvedAt?: string;
  /** Optional feedback supplied when the user declines the proposed action. */
  rejectionReason?: string;
  /** App-Server thread ID carried by `_meta.x-codex-turn-metadata.thread_id`. */
  threadId?: string;
  /** App-Server turn ID carried by `_meta.x-codex-turn-metadata.turn_id`. */
  turnId?: string;
  /** Model that requested this approval (`_meta.x-codex-turn-metadata.model`). */
  model?: string;
}
export type RequestUserApproval = (requestId: string, input: unknown, signal: AbortSignal) => Promise<UserApproval>;
