/** Persisted archive format identifiers. Keep these values stable for existing rows. */
export const ARCHIVE_FORMAT = {
  file: 'tar-gz-v1',
  snapshot: 'restic-v1',
} as const;
