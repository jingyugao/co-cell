import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { SecretSupportFile } from '../../protocol/secret-types.js';
import { SecretCrypto } from './crypto.js';
import type { StoredSecret } from './repository.js';
import { NativeSecretFiles } from './native-files.js';

const secretId = '123e4567-e89b-42d3-a456-426614174000';
const versionId = '223e4567-e89b-42d3-a456-426614174000';
const otherVersionId = '323e4567-e89b-42d3-a456-426614174000';
const key = Buffer.alloc(32, 7).toString('base64');
const config = JSON.stringify({ apps: [{ appId: 'cli_fixture', appSecret: { source: 'keychain', id: 'appsecret:cli_fixture' }, brand: 'feishu', defaultAs: 'user', users: [{ userOpenId: 'ou_fixture', userName: 'Test User' }] }] });
const supportFiles = (): SecretSupportFile[] => [
  { path: '.local/share/lark-cli/master.key', encoding: 'base64', content: Buffer.alloc(32, 1).toString('base64') },
  { path: '.local/share/lark-cli/appsecret_cli_fixture.enc', encoding: 'base64', content: Buffer.alloc(40, 2).toString('base64') },
  { path: '.local/share/lark-cli/cli_fixture_ou_fixture.enc', encoding: 'base64', content: Buffer.alloc(80, 3).toString('base64') },
];

function secret(crypto: SecretCrypto, format: StoredSecret['format'], path: string, payload: string, id = secretId, version = versionId): StoredSecret {
  return { id, name: 'Synthetic credential', format, mutable: true, enabled: true, version: 1, currentVersionId: version,
    ciphertext: crypto.seal(id, version, Buffer.from(payload)), createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    tool: format === 'lark' ? 'lark-cli' : 'synthetic-tool', path, alias: 'default' };
}

async function withRoot(run: (root: string, crypto: SecretCrypto) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'cocell-native-files-'));
  const crypto = new SecretCrypto(key);
  try { await run(root, crypto); } finally { await rm(root, { recursive: true, force: true }); }
}

function fileAt(root: string, id: string, path: string, shared = false) { return shared ? join(root, path) : join(root, id, path); }

test('stores only native text files, returns a reference, and reads live CLI edits into memory', async () => {
  await withRoot(async (root, crypto) => {
    const first = new NativeSecretFiles(root, crypto), second = new NativeSecretFiles(root, crypto);
    await Promise.all([first.init(), second.init()]);
    const original = '[client]\nuser=fixture\npassword=synthetic-secret\n';
    const source = secret(crypto, 'text', '.my.cnf', original);
    const prepared = await first.prepare(source, versionId, source.ciphertext);
    assert.match(prepared.reference, /^native:v1:/);
    assert.equal(await readFile(fileAt(root, secretId, '.my.cnf', true), 'utf8'), original);
    assert.deepEqual(await readdir(root), ['.my.cnf']);
    assert.equal((await lstat(fileAt(root, secretId, '.my.cnf', true))).mode & 0o777, 0o600);

    const edited = '[client]\nuser=fixture\npassword=refreshed-by-cli\n';
    await writeFile(fileAt(root, secretId, '.my.cnf', true), edited);
    const descriptor = { ...source, ciphertext: prepared.reference };
    const instanceRead = await second.read(descriptor);
    assert.equal(crypto.open(secretId, versionId, instanceRead).toString('utf8'), edited);
    assert.equal(await readFile(fileAt(root, secretId, '.my.cnf', true), 'utf8'), edited);
  });
});

test('stores Lark primary and binary companion files and reconstructs the encrypted bundle in memory', async () => {
  await withRoot(async (root, crypto) => {
    const files = new NativeSecretFiles(root, crypto); await files.init();
    const payload = JSON.stringify({ content: config, supportFiles: supportFiles(), supportVersion: 1 });
    const source = secret(crypto, 'lark', '.lark-cli/config.json', payload);
    const prepared = await files.prepare(source, versionId, source.ciphertext);
    assert.equal(await readFile(fileAt(root, secretId, '.lark-cli/config.json', true), 'utf8'), config);
    for (const companion of supportFiles()) {
      assert.deepEqual(await readFile(fileAt(root, secretId, companion.path, true)), Buffer.from(companion.content, 'base64'));
    }
    const stored = await files.read({ ...source, ciphertext: prepared.reference });
    const opened = JSON.parse(crypto.open(secretId, versionId, stored).toString('utf8'));
    assert.equal(opened.content, config);
    assert.deepEqual(opened.supportFiles, supportFiles());
    assert.deepEqual((await readdir(join(root, '.local/share/lark-cli'))).sort(), [
      'appsecret_cli_fixture.enc', 'cli_fixture_ou_fixture.enc', 'master.key',
    ]);
  });
});

test('maps legacy file bundles to native paths without writing a bundle blob or version backup', async () => {
  await withRoot(async (root, crypto) => {
    const files = new NativeSecretFiles(root, crypto); await files.init();
    const bundle = JSON.stringify({ files: [
      { path: '.tool/config.json', content: '{"token":"synthetic"}' },
      { path: '.tool/key.bin', content: Buffer.from([0, 7, 128, 255]).toString('base64'), encoding: 'base64' },
    ] });
    const source = secret(crypto, 'files', '.tool/config.json', bundle);
    const prepared = await files.prepare(source, versionId, source.ciphertext);
    assert.equal(await readFile(fileAt(root, secretId, '.tool/config.json', true), 'utf8'), '{"token":"synthetic"}');
    assert.deepEqual(await readFile(fileAt(root, secretId, '.tool/key.bin', true)), Buffer.from([0, 7, 128, 255]));
    assert.deepEqual((await readdir(join(root, '.tool'))).sort(), ['config.json', 'key.bin']);
    const stored = await files.read({ ...source, ciphertext: prepared.reference });
    assert.deepEqual(JSON.parse(crypto.open(secretId, versionId, stored).toString('utf8')).files, JSON.parse(bundle).files);
  });
});

test('registers shared HOME without a project reference or credential body files', async () => {
  await withRoot(async (root, crypto) => {
    const files = new NativeSecretFiles(root, crypto); await files.init();
    const textSource = secret(crypto, 'text', '.meegle/config.json', '{"token":"shared"}');
    const textPrepared = await files.prepare(textSource, versionId, textSource.ciphertext);
    const textBytes = await readFile(fileAt(root, secretId, '.meegle/config.json', true));
    const textHome = secret(crypto, 'home', '.meegle/config.json', '{}', secretId, otherVersionId);
    const textHomePrepared = await files.prepare(textHome, otherVersionId, textHome.ciphertext,
      { ...textSource, ciphertext: textPrepared.reference });
    assert(!textHomePrepared.reference.includes('homeProject'));
    assert.deepEqual(await readFile(fileAt(root, secretId, '.meegle/config.json', true)), textBytes,
      'Converting a text credential to the shared HOME registration must retain its native file');

    const larkId = '823e4567-e89b-42d3-a456-426614174000';
    const larkPayload = JSON.stringify({ content: config, supportFiles: supportFiles(), supportVersion: 1 });
    const larkSource = secret(crypto, 'lark', '.lark-cli/config.json', larkPayload, larkId);
    const larkPrepared = await files.prepare(larkSource, versionId, larkSource.ciphertext);
    const larkPaths = [larkSource.path!, ...supportFiles().map(file => file.path)];
    const larkBytes = await Promise.all(larkPaths.map(path => readFile(fileAt(root, larkId, path, true))));
    const larkHome = secret(crypto, 'home', larkSource.path!, '{}', larkId, otherVersionId);
    const larkHomePrepared = await files.prepare(larkHome, otherVersionId, larkHome.ciphertext,
      { ...larkSource, ciphertext: larkPrepared.reference });
    assert(!larkHomePrepared.reference.includes('homeProject'));
    assert.deepEqual(await Promise.all(larkPaths.map(path => readFile(fileAt(root, larkId, path, true)))), larkBytes,
      'Converting a Lark credential to the shared HOME registration must retain config and companion files');
    const stored = await files.read({ ...larkHome, ciphertext: larkHomePrepared.reference });
    assert.deepEqual(JSON.parse(crypto.open(larkId, otherVersionId, stored).toString('utf8')), {});
  });
});

test('preserves unbound legacy JSON and arbitrary binary bytes without inventing tool registrations', async () => {
  await withRoot(async (root, crypto) => {
    const files = new NativeSecretFiles(root, crypto); await files.init();
    for (const [format, id, filename, bytes] of [
      ['json', secretId, 'config.json', Buffer.from('{"legacy":"native-config"}')],
      ['binary', '723e4567-e89b-42d3-a456-426614174000', 'credentials.bin', Buffer.from([0, 255, 128, 3, 0])],
    ] as const) {
      const old: StoredSecret = { ...secret(crypto, 'text', 'unused', '', id), format, tool: null, path: null,
        ciphertext: crypto.seal(id, versionId, bytes) };
      const prepared = await files.prepare(old, versionId, old.ciphertext);
      assert.deepEqual(await readFile(fileAt(root, id, filename)), bytes);
      const loaded = await files.read({ ...old, ciphertext: prepared.reference });
      assert.deepEqual(crypto.open(id, versionId, loaded), bytes);
      assert.equal(old.tool, null); assert.equal(old.path, null);
      assert(!prepared.reference.includes(bytes.toString('base64')));
    }
  });
});

test('rollback restores prior native bytes after a prepared content change', async () => {
  await withRoot(async (root, crypto) => {
    const files = new NativeSecretFiles(root, crypto); await files.init();
    const path = fileAt(root, secretId, '.config/credentials.json', true);
    await mkdir(join(root, '.config'), { recursive: true });
    await writeFile(path, 'old-native-state');
    const candidate = secret(crypto, 'text', '.config/credentials.json', 'new-native-state', secretId, otherVersionId);
    const prepared = await files.prepare(candidate, otherVersionId, candidate.ciphertext);
    assert.equal(await readFile(path, 'utf8'), 'new-native-state');
    await prepared.rollback();
    assert.equal(await readFile(path, 'utf8'), 'old-native-state');
  });
});

test('changing a registered path removes the superseded native file and rollback restores it', async () => {
  await withRoot(async (root, crypto) => {
    const files = new NativeSecretFiles(root, crypto); await files.init();
    const old = secret(crypto, 'text', '.tool/old.conf', 'old-native-state');
    const first = await files.prepare(old, versionId, old.ciphertext);
    const next = secret(crypto, 'text', '.tool/new.conf', 'new-native-state', secretId, otherVersionId);
    const prepared = await files.prepare(next, otherVersionId, next.ciphertext, { ...old, ciphertext: first.reference });
    await assert.rejects(readFile(fileAt(root, secretId, '.tool/old.conf', true)), { code: 'ENOENT' });
    assert.equal(await readFile(fileAt(root, secretId, '.tool/new.conf', true), 'utf8'), 'new-native-state');
    await prepared.rollback();
    assert.equal(await readFile(fileAt(root, secretId, '.tool/old.conf', true), 'utf8'), 'old-native-state');
    await assert.rejects(readFile(fileAt(root, secretId, '.tool/new.conf', true)), { code: 'ENOENT' });
  });
});

test('rejects traversal, malformed or mismatched descriptors, and symlinked native paths', async () => {
  await withRoot(async (root, crypto) => {
    const files = new NativeSecretFiles(root, crypto); await files.init();
    const valid = secret(crypto, 'text', '.tool/config.json', 'safe-content');
    const prepared = await files.prepare(valid, versionId, valid.ciphertext);
    await assert.rejects(files.read({ ...valid, path: '.other/config.json', ciphertext: prepared.reference }));
    await assert.rejects(files.read({ ...valid, ciphertext: 'native:v1:malformed' }));

    const traversal = secret(crypto, 'text', '../escape', 'bad');
    await assert.rejects(files.prepare(traversal, versionId, traversal.ciphertext));

    const outside = join(root, 'outside'); await mkdir(outside);
    const linkedSecret = secret(crypto, 'text', '.config', 'bad', '523e4567-e89b-42d3-a456-426614174000');
    await symlink(outside, join(root, '.config'));
    await assert.rejects(files.prepare(linkedSecret, versionId, linkedSecret.ciphertext));

    const nested = secret(crypto, 'text', '.linked/config.json', 'bad', '623e4567-e89b-42d3-a456-426614174000');
    await symlink(outside, fileAt(root, nested.id, '.linked', true));
    await assert.rejects(files.prepare(nested, versionId, nested.ciphertext));
  });
});
