import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { publishSharedDirectory } from './mount.js';
import { SharedFiles } from './service.js';
import { loadSharedMountConfig } from './config.js';

test('mounted shared files migrate once, retain edits/deletions and publish readable atomic configuration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cocell-shared-'));
  const legacy = join(root, 'data'), shared = join(root, 'shared');
  const config = { version: 1, appServerArgs: [], env: { CODEX_API_KEY: 'first' } };
  try {
    await mkdir(join(legacy, 'docs'), { recursive: true });
    await writeFile(join(legacy, 'AGENTS.md'), 'instructions');
    await writeFile(join(legacy, 'docs', 'old.txt'), 'document', { mode: 0o600 });
    await writeFile(join(legacy, 'private.json'), 'not shared');
    const mounts = join(root, 'mounts.json');
    await writeFile(mounts, JSON.stringify({ sharedDirectory: { enabled: true, hostPath: '/srv/shared', nodeName: 'test-node' } }));
    assert.equal(await loadSharedMountConfig(mounts), true);
    await writeFile(mounts, JSON.stringify({ sharedDirectory: { enabled: true, hostPath: '/', nodeName: '' } }));
    await assert.rejects(loadSharedMountConfig(mounts), /hostPath and nodeName/);
    await publishSharedDirectory(shared, legacy, config);
    assert.equal(await readFile(join(shared, 'AGENTS.md'), 'utf8'), 'instructions');
    assert.equal(await stat(join(shared, 'private.json')).catch(() => null), null);
    assert.equal((await stat(join(shared, 'docs', 'old.txt'))).mode & 0o777, 0o644);
    const files = new SharedFiles(shared, true);
    const old = await files.read('docs/old.txt');
    await files.delete(old.path, old.version);
    await files.write('docs/nested/new.txt', 'new content');
    assert.equal((await stat(join(shared, 'docs', 'nested', 'new.txt'))).mode & 0o777, 0o644);
    await publishSharedDirectory(shared, legacy, { ...config, env: { CODEX_API_KEY: 'second' } });
    assert.equal(await stat(join(shared, 'docs', 'old.txt')).catch(() => null), null);
    assert.equal((await files.read('docs/nested/new.txt')).content, 'new content');
    assert.equal(JSON.parse(await readFile(join(shared, 'runtime', 'config.json'), 'utf8')).env.CODEX_API_KEY, 'second');
    await assert.rejects(files.read('runtime/config.json'), /路径须为/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
