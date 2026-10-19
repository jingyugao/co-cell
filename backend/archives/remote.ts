import type { SandboxState } from '../../protocol/sandbox-types.js';
import type { RemoteArchiveMetadata, RemoteArchiveRef } from '../../protocol/remote-archive-types.js';
import type { WorkspaceTarget } from '../sandboxes/types.js';
import type { SandboxMount } from '../../protocol/sandbox-types.js';
import type { VolumeBackupPolicy } from '../../protocol/remote-archive-types.js';

/** Optional runtime capability for Cellbox-owned archives. */
export interface RemoteArchives {
  policy?(): Promise<VolumeBackupPolicy>;
  /** Read the native catalog; the product index contributes only thread/mount metadata. */
  list?(target: WorkspaceTarget, references: readonly RemoteArchiveRef[]): Promise<RemoteArchiveRef[]>;
  /** Submit capture once and return native metadata; request ID is only for correlation. */
  capture(target: WorkspaceTarget, requestId: string,
    options?: { onOperation?: (operationId: string, volumeId: string) => Promise<void> }): Promise<RemoteArchiveMetadata>;
  /** Verify that the specific owned archive still exists and matches its saved metadata. */
  inspect(reference: RemoteArchiveRef): Promise<RemoteArchiveMetadata>;
  /** Restore into a staged box. Notify about its ID before subsequent setup can fail. */
  restore(target: WorkspaceTarget, reference: RemoteArchiveRef, requestId: string,
    onCandidate: (sandbox: SandboxState) => Promise<void>, options?: {
      onOperation?: (operationId: string) => Promise<void>;
      onVolume?: (volume: { volumeId: string; ownerKey: string; mounts: SandboxMount[] }) => Promise<void>;
    }): Promise<SandboxState>;
  /** Configure the restored box, activate it, and verify it is ready for the app server. */
  activate(candidate: SandboxState): Promise<void>;
  /** Download to a private, bounded temporary path for the existing archive reader. */
  download?(reference: RemoteArchiveRef, destinationPath: string): Promise<void>;
  /** Explicit resource cleanup after a durable backup; never deletes S3 snapshots. */
  removeVolume?(volumeId: string): Promise<void>;
}

export function matchesRemoteArchive(reference: RemoteArchiveRef, metadata: RemoteArchiveMetadata): boolean {
  if (reference.storageType === 'cellbox-volume' || metadata.storageType === 'cellbox-volume')
    return reference.storageType === 'cellbox-volume' && metadata.storageType === 'cellbox-volume'
      && reference.volumeId === metadata.volumeId && reference.snapshotId === metadata.snapshotId;
  return metadata.id === reference.id && metadata.createdAt === reference.createdAt
    && metadata.sizeBytes === reference.sizeBytes && metadata.sha256 === reference.sha256
    && metadata.imageId === reference.imageId && metadata.sourceSandboxId === reference.sourceSandboxId
    && Boolean(metadata.portable) === Boolean(reference.portable);
}
