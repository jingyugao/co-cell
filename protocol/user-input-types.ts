export interface UserInputQuestion { title: string; options?: string[]; }
export interface UserInputRequest {
  id: string;
  questions: UserInputQuestion[];
  status: 'pending' | 'queued' | 'answered';
  /** Durable delivery state of the submitted reply, independent of native execution. */
  deliveryStatus?: import('./input-request-types.js').InputDeliveryStatus;
  createdAt: string;
  answeredAt?: string;
  answer?: string;
  answers?: string[];
  answerTurnId?: string;
}
