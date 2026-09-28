/** Product-owned pointer to a Cellbox archive; the archive bytes and catalog live in Cellbox. */
export interface RemoteArchiveRef {
  id: string;
  createdAt: string;
  sizeBytes: number;
  sha256: string;
  imageId: string;
  sourceSandboxId: string;
  threadIds: string[];
  storageType?: 'cellbox' | 'oss';
  metadata?: Record<string, unknown>;
}

export type RemoteArchiveMetadata = Omit<RemoteArchiveRef, 'threadIds'>;
