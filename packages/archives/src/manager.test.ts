import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { ArchiveDao } from './dao.js';
import type { RevisionDriver } from './content.js';
import { FileDriver } from './content.js';
import { ArchiveManager } from './manager.js';
import { ARCHIVE_FORMAT } from './formats.js';
import type { ArchiveVersion } from './types.js';

test('pending file backup becomes finished only after the command artifact is verified', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cocell-archive-flow-'));
  try {
    const archiveDirectory = join(root, 'archives');
    const sourceRoot = join(root, 'source');
    await mkdir(join(sourceRoot, 'workspace'), { recursive: true });
    await mkdir(join(sourceRoot, 'codex'));
    await writeFile(join(sourceRoot, 'workspace', 'file.txt'), 'hello');
    let storagePath = '';
    let pendingId = '';
    const events: string[] = [];
    const dao = {
      beginPendingVersion: async (id: string, _storeId: string, _format: string, path: string) => {
        pendingId = id; storagePath = path; events.push('pending');
      },
      getPendingVersion: async () => ({ id: pendingId, archiveKey: 'store',
        format: ARCHIVE_FORMAT.file, storagePath, repositoryId: null }),
      finishPendingVersion: async (_id: string, artifact: { sizeBytes: number; sha256: string }) => {
        assert.ok(artifact.sizeBytes > 0);
        assert.equal(artifact.sha256.length, 64);
        events.push('finished');
        return {} as ArchiveVersion;
      },
    } as unknown as ArchiveDao;
    const manager = new ArchiveManager(dao, archiveDirectory, undefined,
      { sandboxArchiveDirectory: archiveDirectory });
    const pending = await manager.beginBackup({ storeId: 'store', metadata: {} });
    const command = await manager.commandForBackup(pending.id,
      { sandboxId: 'sandbox', sourceRoot, ignores: [] });
    await assert.rejects(manager.finishBackup(pending.id, { exitCode: 0, stdout: '' }));
    execFileSync(command.executable, [...command.args], { cwd: command.cwd, env: { ...process.env, ...command.env } });
    await manager.finishBackup(pending.id, { exitCode: 0, stdout: '' });
    assert.deepEqual(events, ['pending', 'finished']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('revision backup verifies the reported snapshot before finishing its version', async () => {
  const events: string[] = [];
  const dao = {
    getPendingVersion: async () => ({ id: 'pending', archiveKey: 'store',
      format: ARCHIVE_FORMAT.snapshot, storagePath: null, repositoryId: 'store' }),
    finishPendingVersion: async () => { events.push('finished'); return {} as ArchiveVersion; },
  } as unknown as ArchiveDao;
  const revision = {
    format: ARCHIVE_FORMAT.snapshot,
    parseCommandResult: () => ({ snapshotId: 'a'.repeat(64), logicalSizeBytes: 12, bytesAdded: 3 }),
    validate: async () => { events.push('verified'); },
  } as unknown as RevisionDriver;
  const manager = new ArchiveManager(dao, '/unused', revision);
  await manager.finishBackup('pending', { exitCode: 0, stdout: 'summary' });
  assert.deepEqual(events, ['verified', 'finished']);
});

test('file sweep keeps rows whose physical removal fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cocell-archive-sweep-'));
  try {
    const driver = new FileDriver(root);
    const goodId = '11111111-1111-4111-8111-111111111111';
    const failedId = '22222222-2222-4222-8222-222222222222';
    const file = driver.storagePath({ storeId: 'store', revisionId: goodId });
    const directory = driver.storagePath({ storeId: 'store', revisionId: failedId });
    await mkdir(join(file, '..'), { recursive: true });
    await writeFile(file, 'archive');
    await mkdir(directory);
    const deleted: string[][] = [];
    const dao = {
      listSoftDeleted: async () => [{ id: goodId, storeId: 'store' }, { id: failedId, storeId: 'store' }],
      hardDelete: async (ids: string[]) => { deleted.push(ids); },
    } as unknown as ArchiveDao;
    const manager = new ArchiveManager(dao, root);
    assert.equal(await manager.sweep(), 1);
    assert.deepEqual(deleted, [[goodId]]);
    await assert.rejects(stat(file));
    assert.equal((await stat(directory)).isDirectory(), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('revision sweep checks references and deletes rows only after physical removal', async () => {
  const calls: string[] = [];
  const dao = {
    listSoftDeletedRestic: async () => [
      { id: 'referenced', repositoryId: 'store', snapshotId: 'first' },
      { id: 'retired', repositoryId: 'store', snapshotId: 'second' },
    ],
    isSnapshotReferenced: async (_storeId: string, revisionId: string) => revisionId === 'first',
    hardDelete: async (ids: string[]) => { calls.push(`delete:${ids.join(',')}`); },
  } as unknown as ArchiveDao;
  let fail = true;
  const revision = {
    remove: async (items: readonly { storeId: string; revisionId: string }[]) => {
      calls.push(`remove:${items.map(item => item.revisionId).join(',')}`);
      if (fail) throw new Error('prune failed');
    },
  } as unknown as RevisionDriver;
  const manager = new ArchiveManager(dao, '/unused', revision);
  await assert.rejects(manager.sweepManagedVersions(), /prune failed/);
  assert.deepEqual(calls, ['remove:second']);
  fail = false;
  assert.equal(await manager.sweepManagedVersions(), 1);
  assert.deepEqual(calls, ['remove:second', 'remove:second', 'delete:retired']);
});
