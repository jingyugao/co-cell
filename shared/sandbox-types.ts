/** Persisted sandbox metadata; independent of conversation history. */
export interface SandboxState {
  lastActiveAt?: string;
  id: string;
  status: 'starting' | 'ready' | 'paused' | 'unavailable';
  template: string;
  workingDirectory: string;
}
