import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, type TestContext } from 'node:test';
import type { Thread } from '@openai/codex-sdk';
import { createApp } from '../server/app.js';
import { ConnectionStore, type LocalCommand } from '../server/connections.js';
import { SessionManager, type CodexClient } from '../server/manager.js';
import type { ConnectionInventory } from '../shared/connection-types.js';
import type { AppConfig } from '../shared/types.js';

const token = 'test-token-three';
const password = 'synthetic-api-password:$@';
const mysqlBytes = Buffer.from('synthetic-private-mysql-file');
const larkKey = Buffer.from('synthetic-private-lark-master-key');
const larkSecret = Buffer.from('synthetic-private-lark-app-secret');
const privateValues = [token, password, encodeURIComponent(password), mysqlBytes.toString(), mysqlBytes.toString('base64'), larkKey.toString(), larkKey.toString('base64'), larkSecret.toString(), larkSecret.toString('base64')];

async function fixture(t: TestContext, initialized = true) {
  const base = fileURLToPath(new URL('../data/.tests/', import.meta.url));
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, 'connections-api-'));
  const home = join(root, 'home'), directory = join(root, 'encrypted');
  const calls: Array<{ command: string; args: string[] }> = [];
  let failMysql = false;
  const command: LocalCommand = async (name, args) => {
    calls.push({ command: name, args });
    if (name === 'mysql_config_editor') {
      if (failMysql) throw new Error(`command output: ${password}`);
      return '[analytics]\nuser = "readonly-user"\npassword = *****\nhost = "db.example.test"\n';
    }
    if (name === 'glab') return token;
    if (name === 'git' && args[0] === 'credential') return `protocol=https\nhost=lab.example.test\nusername=git-user\npassword=${password}\n`;
    if (name === 'git' && args.includes('user.name')) return 'Example Commit Author';
    if (name === 'git' && args.includes('user.email')) return 'author@example.test';
    return '';
  };
  const store = new ConnectionStore({ home, directory, keyPath: join(root, 'key', 'credentials.key'), command });
  const config: AppConfig = {
    defaults: { workingDirectory: root, model: '', modelReasoningEffort: 'high', sandboxMode: 'read-only', webSearchMode: 'disabled', networkAccessEnabled: false },
    sdkVersion: 'test', auth: 'local-codex', approvalPolicy: 'never', capabilities: { interactiveApprovals: false, tokenDeltas: false },
  };
  const thread = {} as Thread;
  const client: CodexClient = { startThread: () => thread, resumeThread: () => thread };
  const manager = new SessionManager(client, join(root, 'sessions'), config.defaults);
  await manager.init();
  t.after(async () => { await manager.close(); await rm(root, { recursive: true, force: true }); });
  const app = createApp(manager, config, ['localhost:3001'], undefined, undefined, undefined, undefined, initialized ? store : undefined);
  const request = (path: string, init: RequestInit = {}) => app.request(`http://localhost:3001${path}`, { ...init, headers: { host: 'localhost:3001', ...init.headers } });
  const seed = async () => {
    await mkdir(join(home, '.config/glab-cli'), { recursive: true });
    await mkdir(join(home, '.lark-cli'), { recursive: true });
    await mkdir(join(home, '.local/share/lark-cli'), { recursive: true });
    await writeFile(join(home, '.mylogin.cnf'), mysqlBytes, { mode: 0o600 });
    await writeFile(join(home, '.config/glab-cli/config.yml'), `hosts:\n  lab.example.test:\n    token: ${token}\n    user: gitlab-user\n`);
    await writeFile(join(home, '.lark-cli/config.json'), JSON.stringify({ apps: [{ appId: 'cli_example123', appSecret: 'encrypted', brand: 'feishu', lang: 'zh' }] }));
    await writeFile(join(home, '.local/share/lark-cli/master.key'), larkKey, { mode: 0o600 });
    await writeFile(join(home, '.local/share/lark-cli/appsecret_cli_example123.enc'), larkSecret, { mode: 0o600 });
  };
  return { app, request, seed, store, directory, calls, failMysql: () => { failMysql = true; } };
}

function assertPublicInventory(value: ConnectionInventory, expectVerification = false) {
  assert.deepEqual(Object.keys(value).sort(), ['configured', 'importedAt', 'scope', 'connections', ...(expectVerification ? ['verification'] : [])].sort());
  assert.equal(typeof value.configured, 'boolean');
  assert.equal(value.scope, 'all-projects');
  assert.ok(value.importedAt === null || Number.isFinite(Date.parse(value.importedAt)));
  for (const connection of value.connections) {
    for (const key of Object.keys(connection)) assert.ok(['id', 'type', 'name', 'host', 'username', 'note'].includes(key), `Unexpected public connection field: ${key}`);
    assert.equal(typeof connection.id, 'string'); assert.equal(typeof connection.name, 'string');
    assert.ok(['mysql', 'glab', 'git', 'lark', 'meegle'].includes(connection.type));
    for (const key of ['host', 'username', 'note'] as const) if (connection[key] !== undefined) assert.equal(typeof connection[key], 'string');
  }
  if (value.verification) {
    assert.deepEqual(Object.keys(value.verification).sort(), ['checkedAt', 'results']);
    assert.ok(Number.isFinite(Date.parse(value.verification.checkedAt)));
    for (const result of value.verification.results) {
      assert.deepEqual(Object.keys(result).sort(), ['id', 'message', 'ok']);
      assert.ok(value.connections.some(connection => connection.id === result.id));
      assert.equal(typeof result.ok, 'boolean'); assert.equal(typeof result.message, 'string');
    }
  }
  const serialized = JSON.stringify(value);
  for (const secret of privateValues) assert.ok(!serialized.includes(secret), 'Response must not expose private credential data');
}

test('connection GET is read-only and POST import returns metadata without private credential payloads', async t => {
  const { request, seed, store, calls } = await fixture(t);
  const emptyResponse = await request('/api/connections');
  assert.equal(emptyResponse.status, 200);
  const empty = await emptyResponse.json();
  assert.deepEqual(empty, { configured: false, importedAt: null, scope: 'all-projects', connections: [] });
  assert.equal(calls.length, 0, 'Listing must not run credential discovery');
  await seed();
  const importedResponse = await request('/api/connections/import', { method: 'POST', headers: { origin: 'http://localhost:3001' } });
  assert.equal(importedResponse.status, 200);
  assert.equal(importedResponse.headers.get('cache-control'), 'no-store');
  assert.equal(importedResponse.headers.get('x-content-type-options'), 'nosniff');
  const imported = await importedResponse.json() as ConnectionInventory;
  assertPublicInventory(imported);
  assert.equal(imported.configured, true);
  assert.deepEqual(imported.connections.map(item => item.type), ['lark', 'mysql', 'glab', 'git']);
  assert.equal(imported.connections.find(item => item.type === 'mysql')?.username, 'readonly-user');
  assert.equal(imported.connections.find(item => item.type === 'glab')?.host, 'lab.example.test');
  assert.match(imported.connections.find(item => item.type === 'lark')!.note!, /用户身份尚未接入/);
  const privateBundle = await store.readBundle();
  assert.ok(privateBundle?.glabConfig.includes(token), 'Fixture must actually contain a secret that the API omits');
  assert.ok(privateBundle?.gitCredentials.includes(encodeURIComponent(password)));
  const callsAfterImport = calls.length;
  const listedResponse = await request('/api/connections');
  assert.equal(listedResponse.status, 200);
  assert.equal(listedResponse.headers.get('cache-control'), 'no-store');
  const listed = await listedResponse.json() as ConnectionInventory;
  assertPublicInventory(listed);
  assert.deepEqual(listed, imported);
  assert.equal(calls.length, callsAfterImport, 'Listing imported metadata must not refresh tokens or invoke CLI commands');
});

test('connection routes reject foreign or missing hosts and origins before importing credentials', async t => {
  const { app, request, seed, calls, store } = await fixture(t);
  await seed();
  for (const [path, method] of [['/api/connections', 'GET'], ['/api/connections/import', 'POST']]) {
    assert.equal((await app.request(`http://localhost:3001${path}`, { method })).status, 403);
    const rejectedHeaders: Array<Record<string, string>> = [
      { host: 'attacker.example' },
      { host: 'localhost:3001.attacker.example' },
      { origin: 'https://attacker.example' },
      { origin: 'http://localhost:3001.attacker.example' },
      { origin: 'null' },
    ];
    for (const headers of rejectedHeaders) {
      const response = await request(path, { method, headers });
      assert.equal(response.status, 403);
      const output = await response.text();
      for (const secret of privateValues) assert.ok(!output.includes(secret));
    }
  }
  assert.equal(calls.length, 0);
  assert.equal(await store.readBundle(), null, 'Rejected imports must not persist a credential bundle');
  assert.equal((await request('/api/connections', { headers: { origin: 'http://localhost:3001' } })).status, 200);
});

test('unexpected import errors return a fixed generic response and preserve the previous metadata', async t => {
  const { request, seed, store, directory } = await fixture(t);
  await seed();
  assert.equal((await request('/api/connections/import', { method: 'POST' })).status, 200);
  const before = await readFile(join(directory, 'store.enc'));
  const metadata = await store.list();
  t.mock.method(store, 'importLocal', async () => { throw new Error(`stdout=${token}; stderr=${password}; Authorization: Bearer ${token}`); });
  const response = await request('/api/connections/import', { method: 'POST' });
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: '本机凭据导入失败，原有副本保持不变' });
  assert.deepEqual(await readFile(join(directory, 'store.enc')), before);
  const retained = await (await request('/api/connections')).json() as ConnectionInventory;
  assertPublicInventory(retained); assert.deepEqual(retained, metadata);
});

test('credential command failures retain their safe HTTP error and never expose command output', async t => {
  const { request, seed, failMysql, directory } = await fixture(t);
  await seed();
  assert.equal((await request('/api/connections/import', { method: 'POST' })).status, 200);
  const before = await readFile(join(directory, 'store.enc'));
  failMysql();
  const response = await request('/api/connections/import', { method: 'POST' });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: '无法读取 MySQL 命名连接，原有副本保持不变' });
  assert.deepEqual(await readFile(join(directory, 'store.enc')), before);
});

test('connection GET returns typed verification summaries only for the current imported identities', async t => {
  const { request, seed, store } = await fixture(t);
  await seed();
  const imported = await (await request('/api/connections/import', { method: 'POST' })).json() as ConnectionInventory;
  const results = [
    { id: 'glab:lab.example.test', status: 'ok' as const, token, stdout: token },
    { id: 'mysql:analytics', status: 'mysql-handshake' as const, password, stderr: password },
    { id: 'git:unknown.example.test', status: 'failed' as const, token },
  ];
  await store.recordVerification(imported.importedAt!, results);
  const checked = await (await request('/api/connections')).json() as ConnectionInventory;
  assertPublicInventory(checked, true);
  assert.deepEqual(checked.verification?.results, [
    { id: 'glab:lab.example.test', ok: true, message: '沙箱连接检查通过' },
    { id: 'mysql:analytics', ok: false, message: '服务器在 MySQL 握手阶段断开连接，尚未验证账号' },
  ]);
  await store.recordVerification('2000-01-01T00:00:00.000Z', [{ id: 'glab:lab.example.test', status: 'auth' }]);
  assert.deepEqual((await (await request('/api/connections')).json()).verification, checked.verification, 'Stale verification must not replace the current import report');
});

test('uninitialized connection routes return a service error without touching local credentials', async t => {
  const { request, calls } = await fixture(t, false);
  for (const [path, method] of [['/api/connections', 'GET'], ['/api/connections/import', 'POST']]) {
    const response = await request(path, { method });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: '连接管理尚未初始化' });
  }
  assert.equal(calls.length, 0);
});
