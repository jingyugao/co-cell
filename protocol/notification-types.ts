export type NotificationType = 'approval_pending' | 'turn_completed' | 'turn_failed' | 'turn_cancelled';

export interface AppNotification {
  id: string;
  type: NotificationType;
  title: string;
  body: string;
  sessionId: string;
  sessionTitle: string;
  projectName?: string;
  turnId?: string;
  createdAt: string;
  readAt?: string;
}