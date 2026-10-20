import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { ProvisionedToolFile } from '../../protocol/secret-types.js';
import { MountedToolHomes } from './mounted-home.js';

const secretId = 'lark-secret';
const files = (version: number, config = '{"currentApp":"Feishu"}') => [
  provisioned('.lark-cli/config.json', Buffer.from(config), version),
  provisioned('.lark-cli/master.key', Buffer.from([0, 1, 127, 128, 254, 255]), version),
  provisioned('.lark-cli/token.enc', Buffer.from([9, 0, 10, 200, 255]), version),
];

function provisioned(path: string, content: Buffer, version: number): ProvisionedToolFile {
  return {
    tool: 'lark-cli', secretId, path, content: content.toString('base64'),
    mutable: false, version, alias: 'Feishu', format: 'text',
  };
}

async function withHomes(run: (homes: MountedToolHomes, home: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'cocell-mounted-home-'));
  try {
    const homes = new MountedToolHomes(root);
    await homes.init();
    await run(homes, join(root, 'runtime/debug-homes'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('publishes a Lark config and binary keychain companions for one credential', async () => {
  await withHomes(async (homes, home) => {
    const bundled = files(1);
    await homes.publish(async () => bundled);

    for (const file of bundled) {
      assert.deepEqual(await readFile(join(home, file.path)), Buffer.from(file.content, 'base64'));
      assert.equal(await homes.ready({
        tool: file.tool, secretId: file.secretId, path: file.path, version: file.version,
      }), true);
    }
  });
});

test('credential publishing preserves agent access to the shared launcher directory', async () => {
  await withHomes(async (homes, home) => {
    const runtime = join(home, '..');
    await writeFile(join(runtime, 'config.json'), '{"version":1}', { mode: 0o644 });
    await chmod(runtime, 0o700);
    await homes.init();
    assert.equal((await stat(runtime)).mode & 0o777, 0o755);
    await homes.publish(async () => files(1));
    assert.equal((await stat(runtime)).mode & 0o777, 0o755);
    assert.equal((await stat(home)).mode & 0o777, 0o700);
    assert.equal((await stat(join(runtime, 'debug-home-files.json'))).mode & 0o777, 0o600);
    assert.equal(await readFile(join(runtime, 'config.json'), 'utf8'), '{"version":1}');
  });
});

test('keeps CLI-refreshed companion tokens until the credential version changes', async () => {
  await withHomes(async (homes, home) => {
    await homes.publish(async () => files(1));
    const refreshedToken = Buffer.from('refreshed-by-lark-cli');
    await writeFile(join(home, '.lark-cli/token.enc'), refreshedToken);

    await homes.publish(async () => files(1, '{"currentApp":"edited-config"}'));
    assert.deepEqual(await readFile(join(home, '.lark-cli/token.enc')), refreshedToken);
    assert.equal((await readFile(join(home, '.lark-cli/config.json'), 'utf8')), '{"currentApp":"Feishu"}');

    const updated = files(2, '{"currentApp":"updated"}');
    await homes.publish(async () => updated);
    for (const file of updated) {
      assert.deepEqual(await readFile(join(home, file.path)), Buffer.from(file.content, 'base64'));
    }
  });
});

test('revoking a credential removes all managed config and keychain files', async () => {
  await withHomes(async (homes, home) => {
    await homes.publish(async () => files(1));
    await homes.publish(async () => []);

    for (const path of ['.lark-cli/config.json', '.lark-cli/master.key', '.lark-cli/token.enc']) {
      await assert.rejects(readFile(join(home, path)), { code: 'ENOENT' });
    }
    for (const path of ['.lark-cli/config.json', '.lark-cli/master.key', '.lark-cli/token.enc']) {
      assert.equal(await homes.ready({ tool: 'lark-cli', secretId, path, version: 1 }), false);
    }
  });
});

test('rejects duplicate tool, credential, and path bindings', async () => {
  await withHomes(async (homes) => {
    const duplicated = provisioned('.lark-cli/config.json', Buffer.from('{}'), 1);
    await assert.rejects(homes.publish(async () => [duplicated, duplicated]), /Duplicate tool credential file/);
  });
});
