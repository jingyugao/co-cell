import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ResticArchives } from './restic.js';

const [repositoryId, snapshotId, rawPercentage] = process.argv.slice(2);
if (!repositoryId || !snapshotId) {
  throw new Error('Usage: pnpm backup:verify <project-uuid> <snapshot-id> [read-data-percent]');
}
const restic = new ResticArchives();
await restic.ready();
await restic.checkDataSubset(repositoryId, rawPercentage ? Number(rawPercentage) : 10);
const parent = resolve('data/restic-drills');
await mkdir(parent, { recursive: true, mode: 0o700 });
const destination = await mkdtemp(resolve(parent, 'restore-'));
try {
  await restic.restore(repositoryId, snapshotId, destination);
  process.stdout.write(`Restic snapshot ${snapshotId} passed data check and isolated restore.\n`);
} finally { await rm(destination, { recursive: true, force: true }); }
