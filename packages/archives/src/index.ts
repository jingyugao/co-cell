import { ArchiveContentService, RevisionDriver } from './content.js';
import { ArchiveManager } from './manager.js';
import { ResticArchives } from './restic.js';
import { ArchiveDao } from './dao.js';
import type { ArchiveService } from './contract.js';

export type { ArchiveService } from './contract.js';
export type { PendingArchiveBackup, ArchiveCommandResult } from './contract.js';
export type { ArchiveCommand } from './driver.js';

/** The only public construction path; storage classes remain package-private. */
export async function createArchiveService(options: {
  databaseUrl: string;
  archivesDirectory: string;
  sandboxArchiveDirectory?: string;
  incremental?: { uid?: number; gid?: number; sandboxRepositoryRoot?: string };
}): Promise<ArchiveService> {
  const dao = new ArchiveDao(options.databaseUrl);
  try { await dao.init(); }
  catch (error) { await dao.close().catch(() => {}); throw error; }
  const storage = options.incremental ? new RevisionDriver(new ResticArchives(options.incremental)) : undefined;
  return new ArchiveManager(dao, options.archivesDirectory, storage, {
    sandboxArchiveDirectory: options.sandboxArchiveDirectory,
    sandboxRepositoryRoot: options.incremental?.sandboxRepositoryRoot,
  });
}

/** Read legacy archives when the catalog is not configured. */
export function createArchiveReader(): Pick<ArchiveService,
  'normalizePath' | 'sourceFromFile' | 'artifactFromFile' | 'artifactFromRevision' | 'validate' | 'listFiles' | 'readFile' | 'restore'> {
  return new ArchiveContentService();
}
