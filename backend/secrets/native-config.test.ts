import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { mergeNativeConfig, mergedBinding, mysqlProfiles } from './native-config.js';

const execFile = promisify(execFileCallback);

function source(id: string, name: string, content: string, version = 1) {
  return { id, name, content, version };
}

function mergedBytes(tool: string, sources: ReturnType<typeof source>[]) {
  return Buffer.from(mergeNativeConfig(tool, sources).content, 'base64');
}

test('merges MySQL [client], named groups, and client_<name> groups into native login paths', () => {
  const profiles = mysqlProfiles([
    '[client]', 'user = shared-user', 'password = shared-password',
    '[client_doris]', 'host = doris.example.test', 'port = 9030',
    '[uat]', 'host = uat.example.test', 'port = 3307', 'user = uat-user',
  ].join('\n'), 'ignored-label');

  assert.deepEqual(profiles.get('doris'), [
    'user = shared-user', 'password = shared-password', 'host = doris.example.test', 'port = 9030',
  ]);
  assert.deepEqual(profiles.get('uat'), [
    'user = uat-user', 'password = shared-password', 'host = uat.example.test', 'port = 3307',
  ]);

  const fallback = mysqlProfiles('[client]\nhost = standalone.example.test\nuser = only-user\npassword = only-password\n', 'MySQL · standalone');
  assert.deepEqual([...fallback.keys()], ['MySQL · standalone']);
  assert.deepEqual(fallback.get('MySQL · standalone'), [
    'host = standalone.example.test', 'user = only-user', 'password = only-password',
  ]);
});

test('encodes a usable native MySQL login file and selects the expected port without revealing the password', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cocell-mysql-login-'));
  const home = join(root, 'home');
  const loginFile = join(root, 'login.cnf');
  const secret = 'synthetic-mysql-password-5f31d2';
  const bytes = mergedBytes('mysql', [source('mysql-doris', 'Doris account', [
    '[doris]', 'host = doris.example.test', 'port = 19030', 'user = synthetic-user', `password = ${secret}`,
  ].join('\n')), source('mysql-uat', 'UAT account', '[uat]\nhost = uat.example.test\nport = 13307\nuser = synthetic-uat\npassword = synthetic-uat-password\n')]);
  const env = { ...process.env, HOME: home, MYSQL_TEST_LOGIN_FILE: loginFile };
  try {
    await mkdir(home, { recursive: true });
    await writeFile(loginFile, bytes, { mode: 0o600 });

    const runNative = async (file: string, args: string[]) => {
      try {
        return await execFile(file, args, { env, timeout: 5_000, maxBuffer: 1_000_000 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          t.skip(`${file} is not installed`);
          return undefined;
        }
        throw error;
      }
    };

    if (!await runNative('mysql_config_editor', ['--version'])) return;
    const printed = await runNative('mysql_config_editor', ['print', '--login-path=doris']);
    if (!printed) return;
    assert.match(printed.stdout, /host\s*=\s*doris\.example\.test/);
    assert.match(printed.stdout, /port\s*=\s*19030/);
    assert(!printed.stdout.includes(secret));
    assert(!printed.stderr.includes(secret));
    assert.match(printed.stdout + printed.stderr, /\*{3,}/, 'mysql_config_editor should mask the synthetic password');

    const help = await runNative('mysql', ['--no-defaults', '--login-path=doris', '--help']);
    if (!help) return;
    assert.match(help.stdout, /doris\.example\.test/);
    assert.match(help.stdout, /19030/);
    assert(!help.stdout.includes(secret));
    assert(!help.stderr.includes(secret));
    assert(!help.stdout.includes('uat.example.test'));
    const uat = await runNative('mysql', ['--no-defaults', '--login-path=uat', '--help']);
    if (!uat) return;
    assert.match(uat.stdout, /uat\.example\.test/);
    assert.match(uat.stdout, /13307/);
    assert(!uat.stdout.includes('doris.example.test'));
    const persisted = await readFile(loginFile);
    assert.deepEqual(persisted, bytes);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('merges Kubernetes YAML and JSON contexts while preserving their names and qualifying colliding internal keys', () => {
  const yaml = `apiVersion: v1
kind: Config
current-context: prod-a
clusters:
  - name: cluster
    cluster:
      server: https://a.example.test
  - name: unreferenced-cluster
    cluster:
      server: https://unused.example.test
users:
  - name: user
    user:
      token: synthetic-token-a
  - name: unreferenced-user
    user:
      token: unused-synthetic-token
contexts:
  - name: prod-a
    context:
      cluster: cluster
      user: user
`;
  const json = JSON.stringify({
    apiVersion: 'v1', kind: 'Config', 'current-context': 'prod-b',
    clusters: [{ name: 'cluster', cluster: { server: 'https://b.example.test' } }],
    users: [{ name: 'user', user: { token: 'synthetic-token-b' } }],
    contexts: [{ name: 'prod-b', context: { cluster: 'cluster', user: 'user' } }],
  });
  const content = mergedBytes('kubectl', [
    source('account-a', 'Account A', yaml),
    source('account-b', 'Account B', json),
  ]).toString('utf8');
  const merged = JSON.parse(content);

  assert.deepEqual(merged.contexts.map((item: { name: string }) => item.name), ['prod-a', 'prod-b']);
  assert.equal(merged['current-context'], 'prod-a');
  assert.deepEqual(merged.clusters.map((item: { name: string }) => item.name), ['account-a/cluster', 'account-b/cluster']);
  assert.deepEqual(merged.users.map((item: { name: string }) => item.name), ['account-a/user', 'account-b/user']);
  assert.equal(merged.contexts[0].context.cluster, 'account-a/cluster');
  assert.equal(merged.contexts[0].context.user, 'account-a/user');
  assert(!content.includes('unreferenced-cluster'));
  assert(!content.includes('unreferenced-user'));
});

test('rejects duplicate native names, invalid includes, and dangling Kubernetes references', () => {
  const mysql = (id: string) => source(id, id, `[doris]\nhost = ${id}.example.test\nuser = synthetic\npassword = synthetic\n`);
  assert.throws(() => mergedBytes('mysql', [mysql('mysql-a'), mysql('mysql-b')]), /名称重复/);
  assert.throws(() => mysqlProfiles('[client]\n!include /tmp/untrusted.cnf\n', 'unsafe'), /无效/);
  assert.throws(() => mysqlProfiles('[doris]\nhost = one\n\n[doris]\nhost = two\n', 'unused'), /唯一/);

  const invalidKube = JSON.stringify({
    apiVersion: 'v1', kind: 'Config', 'current-context': 'prod',
    clusters: [{ name: 'cluster', cluster: { server: 'https://example.test' } }],
    users: [], contexts: [{ name: 'prod', context: { cluster: 'missing-cluster', user: 'missing-user' } }],
  });
  assert.throws(() => mergedBytes('kubectl', [source('broken', 'Broken', invalidKube)]), /Kubernetes/);

  const duplicateContext = (id: string) => source(id, id, JSON.stringify({
    apiVersion: 'v1', kind: 'Config', 'current-context': 'same',
    clusters: [{ name: 'cluster', cluster: { server: `https://${id}.example.test` } }],
    users: [], contexts: [{ name: 'same', context: { cluster: 'cluster' } }],
  }));
  assert.throws(() => mergedBytes('kubectl', [duplicateContext('a'), duplicateContext('b')]), /重复/);
});

test('native binding revision is stable under source reordering and changes with membership or version', () => {
  const inputs = [
    { id: 'mysql-a', name: 'doris', version: 1 },
    { id: 'mysql-b', name: 'uat', version: 4 },
  ];
  const base = mergedBinding('mysql', inputs);
  assert.equal(mergedBinding('mysql', [...inputs].reverse()).revision, base.revision);
  assert.notEqual(mergedBinding('mysql', inputs.slice(0, 1)).revision, base.revision);
  assert.notEqual(mergedBinding('mysql', [{ ...inputs[0], version: 2 }, inputs[1]]).revision, base.revision);
  const nativeInputs = inputs.map(item => ({ ...item, content: 'original native config' }));
  assert.notEqual(mergedBinding('mysql', nativeInputs).revision,
    mergedBinding('mysql', [{ ...nativeInputs[0], content: 'edited on disk' }, nativeInputs[1]]).revision);

  const kubeInputs = inputs.map(({ id, version }) => ({ id, name: 'display label', version }));
  assert.equal(mergedBinding('kubectl', kubeInputs).revision, mergedBinding('kubectl', kubeInputs.map(item => ({ ...item, name: 'renamed label' }))).revision);
});
