import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { migrateSharedDebugHome } from './migrate-shared-debug-home.mjs';

const id = '01234567-89ab-cdef-0123-456789abcdef';
const registration = (files, overrides = {}) => ({
  id, tool: 'glab', path: files[0].path, format: 'files',
  ciphertext: `native:v1:${JSON.stringify({ kind: 'files', files })}`,
  ...overrides,
});

async function withRoot(run) {
  const parent = await mkdtemp(join(tmpdir(), 'cocell-shared-home-migration-'));
  const root = join(parent, 'runtime', 'debug-homes');
  await mkdir(root, { recursive: true, mode: 0o700 });
  try { await run(root); } finally { await rm(parent, { recursive: true, force: true }); }
}

test('moves text and binary native files without changing bytes; rerun is harmless', async () => {
  await withRoot(async root => {
    const files = [{ path: 'glab/config.yml' }, { path: 'glab/ca.bin', encoding: 'base64' }];
    const sourceDir = join(root, id, 'glab');
    await mkdir(sourceDir, { recursive: true, mode: 0o700 });
    const config = Buffer.from('hosts:\n  git.example.test:\n    token: old-token\n');
    const binary = Buffer.from([0, 255, 3, 128, 13]);
    await writeFile(join(sourceDir, 'config.yml'), config);
    await writeFile(join(sourceDir, 'ca.bin'), binary);

    const preview = await migrateSharedDebugHome(root, [registration(files)]);
    assert.equal(preview.dryRun, true);
    assert.equal(preview.fileCount, 2);
    assert.equal(preview.moved, 0);
    assert.deepEqual(await readFile(join(sourceDir, 'ca.bin')), binary);

    const applied = await migrateSharedDebugHome(root, [registration(files)], { apply: true });
    assert.equal(applied.moved, 2);
    assert.deepEqual(await readFile(join(root, 'glab/config.yml')), config);
    assert.deepEqual(await readFile(join(root, 'glab/ca.bin')), binary);
    await assert.rejects(readFile(join(sourceDir, 'config.yml')), { code: 'ENOENT' });

    const repeated = await migrateSharedDebugHome(root, [registration(files)], { apply: true });
    assert.equal(repeated.alreadyMigrated, 2);
    assert.deepEqual(await readFile(join(root, 'glab/ca.bin')), binary);
  });
});

test('accepts identical target bytes and never replaces a changed target', async () => {
  await withRoot(async root => {
    const file = { path: 'glab/config.yml' };
    const source = join(root, id, file.path);
    const target = join(root, file.path);
    await mkdir(join(root, id, 'glab'), { recursive: true });
    await mkdir(join(root, 'glab'), { recursive: true });
    await writeFile(source, Buffer.from([0, 1, 2, 255]));
    await writeFile(target, Buffer.from([0, 1, 2, 255]));
    const same = await migrateSharedDebugHome(root, [registration([file])], { apply: true });
    assert.equal(same.unchangedTarget, 1);
    await assert.rejects(readFile(source), { code: 'ENOENT' });

    await writeFile(source, 'source credentials');
    await writeFile(target, 'new CLI credentials');
    await assert.rejects(migrateSharedDebugHome(root, [registration([file])], { apply: true }), /target differs/);
    assert.equal(await readFile(source, 'utf8'), 'source credentials');
    assert.equal(await readFile(target, 'utf8'), 'new CLI credentials');

    const first = { path: 'glab/first.yml' }, second = { path: 'glab/second.yml' };
    await writeFile(join(root, id, first.path), 'first source');
    await writeFile(join(root, id, second.path), 'second source');
    await writeFile(join(root, second.path), 'refreshed by CLI');
    await assert.rejects(migrateSharedDebugHome(root, [registration([first, second])], { apply: true }), /target differs/);
    assert.equal(await readFile(join(root, id, first.path), 'utf8'), 'first source');
    assert.equal(await readFile(join(root, second.path), 'utf8'), 'refreshed by CLI');
  });
});

test('supports credentials stored directly at the HOME root', async () => {
  await withRoot(async root => {
    const file = { path: '.glabrc' };
    const source = join(root, id, file.path);
    await mkdir(join(root, id), { recursive: true });
    await writeFile(source, 'host: git.example.test\n');
    const result = await migrateSharedDebugHome(root, [registration([file])], { apply: true });
    assert.equal(result.moved, 1);
    assert.equal(await readFile(join(root, file.path), 'utf8'), 'host: git.example.test\n');
  });
});

test('rejects traversal, symlinks, and duplicate shared paths before moving files', async () => {
  await withRoot(async root => {
    await assert.rejects(migrateSharedDebugHome(root, [registration([{ path: '../outside' }])]), /Unsafe registered credential path/);
    await assert.rejects(migrateSharedDebugHome(root, [registration([{ path: '/absolute' }])]), /Unsafe registered credential path/);
    await assert.rejects(migrateSharedDebugHome(root, [registration([{ path: `${id}/mysql-source.cnf` }])]), /reserved native source directory/);

    const file = { path: 'glab/config.yml' };
    await mkdir(join(root, id, 'glab'), { recursive: true });
    await symlink(join(root, 'outside'), join(root, id, 'glab', 'config.yml'));
    await assert.rejects(migrateSharedDebugHome(root, [registration([file])]), /Unsafe credential file/);

    await rm(join(root, id, 'glab', 'config.yml'));
    await writeFile(join(root, 'outside'), 'outside');
    await symlink(join(root, 'outside'), join(root, 'glab'));
    await assert.rejects(migrateSharedDebugHome(root, [registration([file])]), /Unsafe credential directory/);

    const second = '11234567-89ab-cdef-0123-456789abcdef';
    const secondRegistration = registration([file], { id: second, ciphertext: `native:v1:${JSON.stringify({ kind: 'files', files: [file] })}` });
    await assert.rejects(migrateSharedDebugHome(root, [registration([file]), secondRegistration]), /Conflicting shared HOME paths/);
    await assert.rejects(migrateSharedDebugHome(root, [registration([{ path: 'glab' }, file])], { apply: true }), /Conflicting shared HOME paths/);
  });
});
