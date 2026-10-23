export type MemoryStatus = 'queued' | 'exporting' | 'cleaning' | 'ready' | 'failed' | 'skipped';

export interface MemoryRecord {
  id: string;
  projectId: string;
  projectName: string;
  sessionId: string;
  sessionTitle: string;
  firstMessage: string;
  sourceUpdatedAt: string;
  status: MemoryStatus;
  fileCount: number;
  encryptedCount: number;
  error?: string;
  cleanedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryFile {
  id: string;
  /** Native identity; older material versions use their stable relative path. */
  threadId?: string;
  path: string;
  agentName: string;
  contextIndex: number;
  byteLength: number;
  sha256: string;
}

export interface MemoryList {
  items: MemoryRecord[];
  hasMore: boolean;
}

export interface MemoryDetail {
  record: MemoryRecord;
  files: MemoryFile[];
}

/** Explicit retry/regeneration of a failed or ready record; updatedAt guards against stale actions. */
export interface MemoryRetryInput {
  updatedAt: string;
}

/** UTF-8 byte offsets; complete code points are kept together across pages. */
export interface MemoryFileContent {
  content: string;
  nextOffset: number | null;
  totalBytes: number;
}
