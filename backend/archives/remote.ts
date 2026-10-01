import type { SandboxState } from '../../protocol/sandbox-types.js';
import type { RemoteArchiveMetadata, RemoteArchiveRef } from '../../protocol/remote-archive-types.js';
import type { WorkspaceTarget } from '../sandboxes/types.js';

/** Optional runtime capability for Cellbox-owned archives. */
export interface RemoteArchives {
  /** Capture and verify the current box. The idempotency key was persisted before this call. */
  capture(target: WorkspaceTarget, idempotencyKey: string): Promise<RemoteArchiveMetadata>;
  /** Verify that the specific owned archive still exists and matches its saved metadata. */
  inspect(reference: RemoteArchiveRef): Promise<RemoteArchiveMetadata>;
  /** Restore into a staged box. Notify about its ID before subsequent setup can fail. */
  restore(target: WorkspaceTarget, reference: RemoteArchiveRef, idempotencyKey: string,
    onCandidate: (sandbox: SandboxState) => Promise<void>): Promise<SandboxState>;
  /** Configure the restored box, activate it, and verify it is ready for the app server. */
  activate(candidate: SandboxState): Promise<void>;
  /** Download to a private, bounded temporary path for the existing archive reader. */
  download?(reference: RemoteArchiveRef, destinationPath: string): Promise<void>;
  /** Remove an owned archive from Cellbox. Treat an already missing archive as removed. */
  remove?(reference: RemoteArchiveRef): Promise<void>;
}

export function matchesRemoteArchive(reference: RemoteArchiveRef, metadata: RemoteArchiveMetadata): boolean {
  return metadata.id === reference.id && metadata.createdAt === reference.createdAt
    && metadata.sizeBytes === reference.sizeBytes && metadata.sha256 === reference.sha256
    && metadata.imageId === reference.imageId && metadata.sourceSandboxId === reference.sourceSandboxId
    && Boolean(metadata.portable) === Boolean(reference.portable);
}
