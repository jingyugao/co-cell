import type { SandboxMount } from './sandbox-types.js';

/** Legacy downloadable archive. New backups use CellboxVolumeBackupRef. */
export interface LegacyRemoteArchiveRef {
  id: string;
  createdAt: string;
  sizeBytes: number;
  sha256: string;
  imageId: string;
  sourceSandboxId: string;
  threadIds: string[];
  storageType?: 'cellbox' | 'oss';
  /** Verified workspace archive that can be restored with another image. */
  portable?: boolean;
  metadata?: Record<string, unknown>;
}

/** A product pointer to a native Cellbox snapshot, scoped to its source volume. */
export interface CellboxVolumeBackupRef {
  storageType: 'cellbox-volume';
  /** Opaque product key containing both volumeId and snapshotId. */
  id: string;
  volumeId: string;
  snapshotId: string;
  ownerKey: string;
  profileId: string;
  /** Destinations to use when mounting a restored copy of this volume. */
  mounts: SandboxMount[];
  createdAt: string;
  sizeBytes?: number;
  addedBytes?: number;
  sourceSandboxId?: string;
  /** Threads known at capture time. External snapshots may have no saved index. */
  threadIds: string[];
  sha256?: never;
  imageId?: never;
  portable?: never;
  metadata?: never;
  /** Capture outcome; not a checksum or a guarantee about retention success. */
  retentionError?: string;
}

export type RemoteArchiveRef = LegacyRemoteArchiveRef | CellboxVolumeBackupRef;
export type RemoteArchiveMetadata = Omit<LegacyRemoteArchiveRef, 'threadIds'> | Omit<CellboxVolumeBackupRef, 'threadIds'>;

export interface VolumeBackupPolicy {
  enabled: boolean;
  engine: 'restic';
  scope: 'volume';
  keepLast: number;
}
