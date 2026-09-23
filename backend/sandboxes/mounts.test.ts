import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadSandboxConfig } from './mounts.js';

test('loads Box runtime settings and mount mappings from sandbox.toml', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cocell-sandbox-config-'));
  const path = join(directory, 'sandbox.toml');
  try {
    await writeFile(path, `[sandbox]\nimage = "mybox:latest"\nworking_directory = "/home/user/workspace"\nuser = "user"\nuid = "1000"\ngid = "1000"\nnetwork = "cocell_default"\n\n[backup_ignore]\n"workspace/.go-cache/" = true\n"codex/auth.json" = true\n\n[r_mount]\n"~/.gitconfig" = "credentials/gitconfig"\n`);
    const config = await loadSandboxConfig(path);
    assert.deepEqual(config.runtime, {
      image: 'mybox:latest', workingDirectory: '/home/user/workspace', user: 'user', uid: 1000, gid: 1000, network: 'cocell_default',
    });
    assert.deepEqual(config.mounts, [{ source: join(directory, 'credentials/gitconfig'), destination: '/home/user/.gitconfig', readonly: true }]);
    assert.deepEqual(config.backupIgnore, ['workspace/.go-cache/', 'codex/auth.json']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('rejects backup exclusions outside project data', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cocell-sandbox-config-'));
  const path = join(directory, 'sandbox.toml');
  try {
    await writeFile(path, '[backup_ignore]\n"../credentials" = true\n');
    await assert.rejects(loadSandboxConfig(path), /must stay relative/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('rejects unknown sandbox settings', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cocell-sandbox-config-'));
  const path = join(directory, 'sandbox.toml');
  try {
    await writeFile(path, '[sandbox]\nunknown = "value"\n');
    await assert.rejects(loadSandboxConfig(path), /unsupported sandbox setting/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
