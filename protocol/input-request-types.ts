/** One durable user submission; several submissions may target one native turn. */
export type InputRequestType = 'message' | 'steer' | 'question_reply';
export type InputDeliveryStatus = 'queued' | 'sending' | 'accepted' | 'failed' | 'unknown';
export interface InputRequestRecord {
  id: string;
  sessionId: string;
  /** The Web turn that owns native execution and usage. */
  turnId: string;
  type: InputRequestType;
  method?: 'turn/start' | 'turn/steer';
  params?: Record<string, unknown>;
  /** Non-sensitive thread/start, resume or fork configuration used for this input. */
  threadRequest?: { method: string; params: Record<string, unknown> };
  input: string;
  images?: string[];
  status: InputDeliveryStatus;
  nativeTurnId?: string;
  requestId?: string;
  error?: string;
  createdAt: string;
  sentAt?: string;
  acceptedAt?: string;
}
