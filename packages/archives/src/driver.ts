import type { ArchiveFileContent, ArchiveListing, ArchiveRestoreTarget, ArchiveVersionDetails } from './contract.js';
import type { ArchiveArtifact, ArchiveSource, ArchiveVersion } from './types.js';

export interface ArchiveCommand {
  executable: string;
  args: readonly string[];
  cwd?: string;
  /** Passed only to the command process; values may contain credentials. */
  env?: Readonly<Record<string, string>>;
}

export interface ArchiveCommandInput {
  storeId: string;
  sandboxId: string;
  sourceRoot: string;
  storagePath: string;
  ignores: readonly string[];
}

export interface ArchiveReference { storeId: string; revisionId: string }

/** Internal storage contract for command-driven backups and stored content. */
export interface ArchiveDriver {
  readonly format: ArchiveArtifact['format'];
  /** Command to run in a Sandbox. Keep credentials out of argv. */
  getCmd(input: ArchiveCommandInput): Promise<ArchiveCommand>;
  initialize(): Promise<void>;
  prepare(storeId: string, sourceRoot: string): Promise<void>;
  /** Remove physical artifacts. The caller owns reference checks and metadata cleanup. */
  remove(items: readonly ArchiveReference[]): Promise<void>;
  unrecordedVersions(referenced: Set<string>): Promise<ArchiveReference[]>;
  validate(archive: ArchiveArtifact): Promise<void>;
  listFiles(source: ArchiveSource, path: string): Promise<ArchiveListing>;
  readFile(source: ArchiveSource, path: string): Promise<ArchiveFileContent>;
  restore(archive: ArchiveArtifact, target: ArchiveRestoreTarget): Promise<void>;
  describe(version: ArchiveVersion): ArchiveVersionDetails;
}
