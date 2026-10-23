import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ToolCredentialFiles } from '../tools/credentials.js';

async function withCredentials(run: (files: ToolCredentialFiles, home: string) => Promise<void>, excludedPaths: string[] = []) {
  const root = await mkdtemp(join(tmpdir(), 'cocell-tool-credential-files-'));
  const home = join(root, 'runtime/debug-homes');
  await mkdir(home, { recursive: true });
  const configuration = async (tool: string) => ({
    roots: tool === 'fixture' ? ['.fixture'] : ['.linked'],
    excludedPaths: tool === 'fixture' ? excludedPaths : [],
    context: { tool, primaryPath: '.fixture/config' },
    scriptVersion: 1,
  });
  const files = new ToolCredentialFiles(root, configuration, async action => action());
  try { await run(files, home); } finally { await rm(root, { recursive: true, force: true }); }
}

test('credential editor preserves BOM and CRLF text bytes and rejects stale writes', async () => {
  await withCredentials(async (files, home) => {
    await mkdir(join(home, '.fixture'));
    const original = Buffer.from('\uFEFF[client]\r\nuser=fixture\r\n');
    await writeFile(join(home, '.fixture/config'), original, { mode: 0o600 });
    const opened = await files.read('fixture', '.fixture/config');
    assert.equal(opened.encoding, 'utf8');
    assert.equal(opened.content, original.toString('utf8'));
    await files.write('fixture', { path: opened.path, content: opened.content, encoding: opened.encoding,
      version: opened.version, scriptVersion: opened.scriptVersion });
    assert.deepEqual(await readFile(join(home, '.fixture/config')), original);

    await assert.rejects(files.write('fixture', { path: opened.path, content: 'stale', encoding: opened.encoding,
      version: 'stale-version', scriptVersion: opened.scriptVersion }), /更新|改变/);
  });
});

test('credential editor round trips binary Base64 and refuses traversal or symlink paths', async () => {
  await withCredentials(async (files, home) => {
    await mkdir(join(home, '.fixture'));
    const binary = Buffer.from([0, 7, 128, 255]);
    await writeFile(join(home, '.fixture/key'), binary, { mode: 0o600 });
    const opened = await files.read('fixture', '.fixture/key');
    assert.equal(opened.encoding, 'base64');
    await files.write('fixture', { path: opened.path, content: opened.content, encoding: opened.encoding,
      version: opened.version, scriptVersion: opened.scriptVersion });
    assert.deepEqual(await readFile(join(home, '.fixture/key')), binary);
    await assert.rejects(files.read('fixture', '../outside'), /路径|目录/);

    const outside = join(home, 'outside');
    await mkdir(outside);
    await symlink(outside, join(home, '.linked'));
    await assert.rejects(files.tree('other'), /符号链接/);
  });
});

test('credential initialization creates missing paths with private modes and preserves existing files', async () => {
  await withCredentials(async (files, home) => {
    const existingDirectory = join(home, '.fixture');
    await mkdir(existingDirectory);
    const existingFile = join(existingDirectory, 'already-there');
    const original = Buffer.from('keep these bytes');
    await writeFile(existingFile, original, { mode: 0o640 });

    const inventory = await files.tree('fixture');
    await files.initialize('fixture', {
      version: inventory.version,
      directories: ['.fixture/private/subdir'],
      files: [
        { path: '.fixture/private/subdir/new-file', content: 'created', encoding: 'utf8' },
        { path: '.fixture/already-there', content: 'replace me', encoding: 'utf8' },
      ],
    });

    assert.equal(await readFile(join(home, '.fixture/private/subdir/new-file'), 'utf8'), 'created');
    assert.equal((await stat(join(home, '.fixture/private'))).mode & 0o777, 0o700);
    assert.equal((await stat(join(home, '.fixture/private/subdir'))).mode & 0o777, 0o700);
    assert.equal((await stat(join(home, '.fixture/private/subdir/new-file'))).mode & 0o777, 0o600);
    assert.deepEqual(await readFile(existingFile), original);
    assert.equal((await stat(existingFile)).mode & 0o777, 0o640);
  });
});

test('credential initialization rejects stale inventories before creating any requested path', async () => {
  await withCredentials(async (files, home) => {
    await mkdir(join(home, '.fixture'));
    await writeFile(join(home, '.fixture/current'), 'initial');
    const inventory = await files.tree('fixture');
    await writeFile(join(home, '.fixture/current'), 'changed after inventory');

    await assert.rejects(files.initialize('fixture', {
      version: inventory.version,
      directories: ['.fixture/new-directory'],
      files: [{ path: '.fixture/new-directory/key', content: 'private', encoding: 'utf8' }],
    }), /更新|改变|冲突|stale/i);
    await assert.rejects(stat(join(home, '.fixture/new-directory')));
  });
});

test('credential initialization validates all paths and Base64 before mutating the home', async () => {
  await withCredentials(async (files, home) => {
    await mkdir(join(home, '.fixture'));
    const outside = join(home, 'outside');
    await mkdir(outside);
    await symlink(outside, join(home, '.fixture/link'));
    const inventory = await files.tree('fixture');
    const cases = [
      { directories: ['../outside'], files: [] },
      { directories: ['.linked/escape'], files: [] },
      { directories: ['.fixture/link/escape'], files: [] },
      { directories: ['.fixture/collision'], files: [{ path: '.fixture/collision', content: 'file', encoding: 'utf8' as const }] },
      { directories: ['.fixture/excluded'], files: [] },
      { directories: [], files: [{ path: '.fixture/invalid-base64', content: '%%%not-base64%%%', encoding: 'base64' as const }] },
    ];

    for (const invalid of cases) {
      await assert.rejects(files.initialize('fixture', { version: inventory.version, ...invalid }));
    }

    await assert.rejects(stat(join(home, '.fixture/invalid-base64')));
    await assert.rejects(stat(join(home, '.fixture/collision')));
  }, ['.fixture/excluded']);
});
