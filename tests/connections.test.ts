import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, type TestContext } from 'node:test';
import type { Sandbox } from 'e2b';
import { ConnectionStore, CONNECTION_ENVS, CONNECTION_ROOT, glabHosts, mysqlProfiles, type LocalCommand } from '../server/connections.js';
import { syncSandboxConnections } from '../server/sandbox-connections.js';
import { HttpError } from '../server/manager.js';

const token = 'test-token-one';
const password = 'fake-password-$-with:@symbols';
const mysqlBytes = Buffer.from('synthetic-encrypted-mysql-login-file');
const yaml = `hosts:\n    lab.example.test:\n        token: ${token}\n        user: configured-gitlab-user\n        api_protocol: https\n        git_protocol: https\n`;
const command: LocalCommand = async (cmd, args, input) => {
  if (cmd === 'mysql_config_editor') return '[doris]\nuser = "analytics-user"\npassword = *****\nhost = "doris.internal.test"\n';
  if (cmd === 'glab') { assert.equal(args[args.indexOf('--host') + 1], 'lab.example.test'); return token; }
  if (args.includes('--get-regexp')) return 'credential.https://git.example.test.helper store\ncredential.http://insecure.example.test.helper store\ncredential.helper store\ncredential.https://nested.example.test/repository.helper store\n';
  if (args.includes('user.name')) return 'Configured Commit Name';
  if (args.includes('user.email')) return 'configured@example.test';
  if (args[0] === 'credential') {
    assert.match(input!, /^protocol=https\nhost=(lab|git)\.example\.test\n\n$/);
    return `protocol=https\nhost=git.example.test\nusername=credential-user\npassword=${password}\n`;
  }
  throw new Error('Unexpected fake command');
};
async function fixture(t: TestContext, override?: LocalCommand) {
  const base = fileURLToPath(new URL('../data/.tests/', import.meta.url)); await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, 'connections-'));
  const home = join(root, 'home'), directory = join(root, 'encrypted'), keyPath = join(root, 'key', 'credentials.key');
  await mkdir(join(home, '.config/glab-cli'), { recursive: true });
  await writeFile(join(home, '.mylogin.cnf'), mysqlBytes, { mode: 0o600 });
  await writeFile(join(home, '.config/glab-cli/config.yml'), yaml);
  const options = { home, directory, keyPath, command: override ?? command };
  const store = new ConnectionStore(options);
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, home, directory, keyPath, store, options };
}

test('import returns safe metadata, uses configured host username and scopes HTTPS credential lookup', async t => {
  const { store } = await fixture(t);
  const imported = await store.importLocal();
  assert.equal(imported.configured, true);
  assert.equal(imported.scope, 'all-projects');
  assert.deepEqual(imported.connections.map(item => item.id), ['mysql:doris', 'glab:lab.example.test', 'git:lab.example.test', 'git:git.example.test']);
  assert.equal(imported.connections.find(item => item.type === 'glab')?.username, 'configured-gitlab-user');
  assert.equal(imported.connections.find(item => item.type === 'mysql')?.username, 'analytics-user');
  const publicJson = JSON.stringify(await store.list());
  for (const secret of [token, password, mysqlBytes.toString('base64')]) assert.ok(!publicJson.includes(secret));
  const bundle = (await store.readBundle())!;
  assert.equal(JSON.parse(bundle.glabConfig).hosts['lab.example.test'].token, token);
  assert.equal(bundle.mysqlLogin, mysqlBytes.toString('base64'));
  assert.match(bundle.gitConfig, /\[credential "https:\/\/lab\.example\.test"\]/);
  assert.match(bundle.gitConfig, /\[credential "https:\/\/git\.example\.test"\]/);
  assert.ok(!bundle.gitConfig.includes('[credential]'));
  assert.ok(!bundle.gitConfig.includes('insecure.example.test'));
  assert.ok(!bundle.gitConfig.includes('nested.example.test'));
  assert.match(bundle.gitConfig, /name = "Configured Commit Name"/);
  assert.ok(bundle.gitCredentials.includes(encodeURIComponent(password)));
});

test('encrypted storage roundtrips with separate private key and rejects wrong keys or tampering', async t => {
  const { store, options, directory, keyPath } = await fixture(t);
  assert.deepEqual(await store.list(), { configured: false, importedAt: null, scope: 'all-projects', connections: [] });
  await store.importLocal();
  const blob = await readFile(join(directory, 'store.enc'));
  assert.equal(blob.subarray(0, 4).toString(), 'SWC1');
  for (const secret of [token, password, mysqlBytes.toString('base64'), 'configured-gitlab-user']) assert.ok(!blob.includes(Buffer.from(secret)));
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  assert.equal((await stat(join(directory, 'store.enc'))).mode & 0o777, 0o600);
  assert.equal((await stat(keyPath)).mode & 0o777, 0o600);
  assert.ok(!keyPath.startsWith(directory + '/'));
  const reopened = new ConnectionStore(options);
  assert.deepEqual(await reopened.readBundle(), await store.readBundle());
  const key = await readFile(keyPath);
  await writeFile(keyPath, randomBytes(32));
  await assert.rejects(reopened.readBundle(), error => error instanceof HttpError && error.status === 500 && !error.message.includes(token));
  await writeFile(keyPath, key);
  const tampered = Buffer.from(blob); tampered[tampered.length - 1] ^= 1;
  await writeFile(join(directory, 'store.enc'), tampered);
  await assert.rejects(reopened.readBundle(), /无法解密/);
});

test('failed MySQL extraction leaves the previous encrypted copy intact and hides command errors', async t => {
  let fail = false;
  const { store, directory } = await fixture(t, async (cmd, args, input) => {
    if (fail && cmd === 'mysql_config_editor') throw new Error(`stdout secret: ${password}`);
    return command(cmd, args, input);
  });
  await store.importLocal();
  const before = await readFile(join(directory, 'store.enc'));
  fail = true;
  await assert.rejects(store.importLocal(), error => error instanceof HttpError && error.status === 400 && /原有副本保持不变/.test(error.message) && !error.message.includes(password));
  assert.deepEqual(await readFile(join(directory, 'store.enc')), before);
  assert.equal((await store.list()).connections.length, 4);
});

test('metadata parsers exclude password lines and ignore nested or unsafe glab host keys', () => {
  assert.deepEqual(glabHosts('hosts:\n  "lab.example.test":\n    user: bob\n    nested:\n      fake.example.test:\n  evil/path:\n  localhost:8443:\nother:\n  ignored.example.test:\n'), ['lab.example.test', 'localhost:8443']);
  assert.deepEqual(mysqlProfiles('[one]\nuser = "reader"\npassword = "do-not-expose"\nhost = "db.example.test"\n'), [{ id: 'mysql:one', type: 'mysql', name: 'one', username: 'reader', host: 'db.example.test' }]);
});

type FileWrite = { path: string; contents: string | ArrayBuffer; options: Record<string, unknown> };
function fakeSandbox(options: { fail?: boolean; abortAfterWrite?: AbortController; persistMarkers?: boolean; failScript?: RegExp } = {}) {
  const writes: FileWrite[] = [];
  const commands: Array<{ script: string; options: Record<string, unknown> }> = [];
  const removed: string[] = [];
  const events: string[] = [];
  let marker: string | undefined;
  const sandbox = {
    files: {
      write: async (path: string, contents: string | ArrayBuffer, request: Record<string, unknown>) => {
        writes.push({ path, contents, options: request });
        events.push(`write ${path}`);
        if (options.abortAfterWrite && path.endsWith('glab/config.yml')) options.abortAfterWrite.abort();
      },
      remove: async (path: string) => { removed.push(path); },
    },
    commands: { run: async (script: string, request: Record<string, unknown>) => {
      commands.push({ script, options: request });
      events.push(`command ${script}`);
      if (options.fail || options.failScript?.test(script)) throw new Error(`request Authorization Bearer ${token} password ${password}`);
      const hash = script.match(/'([a-f0-9]{64})'/)?.[1];
      if (script.includes('printf ready')) return { stdout: options.persistMarkers && marker === hash ? 'ready' : '', stderr: '', exitCode: 0 };
      if (script.startsWith('umask 077; printf %s')) marker = hash;
      return { stdout: '', stderr: '', exitCode: 0 };
    } },
  } as unknown as Sandbox;
  return { sandbox, writes, commands, removed, events };
}

test('sandbox sync transmits credential values only via file API, uses protected paths and rotates generations', async t => {
  const { store } = await fixture(t); await store.importLocal();
  const fake = fakeSandbox(), controller = new AbortController();
  const envs = await syncSandboxConnections(fake.sandbox, store, controller.signal);
  assert.deepEqual(envs, { ...CONNECTION_ENVS, GITLAB_HOST: 'https://lab.example.test' });
  const glab = fake.writes.find(item => item.path.endsWith('glab/config.yml'))!;
  assert.ok(String(glab.contents).includes(token));
  const mysql = fake.writes.find(item => item.path.endsWith('.mylogin.cnf'))!;
  assert.deepEqual(Buffer.from(mysql.contents as ArrayBuffer), mysqlBytes);
  const shell = fake.commands.map(item => item.script).join('\n');
  for (const secret of [token, password, encodeURIComponent(password), mysqlBytes.toString('base64')]) assert.ok(!shell.includes(secret));
  assert.match(shell, /umask 077/); assert.match(shell, /chmod 600/);
  assert.ok(shell.includes(`${CONNECTION_ROOT}/current/gitconfig`));
  assert.match(shell, /mv -Tf/);
  for (const item of fake.writes) assert.equal(item.options.signal, controller.signal);
  for (const item of fake.commands) {
    if (item.script.startsWith('if test "$(readlink')) {
      assert.equal(item.options.signal, undefined);
      assert.equal(item.options.timeoutMs, 10_000);
    } else assert.equal(item.options.signal, controller.signal);
  }
  const profile = String(fake.writes.find(item => item.path === '/etc/profile.d/codex-connections.sh')!.contents);
  for (const [name, value] of Object.entries(CONNECTION_ENVS)) { assert.ok(profile.includes(name)); assert.ok(profile.includes(value)); }
  assert.ok(!profile.includes(token)); assert.ok(!profile.includes(password));
  assert.equal(fake.removed.length, 1);
  const cleanup = fake.commands.find(item => item.script.startsWith('if test "$(readlink'));
  assert.ok(cleanup);
  assert.equal(cleanup.options.signal, undefined);
  assert.equal(cleanup.options.timeoutMs, 10_000);
  assert.match(fake.removed[0]!, /^\/tmp\/codex-command-tools-.*\.sh$/);
  await syncSandboxConnections(fake.sandbox, store, controller.signal);
  const generations = fake.writes.filter(item => item.path.endsWith('glab/config.yml')).map(item => item.path);
  assert.equal(new Set(generations).size, 2);
  assert.match(fake.commands.map(item => item.script).join('\n'), /for directory in .*generation-\*/);
});

test('sandbox failures hide SDK credentials and always remove the temporary installer', async t => {
  const { store } = await fixture(t); await store.importLocal();
  const fake = fakeSandbox({ fail: true });
  await assert.rejects(syncSandboxConnections(fake.sandbox, store, new AbortController().signal), error => error instanceof Error && /凭据同步失败/.test(error.message) && !error.message.includes(token) && !error.message.includes(password));
  assert.equal(fake.removed.length, 1);
});

test('sandbox synchronization stops on abort before credentials can continue uploading', async t => {
  const { store } = await fixture(t); await store.importLocal();
  const controller = new AbortController();
  const fake = fakeSandbox({ abortAfterWrite: controller });
  await assert.rejects(syncSandboxConnections(fake.sandbox, store, controller.signal), error => error instanceof Error && error.name === 'AbortError');
  assert.equal(fake.writes.filter(item => item.path.includes('/generation-')).length, 1);
  assert.equal(fake.removed.length, 1);
  const cleanup = fake.commands.find(item => item.script.startsWith('if test "$(readlink'));
  assert.ok(cleanup, 'aborting a partial generation must still attempt cleanup');
  assert.equal(cleanup.options.signal, undefined);
  assert.equal(cleanup.options.timeoutMs, 10_000);
  const alreadyAborted = fakeSandbox();
  await assert.rejects(syncSandboxConnections(alreadyAborted.sandbox, store, controller.signal), error => error instanceof Error && error.name === 'AbortError');
  assert.equal(alreadyAborted.writes.length, 0);
});

test('an unconfigured store performs no sandbox commands or writes', async t => {
  const { store } = await fixture(t); const fake = fakeSandbox();
  assert.deepEqual(await syncSandboxConnections(fake.sandbox, store, new AbortController().signal), {});
  assert.equal(fake.commands.length, 0); assert.equal(fake.writes.length, 0);
});

test('a ready credential generation skips file uploads and tool installation on the next sync', async t => {
  const { store } = await fixture(t); await store.importLocal();
  const fake = fakeSandbox({ persistMarkers: true }), controller = new AbortController();
  const first = await syncSandboxConnections(fake.sandbox, store, controller.signal);
  const writes = fake.writes.length, commands = fake.commands.length;
  const second = await syncSandboxConnections(fake.sandbox, store, controller.signal);
  assert.deepEqual(second, first);
  assert.equal(fake.writes.length, writes);
  assert.equal(fake.commands.length, commands + 1);
  assert.match(fake.commands.at(-1)!.script, /printf ready/);
});

test('reimporting unchanged credentials changes metadata time but preserves the ready generation', async t => {
  const { store } = await fixture(t);
  const firstImport = await store.importLocal();
  const fake = fakeSandbox({ persistMarkers: true }), signal = new AbortController().signal;
  await syncSandboxConnections(fake.sandbox, store, signal);
  const writes = fake.writes.length;
  await new Promise(resolve => setTimeout(resolve, 3));
  const secondImport = await store.importLocal();
  assert.notEqual(secondImport.importedAt, firstImport.importedAt);
  await syncSandboxConnections(fake.sandbox, store, signal);
  assert.equal(fake.writes.length, writes);
  const probes = fake.commands.filter(item => item.script.includes('printf ready'));
  assert.equal(probes.length, 2);
  assert.equal(probes[0]!.script, probes[1]!.script);
});

test('rotating a token invalidates the ready generation and uploads the new value', async t => {
  let currentToken = token;
  const { store } = await fixture(t, (cmd, args, input) => cmd === 'glab' ? Promise.resolve(currentToken) : command(cmd, args, input));
  await store.importLocal();
  const fake = fakeSandbox({ persistMarkers: true }), signal = new AbortController().signal;
  await syncSandboxConnections(fake.sandbox, store, signal);
  currentToken = 'test-token-two';
  await store.importLocal();
  await syncSandboxConnections(fake.sandbox, store, signal);
  const probes = fake.commands.filter(item => item.script.includes('printf ready'));
  assert.notEqual(probes[0]!.script, probes[1]!.script);
  const uploads = fake.writes.filter(item => item.path.endsWith('/glab/config.yml'));
  assert.equal(uploads.length, 2);
  assert.ok(String(uploads[1]!.contents).includes(currentToken));
  assert.ok(!fake.commands.some(item => item.script.includes(currentToken)));
});

test('readiness marker is written only after files, profile and permissions succeed', async t => {
  const { store } = await fixture(t); await store.importLocal();
  const signal = new AbortController().signal;
  const successful = fakeSandbox({ persistMarkers: true });
  await syncSandboxConnections(successful.sandbox, store, signal);
  const markerIndex = successful.events.findIndex(event => event.startsWith('command umask 077; printf %s'));
  assert.ok(markerIndex > successful.events.findIndex(event => event === 'write /etc/profile.d/codex-connections.sh'));
  assert.ok(markerIndex > successful.events.findIndex(event => event === 'command chmod 0644 /etc/profile.d/codex-connections.sh'));
  const failed = fakeSandbox({ persistMarkers: true, failScript: /^chmod 0644/ });
  await assert.rejects(syncSandboxConnections(failed.sandbox, store, signal), /凭据同步失败/);
  assert.ok(!failed.commands.some(item => item.script.startsWith('umask 077; printf %s')));
  const writesBeforeRetry = failed.writes.length;
  await assert.rejects(syncSandboxConnections(failed.sandbox, store, signal), /凭据同步失败/);
  assert.ok(failed.writes.length > writesBeforeRetry);
});

test('service GitLab dotenv token cannot override a different host credential lookup', async () => {
  const { localCredentialEnvironment } = await import('../server/connections.js');
  const source = { PATH: '/usr/bin', USER: 'alice', GITLAB_TOKEN: 'application-token', GLAB_TOKEN: 'override-token', GITLAB_HOST: 'other.example.test' };
  const env = localCredentialEnvironment(source);
  assert.equal(env.GITLAB_TOKEN, undefined); assert.equal(env.GLAB_TOKEN, undefined); assert.equal(env.GITLAB_HOST, undefined);
  assert.equal(env.PATH, source.PATH); assert.equal(env.USER, source.USER);
  assert.equal(source.GITLAB_TOKEN, 'application-token');
});

test('legacy Kubernetes administrator copies cannot be exported to another runtime', async () => {
  const source = { importedAt: new Date().toISOString(), connections: [{ id: 'kubernetes:common', type: 'kubernetes' as const, name: 'common' }], glabConfig: '{}', gitConfig: '', gitCredentials: '', cliFiles: { 'kubernetes/config.json': Buffer.from('legacy-admin-certificate').toString('base64') } };
  class LegacyStore extends ConnectionStore { override async readBundle() { return source; } }
  const store = new LegacyStore({ command: async () => { throw Error('must not fall back to host command'); } });
  await assert.rejects(store.readRuntimeBundle(), /旧 Kubernetes 凭据已停用/);
});
