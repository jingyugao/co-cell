import { ARCHIVE_FORMAT } from './formats.js';

/** 归档流 — 一个逻辑实体的归档版本链 */
export interface ArchiveStream {
  archiveKey: string;
  latestVersionId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Fields shared by every stored archive version. */
interface ArchiveVersionBase {
  id: string;
  archiveKey: string;
  version: number;
  parentId: string | null;
  isLatest: boolean;
  metadata: Record<string, unknown>;
  status: 'active' | 'soft_deleted';
  createdAt: string;
  deletedAt: string | null;
}

export interface TarArchive {
  format: typeof ARCHIVE_FORMAT.file;
  storagePath: string;
  sizeBytes: number;
  sha256: string;
  createdAt: string;
  metadata?: Record<string, unknown>;
}

export interface ResticArchive {
  format: typeof ARCHIVE_FORMAT.snapshot;
  repositoryId: string;
  snapshotId: string;
  logicalSizeBytes: number;
  bytesAdded: number;
  createdAt: string;
  metadata?: Record<string, unknown>;
}

/** The format determines which storage fields must exist. */
export type ArchiveArtifact = TarArchive | ResticArchive;
export type FileArchiveVersion = ArchiveVersionBase & TarArchive & {
  repositoryId: null; snapshotId: null; logicalSizeBytes: null; bytesAdded: null;
};
export type SnapshotArchiveVersion = ArchiveVersionBase & ResticArchive & {
  storagePath: null; sizeBytes: null; sha256: null;
};
export type ArchiveVersion = FileArchiveVersion | SnapshotArchiveVersion;
export type ArchiveSource =
  | Pick<FileArchiveVersion, 'format' | 'storagePath'>
  | Pick<SnapshotArchiveVersion, 'format' | 'repositoryId' | 'snapshotId'>;

/** 创建归档版本的输入参数 */
export interface CreateArchiveVersionInput {
  id: string;
  storagePath: string;
  sizeBytes: number;
  sha256: string;
  metadata: Record<string, unknown>;
}

/** Metadata for a snapshot already created and verified in a Restic repository. */
export interface CreateResticVersionInput {
  repositoryId: string;
  snapshotId: string;
  logicalSizeBytes: number;
  bytesAdded: number;
  metadata: Record<string, unknown>;
}

export interface ArchiveListOptions {
  status?: 'active' | 'soft_deleted';
  offset?: number;
  limit?: number;
}
