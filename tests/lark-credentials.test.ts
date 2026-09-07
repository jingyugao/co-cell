import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, type TestContext } from 'node:test';
import { importLarkCredentials } from '../server/lark-credentials.js';

const appSecret = 'synthetic-app-secret-reference';
const refreshToken = 'synthetic-user-refresh-token-never-copy';
const masterKey = Buffer.from('synthetic-private-master-key');
const encryptedSecret = Buffer.from('synthetic-encrypted-app-secret');
async function fixture(t: TestContext) {
  const base = fileURLToPath(new URL('../data/.tests/', import.meta.url)); await mkdir(base, { recursive: true });
  const home = await mkdtemp(join(base, 'lark-credentials-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const configDirectory = join(home, '.lark-cli');
  const dataDirectory = join(home, '.local/share/lark-cli');
  await mkdir(configDirectory, { recursive: true }); await mkdir(dataDirectory, { recursive: true });
  const configPath = join(configDirectory, 'config.json');
  await writeFile(configPath, JSON.stringify({
    userRefreshToken: refreshToken,
    apps: [{ appId: 'cli_example123', appSecret, brand: 'feishu', lang: 'zh', userAccessToken: 'never-copy-user-access', refresh_token: refreshToken, extra: 'do-not-forward-extra-fields' }],
  }));
  await writeFile(join(dataDirectory, 'appsecret_cli_example123.enc'), encryptedSecret, { mode: 0o600 });
  await writeFile(join(dataDirectory, 'master.key'), masterKey, { mode: 0o600 });
  for (const name of ['user_token.enc', 'refresh-token.json', 'debug.log', 'cache.json', 'credentials.enc']) {
    await writeFile(join(dataDirectory, name), refreshToken);
  }
  await mkdir(join(dataDirectory, 'logs')); await writeFile(join(dataDirectory, 'logs', 'request.log'), refreshToken);
  await mkdir(join(dataDirectory, 'cache')); await writeFile(join(dataDirectory, 'cache', 'token.json'), refreshToken);
  return { home, dataDirectory, configPath };
}

test('Lark import allowlists application files and fields while excluding user credentials, logs and caches', async t => {
  const { home } = await fixture(t);
  const result = (await importLarkCredentials(home))!;
  assert.deepEqual(Object.keys(result.files).sort(), [
    'lark-config/config.json',
    'lark-data/lark-cli/appsecret_cli_example123.enc',
    'lark-data/lark-cli/master.key',
  ]);
  assert.deepEqual(Buffer.from(result.files['lark-data/lark-cli/master.key']!, 'base64'), masterKey);
  assert.deepEqual(Buffer.from(result.files['lark-data/lark-cli/appsecret_cli_example123.enc']!, 'base64'), encryptedSecret);
  const config = JSON.parse(Buffer.from(result.files['lark-config/config.json']!, 'base64').toString());
  assert.deepEqual(config, { apps: [{ appId: 'cli_example123', appSecret, brand: 'feishu', lang: 'zh' }] });
  assert.deepEqual(result.connections.map(item => ({ id: item.id, type: item.type, host: item.host, username: item.username })), [
    { id: 'lark:cli_example123', type: 'lark', host: 'open.feishu.cn', username: 'cli_example123' },
  ]);
  const publicMetadata = JSON.stringify(result.connections);
  for (const secret of [appSecret, refreshToken, masterKey.toString(), encryptedSecret.toString(), 'never-copy-user-access']) assert.ok(!publicMetadata.includes(secret));
  const decodedFiles = Object.values(result.files).map(value => Buffer.from(value, 'base64').toString()).join('\n');
  assert.ok(!decodedFiles.includes(refreshToken));
  assert.ok(!decodedFiles.includes('never-copy-user-access'));
  assert.ok(!decodedFiles.includes('do-not-forward-extra-fields'));
});

test('Lark import recognizes brand and rejects unsafe app IDs before resolving a file path', async t => {
  const { home, dataDirectory, configPath } = await fixture(t);
  await writeFile(configPath, JSON.stringify({ apps: [
    { appId: 'cli_global456', appSecret: 'global-reference', brand: 'lark', lang: 'en' },
    { appId: '../escape', appSecret }, { appId: 'cli_../../private', appSecret }, { appId: 'cli_noSecret' },
  ] }));
  await writeFile(join(dataDirectory, 'appsecret_cli_global456.enc'), encryptedSecret);
  const result = (await importLarkCredentials(home))!;
  assert.equal(result.connections.length, 1);
  assert.equal(result.connections[0]!.host, 'open.larksuite.com');
  assert.ok(!Object.keys(result.files).some(path => path.includes('..')));
  assert.deepEqual(JSON.parse(Buffer.from(result.files['lark-config/config.json']!, 'base64').toString()).apps.map((app: { appId: string }) => app.appId), ['cli_global456']);
});

test('missing configuration or no configured application returns no credential bundle', async t => {
  const { home, configPath } = await fixture(t);
  await rm(configPath);
  assert.equal(await importLarkCredentials(home), undefined);
  await writeFile(configPath, JSON.stringify({ apps: [] }));
  assert.equal(await importLarkCredentials(home), undefined);
  await writeFile(configPath, JSON.stringify({ apps: [{ appId: '../bad', appSecret }] }));
  assert.equal(await importLarkCredentials(home), undefined);
});

test('corrupt configuration never exposes JSON credential fragments in an error', async t => {
  const { home, configPath } = await fixture(t);
  await writeFile(configPath, `{"apps":[{"appSecret":"${appSecret}","refresh_token":"${refreshToken}"`);
  await assert.rejects(importLarkCredentials(home), error => error instanceof Error && error.message === '无法读取飞书应用配置' && !error.message.includes(appSecret) && !error.message.includes(refreshToken));
});

test('missing application ciphertext or master key rejects without returning a partial secret bundle', async t => {
  const { home, dataDirectory, configPath } = await fixture(t);
  const sourceConfig = await readFile(configPath);
  const path = join(dataDirectory, 'appsecret_cli_example123.enc');
  await rm(path);
  const safeError = (error: unknown) => error instanceof Error && !error.message.includes(appSecret) && !error.message.includes(refreshToken) && !error.message.includes(masterKey.toString());
  await assert.rejects(importLarkCredentials(home), safeError);
  await writeFile(path, encryptedSecret); await rm(join(dataDirectory, 'master.key'));
  await assert.rejects(importLarkCredentials(home), safeError);
  assert.deepEqual(await readFile(configPath), sourceConfig);
});
