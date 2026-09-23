import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ARCHIVE_FORMAT } from './formats.js';
import { ArchiveContentService, RevisionDriver } from './content.js';
import { ResticArchives } from './restic.js';

const binary = process.env.RESTIC_BINARY ?? 'restic';
let available = true;
try { execFileSync(binary, ['version']); } catch { available = false; }

test('Restic stores incremental project snapshots and restores the relative layout', { skip: !available }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'cocell-restic-'));
  try {
    const source = join(root, 'source');
    await mkdir(join(source, 'workspace', '.go-cache'), { recursive: true });
    await mkdir(join(source, 'codex'), { recursive: true });
    await writeFile(join(source, 'workspace', 'file.txt'), 'first version');
    await writeFile(join(source, 'workspace', '.go-cache', 'cache'), 'not backed up');
    await writeFile(join(source, 'codex', 'thread.jsonl'), '{"thread":1}\n');
    const restic = new ResticArchives({ repositoryRoot: join(root, 'repositories'), passwordFile: join(root, 'credentials', 'password'), binary });
    const repositoryId = randomUUID();
    const sandboxId = 'a'.repeat(64);
    await restic.ready();
    const first = await restic.snapshot(repositoryId, sandboxId, source, ['workspace/.go-cache/']);
    assert.ok(first.repositorySizeBytes > 0);
    const second = await restic.snapshot(repositoryId, sandboxId, source, ['workspace/.go-cache/']);
    assert.notEqual(first.snapshotId, second.snapshotId);
    assert.ok(second.addedBytes < first.addedBytes);
    await writeFile(join(source, 'workspace', 'file.txt'), 'second version');
    const third = await restic.snapshot(repositoryId, sandboxId, source, ['workspace/.go-cache/']);
    const content = new ArchiveContentService(new RevisionDriver(restic));
    const archive = { format: ARCHIVE_FORMAT.snapshot, repositoryId, snapshotId: third.snapshotId,
      logicalSizeBytes: third.logicalSizeBytes, bytesAdded: third.addedBytes, createdAt: new Date().toISOString() };
    await content.validate(archive);
    assert.ok((await content.listFiles(archive, 'workspace')).entries.some(item => item.name === 'workspace/file.txt'));
    assert.equal((await content.readFile(archive, 'workspace/file.txt')).content, 'second version');
    await assert.rejects(content.readFile(archive, '../credentials'), /无效的文件路径/);
    const command = (args: string[]) => execFileSync(binary, ['-r', restic.repository(repositoryId), '--password-file', restic.passwordFile, ...args], { encoding: 'utf8' });
    const listing = command(['ls', '--json', third.snapshotId, '/workspace']);
    assert.match(listing, /file\.txt/);
    assert.equal(command(['dump', third.snapshotId, '/workspace/file.txt']), 'second version');
    const restored = join(root, 'restored');
    await content.restore(archive, { restoreFromFile: async () => { throw new Error('wrong restore capability'); },
      restoreIntoDirectory: populate => populate(restored) });
    assert.equal(await readFile(join(restored, 'workspace', 'file.txt'), 'utf8'), 'second version');
    assert.equal(await readFile(join(restored, 'codex', 'thread.jsonl'), 'utf8'), '{"thread":1}\n');
    await assert.rejects(readFile(join(restored, 'workspace', '.go-cache', 'cache')));
    await restic.forget(repositoryId, first.snapshotId);
    await restic.forget(repositoryId, first.snapshotId);
    await restic.prune(repositoryId);
    assert.equal((await restic.listSnapshots(repositoryId)).includes(first.snapshotId), false);
    await restic.verify(repositoryId, third.snapshotId);
    await restic.checkDataSubset(repositoryId, 10);
  } finally { await rm(root, { recursive: true, force: true }); }
});
