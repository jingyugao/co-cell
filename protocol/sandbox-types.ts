export interface SandboxArchive {
  key: string;
  sizeBytes: number;
  sha256: string;
  createdAt: string;
}

/** Portable user-data archive; unrelated to provider disk/memory snapshots. */
export interface SandboxDataArchive extends SandboxArchive {
  format: 'codex-workspace-v1';
  workingDirectory: string;
  threadIds: string[];
  manifestSha256: string;
  sourceSandboxId: string;
  /** Host-issued provenance used only to clean up legacy project sandboxes. */
  sourceProjectId?: string;
  sourceTemplate?: string;
  /** Application conversation checkpoint, preventing a stale native-history restore. */
  sessionCheckpoint?: string;
}

/** Cleanup intent is not a project binding. Unknown dangling VMs have no intent. */
export interface SandboxCleanupRecord {
  sandboxId: string;
  reason: 'upgrade' | 'idle' | 'failed_restore';
  scheduledAt: string;
  deleteAfter: string;
  archive?: SandboxDataArchive;
  lastError?: string;
  attempts: number;
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
