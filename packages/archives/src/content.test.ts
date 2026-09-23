import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ArchiveContentService, FileDriver, RevisionDriver } from './content.js';
import { ARCHIVE_FORMAT } from './formats.js';
import type { ResticArchives } from './restic.js';

test('tar archive contract validates, browses, caps reads, and delegates restore', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cocell-archive-content-'));
  try {
    const tree = join(root, 'tree');
    await mkdir(join(tree, 'home', 'user', 'workspace'), { recursive: true });
    await mkdir(join(tree, 'home', 'user', '.codex'), { recursive: true });
    await writeFile(join(tree, 'home', 'user', 'workspace', 'file.txt'), 'hello');
    await writeFile(join(tree, 'home', 'user', '.codex', 'thread.jsonl'), '{}\n');
    await writeFile(join(tree, 'home', 'user', 'workspace', 'large.txt'), 'x'.repeat(600 * 1024));
    const archivePath = join(root, 'archive.tar.gz');
    execFileSync('tar', ['-czf', archivePath, '-C', tree, 'home']);
    const bytes = await readFile(archivePath);
    const archive = { format: ARCHIVE_FORMAT.file, storagePath: archivePath,
      sizeBytes: (await stat(archivePath)).size, sha256: createHash('sha256').update(bytes).digest('hex'),
      createdAt: new Date().toISOString() };
    const content = new ArchiveContentService();
    await content.validate(archive);
    const listing = await content.listFiles(archive, 'workspace');
    assert.equal(listing.rootPrefix, 'home/user/');
    assert.ok(listing.entries.some(item => item.name === 'workspace/file.txt'));
    assert.equal((await content.readFile(archive, 'workspace/file.txt')).content, 'hello');
    const large = await content.readFile(archive, 'workspace/large.txt');
    assert.equal(large.truncated, true);
    assert.equal(large.content.length, 512 * 1024);
    await assert.rejects(content.readFile(archive, '../escape'), /无效的文件路径/);
    let restoredFrom = '';
    await content.restore(archive, { restoreFromFile: async path => { restoredFrom = path; },
      restoreIntoDirectory: async () => { throw new Error('wrong restore capability'); } });
    assert.equal(restoredFrom, archivePath);
    await assert.rejects(content.validate({ ...archive, sha256: '0'.repeat(64) }), /checksum/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('file driver chooses the storage path and creates the artifact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cocell-archive-create-'));
  try {
    const directory = join(root, 'archives');
    const driver = new FileDriver(directory);
    const created = await driver.create({ storeId: 'store',
      revisionId: '11111111-1111-4111-8111-111111111111', write: async path => {
      await writeFile(path, 'archive');
      return { sizeBytes: 7, sha256: createHash('sha256').update('archive').digest('hex') };
    } });
    assert.equal(created.storagePath, driver.storagePath({ storeId: 'store',
      revisionId: '11111111-1111-4111-8111-111111111111' }));
    assert.equal(created.storagePath.endsWith('.tar.gz'), true);
    assert.equal((await readFile(created.storagePath, 'utf8')), 'archive');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('file driver command writes a legacy-compatible archive through a temporary file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cocell-archive-command-'));
  try {
    await mkdir(join(root, 'workspace'));
    await mkdir(join(root, 'codex'));
    await writeFile(join(root, 'workspace', 'keep.txt'), 'keep');
    await writeFile(join(root, 'workspace', 'skip.txt'), 'skip');
    await writeFile(join(root, 'codex', 'history.txt'), 'history');
    const destinationPath = join(root, 'backup.tar.gz');
    const command = await new FileDriver().getCmd({ storeId: 'store', sandboxId: 'sandbox', sourceRoot: root,
      storagePath: destinationPath, ignores: ['workspace/skip.txt'] });
    execFileSync(command.executable, [...command.args], { cwd: command.cwd, env: { ...process.env, ...command.env } });
    const entries = execFileSync('tar', ['-tzf', destinationPath], { encoding: 'utf8' });
    assert.match(entries, /home\/user\/workspace\/keep\.txt/);
    assert.match(entries, /home\/user\/\.codex\/history\.txt/);
    assert.doesNotMatch(entries, /skip\.txt/);
    await assert.rejects(stat(`${destinationPath}.partial`));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('revision driver restores through the directory target and removes supplied revisions', async () => {
  const calls: string[] = [];
  const storage = {
    async snapshot(storeId: string, _sandboxId: string, _sourceRoot: string, _ignores: string[]) {
      calls.push(`create:${storeId}`);
      return { repositoryId: storeId, snapshotId: 'new-revision', logicalSizeBytes: 20,
        addedBytes: 5, repositorySizeBytes: 30, durationMs: 1, version: 'test' };
    },
    async verify(storeId: string, revisionId: string) { calls.push(`verify:${storeId}:${revisionId}`); },
    async restore(_storeId: string, _revisionId: string, directory: string) { calls.push(`populate:${directory}`); },
    async withRepositoryLock(_storeId: string, work: () => Promise<void>) { await work(); },
    async forget(_storeId: string, revisionId: string) { calls.push(`forget:${revisionId}`); },
    async prune(storeId: string) { calls.push(`prune:${storeId}`); },
  } as unknown as ResticArchives;
  const revision = new RevisionDriver(storage);
  const content = new ArchiveContentService(revision);
  const created = await revision.create({ storeId: 'store', sandboxId: 'sandbox', sourceRoot: '/data', ignores: [] });
  assert.deepEqual(created.location, { storeId: 'store', revisionId: 'new-revision' });
  const archive = content.artifactFromRevision({ location: { storeId: 'store', revisionId: 'first' },
    logicalSizeBytes: 20, bytesAdded: 5, createdAt: '2026-09-20T00:00:00.000Z' });
  await content.restore(archive, { restoreFromFile: async () => { throw new Error('wrong target'); },
    restoreIntoDirectory: async populate => { calls.push('directory'); await populate('/target'); } });
  assert.deepEqual(calls, ['create:store', 'verify:store:first', 'directory', 'populate:/target']);
  await revision.remove([{ storeId: 'store', revisionId: 'second' }]);
  assert.deepEqual(calls.slice(-2), ['forget:second', 'prune:store']);
});

test('revision command keeps its password in the process environment', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cocell-archive-credentials-'));
  try {
    const passwordFile = join(root, 'password');
    await writeFile(passwordFile, 'secret\n');
    const storage = { passwordFile, binary: 'restic', ready: async () => {},
      ensureRepository: async (_storeId: string) => {} } as unknown as ResticArchives;
    const driver = new RevisionDriver(storage);
    const command = await driver.getCmd({ storeId: 'store', sandboxId: 'sandbox',
      sourceRoot: '/source', storagePath: '/data/repositories/store', ignores: ['workspace/cache/'] });
    assert.equal(command.executable, 'restic');
    assert.equal(command.env?.RESTIC_PASSWORD, 'secret');
    assert.equal(command.env?.RESTIC_REPOSITORY, '/data/repositories/store');
    assert.equal(command.args.includes('secret'), false);
    assert.ok(command.args.includes('--exclude=/source/workspace/cache'));
    assert.deepEqual(driver.parseCommandResult(JSON.stringify({ message_type: 'summary',
      snapshot_id: 'a'.repeat(64), total_bytes_processed: 10, data_added: 2 })),
    { snapshotId: 'a'.repeat(64), logicalSizeBytes: 10, bytesAdded: 2 });
  } finally { await rm(root, { recursive: true, force: true }); }
});
