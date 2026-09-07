import assert from 'node:assert/strict';
import { createCipheriv, pbkdf2Sync, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, type TestContext } from 'node:test';
import { readMeegleCredentials, type MeegleCredentialOptions } from '../server/meegle-credentials.js';

const accessToken = 'synthetic-access-token';
const refreshToken = 'synthetic-refresh-token-never-export';
const hostname = 'synthetic-machine', username = 'synthetic-user', machineKey = 'a'.repeat(64);
const clock = 1_800_000_000_000;
async function fixture(t: TestContext, profile = 'default') {
  const parent = fileURLToPath(new URL('../data/.tests/', import.meta.url)); await mkdir(parent, { recursive: true });
  const home = await mkdtemp(join(parent, 'meegle-access-')); const root = join(home, '.meegle'); await mkdir(root);
  t.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(join(root, 'config.json'), JSON.stringify({ current: profile, profiles: { [profile]: { host: 'project.example.test', refresh_token: 'unrelated-config-secret', headers: { 'x-long-lived-secret': 'never-export' } }, unused: { host: 'unused.example.test', user_access_token: 'unused-token' } } }));
  await writeFile(join(root, '.machine-key'), machineKey, { mode: 0o600 });
  async function credentials(token = accessToken, expires = clock + 60_000) {
    const salt = randomBytes(16), iv = randomBytes(12);
    const key = pbkdf2Sync(`${hostname}:${username}:${machineKey}:meegle-cli`, salt, 100_000, 32, 'sha256');
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify({ access_token: token, refresh_token: refreshToken, expires_at: expires, client_id: 'private-client-id' })), cipher.final()]);
    await writeFile(join(root, profile === 'default' ? 'credentials.enc' : `credentials-${profile}.enc`), JSON.stringify({ salt: salt.toString('hex'), iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex'), data: data.toString('hex') }), { mode: 0o600 });
  }
  await credentials();
  const calls: string[][] = [];
  const options: MeegleCredentialOptions = { home, hostname, username, env: {}, now: () => clock, command: async (command, args) => { calls.push([command, ...args]); return JSON.stringify({ authenticated: true, host: 'project.example.test' }); } };
  return { home, root, options, credentials, calls };
}

test('exports only short-lived access configuration and safe metadata from official encrypted format', async t => {
  const { options, calls } = await fixture(t);
  const result = (await readMeegleCredentials(options))!;
  assert.deepEqual(JSON.parse(result.configText), { current: 'default', profiles: { default: { host: 'project.example.test', user_access_token: accessToken } } });
  assert.deepEqual(result.metadata, { profile: 'default', host: 'project.example.test', authenticated: true, expiresAt: new Date(clock + 60_000).toISOString() });
  for (const value of [refreshToken, machineKey, 'private-client-id', 'never-export', 'unused-token']) assert.ok(!JSON.stringify(result).includes(value));
  assert.ok(!JSON.stringify(result.metadata).includes(accessToken));
  assert.deepEqual(calls, [['meegle', '--profile', 'default', 'auth', 'status', '--format', 'json']]);
});

test('reads refreshed credentials after official auth status completes and supports named profiles', async t => {
  const { options, credentials } = await fixture(t, 'tenant-a');
  const refreshedToken = 'freshly-refreshed-access';
  options.command = async (_command, args) => {
    assert.equal(args[1], 'tenant-a'); await credentials(refreshedToken);
    return JSON.stringify({ authenticated: true, host: 'project.example.test' });
  };
  const result = (await readMeegleCredentials(options))!;
  assert.equal(JSON.parse(result.configText).profiles['tenant-a'].user_access_token, refreshedToken);
  assert.ok(!result.configText.includes(refreshToken));
});

test('rejects expired, tampered or wrong-machine credentials with non-sensitive errors', async t => {
  const { options, root, credentials } = await fixture(t);
  const safeError = (error: unknown) => error instanceof Error && /无法导出 Meegle/.test(error.message) && !error.message.includes(accessToken) && !error.message.includes(refreshToken);
  await assert.rejects(readMeegleCredentials({ ...options, hostname: 'another-machine' }), safeError);
  await credentials(accessToken, clock - 1);
  await assert.rejects(readMeegleCredentials(options), safeError);
  await credentials();
  const path = join(root, 'credentials.enc'); const data = JSON.parse(await readFile(path, 'utf8')); data.tag = '0'.repeat(32); await writeFile(path, JSON.stringify(data));
  await assert.rejects(readMeegleCredentials(options), safeError);
});

test('does not export credentials when host auth validation fails or identifies another server', async t => {
  const { options } = await fixture(t);
  await assert.rejects(readMeegleCredentials({ ...options, command: async () => { throw new Error(refreshToken); } }), error => error instanceof Error && !error.message.includes(refreshToken));
  await assert.rejects(readMeegleCredentials({ ...options, command: async () => JSON.stringify({ authenticated: false, host: 'project.example.test' }) }), /无法导出 Meegle/);
  await assert.rejects(readMeegleCredentials({ ...options, command: async () => JSON.stringify({ authenticated: true, host: 'different.example.test' }) }), /无法导出 Meegle/);
});

test('honors explicit environment token precedence without copying OAuth refresh material', async t => {
  const { options, root } = await fixture(t);
  await rm(join(root, '.machine-key'));
  const result = (await readMeegleCredentials({ ...options, env: { MEEGLE_USER_ACCESS_TOKEN: 'env-short-lived-access' } }))!;
  assert.equal(JSON.parse(result.configText).profiles.default.user_access_token, 'env-short-lived-access');
  assert.ok(!result.configText.includes(refreshToken));
});

test('rejects unsafe profiles and symlinked private files; absence is unconfigured', async t => {
  const { options, root } = await fixture(t);
  const path = join(root, 'config.json');
  await writeFile(path, JSON.stringify({ current: '../escape', profiles: {} }));
  await assert.rejects(readMeegleCredentials(options), /无法导出 Meegle/);
  await rm(path); assert.equal(await readMeegleCredentials(options), null);
  await symlink(join(root, '.machine-key'), path);
  await assert.rejects(readMeegleCredentials(options), /无法导出 Meegle/);
});
