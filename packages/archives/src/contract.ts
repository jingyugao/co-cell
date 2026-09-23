import type { ArchiveArtifact, ArchiveSource, ArchiveVersion } from './types.js';
import type { ArchiveCommand } from './driver.js';

export interface ArchiveFileEntry {
  name: string;
  type: 'file' | 'directory';
  size: number;
  mtime?: string;
}

export interface ArchiveListing { entries: ArchiveFileEntry[]; rootPrefix: string }
export interface ArchiveFileContent { content: string; truncated: boolean; totalSize?: number }
/** The caller supplies both destination capabilities; the archive selects one. */
export interface ArchiveRestoreTarget {
  restoreFromFile: (path: string) => Promise<void>;
  restoreIntoDirectory: (populate: (directory: string) => Promise<void>) => Promise<void>;
}

export interface ArchiveContentContract {
  normalizePath(path: string): string | null;
  sourceFromFile(storagePath: string): ArchiveSource;
  artifactFromFile(input: { storagePath: string; sizeBytes: number; sha256: string; createdAt: string;
    metadata?: Record<string, unknown> }): Extract<ArchiveArtifact, { storagePath: string }>;
  artifactFromRevision(input: { location: { storeId: string; revisionId: string }; logicalSizeBytes: number;
    bytesAdded: number; createdAt: string; metadata?: Record<string, unknown> }): Extract<ArchiveArtifact, { repositoryId: string }>;
  validate(archive: ArchiveArtifact): Promise<void>;
  /** Return immediate children of a normalized archive-relative directory. */
  listFiles(archive: ArchiveSource, path: string): Promise<ArchiveListing>;
  /** Return at most 512 KiB of one archive-relative file. */
  readFile(archive: ArchiveSource, path: string): Promise<ArchiveFileContent>;
  /** Verify before writing to the supplied destination. */
  restore(archive: ArchiveArtifact, target: ArchiveRestoreTarget): Promise<void>;
}

export interface ArchiveFileInfo { sizeBytes: number; sha256: string }
export interface ArchiveCreatedVersion extends ArchiveFileInfo { archiveKey: string; createdAt: string }
export interface ArchiveRevisionInput {
  location: { storeId: string; revisionId: string };
  logicalSizeBytes: number;
  bytesAdded: number;
  metadata: Record<string, unknown>;
}
export interface ArchiveCapturedVersion extends Omit<ArchiveRevisionInput, 'metadata'> {
  storageSizeBytes: number;
  durationMs: number;
  engineVersion: string;
}

export interface PendingArchiveBackup {
  id: string;
  storeId: string;
}

export interface ArchiveCommandResult { exitCode: number; stdout: string }

/** Presentation fields shared by every stored version. */
export interface ArchiveVersionDetails {
  id: string;
  version: number;
  createdAt: string;
  sizeBytes: number;
  bytesAdded?: number;
  revisionId?: string;
  checksum?: string;
  label: string;
  isLatest: boolean;
  metadata: Record<string, unknown>;
}

/** The version catalog and content operations used by project workflows and HTTP routes. */
export interface ArchiveService extends ArchiveContentContract {
  readonly supportsSnapshots: boolean;
  beginBackup(input: { storeId: string; archiveKey?: string; hostBacked: boolean;
    metadata: Record<string, unknown> }): Promise<PendingArchiveBackup>;
  listPendingBackups(): Promise<PendingArchiveBackup[]>;
  commandForBackup(id: string, input: { sandboxId: string; sourceRoot: string; ignores: readonly string[] }): Promise<ArchiveCommand>;
  finishBackup(id: string, result: ArchiveCommandResult): Promise<ArchiveVersion>;
  failBackup(id: string): Promise<void>;
  initializeStorage(): Promise<void>;
  prepareSnapshot(storeId: string, sourceRoot: string): Promise<void>;
  captureSnapshot(storeId: string, sandboxId: string, sourceRoot: string, ignores: string[]): Promise<ArchiveCapturedVersion>;
  create(archiveKey: string | undefined, metadata: Record<string, unknown>,
    createFn: (destinationPath: string) => Promise<ArchiveFileInfo>): Promise<ArchiveCreatedVersion>;
  recordVersion(archiveKey: string, input: ArchiveRevisionInput): Promise<ArchiveVersion>;
  getLatest(archiveKey: string): Promise<ArchiveVersion | undefined>;
  getVersion(archiveKey: string, id: string): Promise<ArchiveVersion | undefined>;
  listVersions(archiveKey: string): Promise<ArchiveVersion[]>;
  describe(version: ArchiveVersion): ArchiveVersionDetails;
  applyRetention(archiveKey: string, keepCount: number): Promise<number>;
  revertLatestVersion(archiveKey: string, versionId: string): Promise<boolean>;
  retain(archiveKey: string, keepCount: number): Promise<number>;
  retainAll(keepCount: number): Promise<number>;
  sweep(): Promise<number>;
  sweepManagedVersions(): Promise<number>;
  unrecordedVersions(): Promise<Array<{ storeId: string; revisionId: string }>>;
  close(): Promise<void>;
}
