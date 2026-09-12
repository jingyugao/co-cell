/** A decision applies only to the exact action and target shown in this request. */
export interface UserApprovalInput {
  title: string;
  target: string;
  action: string;
  impact: string;
}
export interface UserApproval extends UserApprovalInput {
  id: string;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled' | 'expired';
  createdAt: string;
  resolvedAt?: string;
  /** Optional feedback supplied when the user declines the proposed action. */
  rejectionReason?: string;
}
export type RequestUserApproval = (requestId: string, input: unknown, signal: AbortSignal) => Promise<UserApproval>;
