export interface SandboxArchive {
  key: string;
  sizeBytes: number;
  sha256: string;
  createdAt: string;
}

/** Persisted sandbox metadata; independent of conversation history. */
export interface SandboxState {
  lastActiveAt?: string;
  pausedAt?: string;
  archive?: SandboxArchive;
  id: string;
  status: 'starting' | 'ready' | 'paused' | 'unavailable' | 'archiving' | 'archived' | 'restoring';
  template: string;
  workingDirectory: string;
}
