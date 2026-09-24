export interface UserInputQuestion {
  title: string;
  options?: string[];
}

export interface UserInputRequest {
  id: string;
  questions: UserInputQuestion[];
  status: 'pending' | 'queued' | 'answered';
  createdAt: string;
  answeredAt?: string;
  answer?: string;
  answerTurnId?: string;
}
