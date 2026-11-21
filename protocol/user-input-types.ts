export interface UserInputQuestion { title: string; options?: string[]; }
export interface UserInputRequest {
  id: string;
  questions: UserInputQuestion[];
  /** A live agent permission or form callback must be answered on its originating turn. */
  blocking?: boolean;
  status: 'pending' | 'queued' | 'answered';
  /** Durable delivery state of the submitted reply, independent of native execution. */
  deliveryStatus?: import('./input-request-types.js').InputDeliveryStatus;
  createdAt: string;
  answeredAt?: string;
  answer?: string;
  answers?: string[];
  answerTurnId?: string;
}
