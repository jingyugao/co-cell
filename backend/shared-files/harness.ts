import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, link, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

async function readRevision(file: string) {
  try { return (await readFile(file, 'utf8')).trim(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}

/** CoCell writes the per-Box selection; the Guest reads it from the read-only mount. */
export async function selectHarness(shared: string, boxId: string, requested?: string, initial = false) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(boxId)) throw new Error('Invalid Box ID');
  const root = join(shared, 'harness'), directory = join(root, 'boxes'), pin = join(directory, boxId);
  const existing = initial ? await readRevision(pin) : undefined;
  const revision = existing ?? requested ?? await readRevision(join(root, 'current'));
  if (initial && revision === undefined) return;
  if (!revision) throw new Error('尚未发布 Harness');
  if (!/^[0-9a-f]{64}$/.test(revision)) throw new Error('Invalid Harness revision');
  await access(join(root, 'versions', revision, 'launch'), constants.X_OK);
  if (existing) return revision;
  await mkdir(directory, { recursive: true, mode: 0o755 });
  const temp = join(directory, '.' + randomUUID());
  try {
    await writeFile(temp, revision + '\n', { flag: 'wx', mode: 0o644 });
    if (initial) {
      try { await link(temp, pin); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        return await readRevision(pin);
      }
    } else await rename(temp, pin);
  } finally { await rm(temp, { force: true }); }
  return revision;
}
