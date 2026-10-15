import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Hono } from 'hono';
import { installOperatorAccess } from '../access/operator.js';
import { installSecretRoutes } from './routes.js';
import { HttpError } from '../../util/errors.js';
import { SecretCrypto } from './crypto.js';
import { credentialPath, toolName } from './policy.js';
import { SecretService } from './service.js';
import type { SecretRepository, StoredSecret, StoredVersion } from './repository.js';
import { MemoryRoleRepository } from './role-repository.js';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export class MemorySecrets implements SecretRepository {
  readonly projectIds = new Set<string>();
  readonly roles = new MemoryRoleRepository(id => this.records.has(id), () => [...this.projectIds]);
  records = new Map<string, StoredSecret>(); history: StoredVersion[] = [];
  runtimes = new Map<string, { projectId: string; generation: number }>();
  readonly configs = new Map<string, Record<string, string>>();
  async init() {}
  async list() { return [...this.records.values()]; }
  async get(id: string) { return this.records.get(id) ?? null; }
  async delete(id: string) { this.records.delete(id); this.history = this.history.filter(version => version.secretId !== id); }
  async save(secret: StoredSecret, version: StoredVersion | null) {
    const previous = this.records.get(secret.id);
    const changed = version?.changes.some(field => ['created', 'content'].includes(field));
    this.records.set(secret.id, { ...secret, version: (previous?.version ?? 0) + (changed ? 1 : 0), currentVersionId: changed ? version!.id : previous!.currentVersionId, ciphertext: changed ? version!.ciphertext : previous!.ciphertext });
    if (version) this.history.push(version);
  }
  async versions(id: string) { return this.history.filter(version => version.secretId === id); }
  async registerRuntime(boxId: string, projectId: string, generation: number) { this.runtimes.set(boxId, { projectId, generation }); }
  async runtime(boxId: string) { return this.runtimes.get(boxId) ?? null; }
  async runtimeConfig(boxId: string, generation: number) { return { ...this.configs.get(`${boxId}:${generation}`) }; }
  async markRuntimeConfig(boxId: string, generation: number, slot: string, digest: string) { await this.markRuntimeConfigs(boxId, generation, { [slot]: digest }); }
  async markRuntimeConfigs(boxId: string, generation: number, digests: Record<string, string>) {
    const key = `${boxId}:${generation}`;
    this.configs.set(key, { ...this.configs.get(key), ...digests });
  }
  async forgetRuntime(boxId: string) {
    this.runtimes.delete(boxId);
    for (const key of this.configs.keys()) if (key.startsWith(boxId + ':')) this.configs.delete(key);
  }
}
export function fixture() {
  const repository = new MemorySecrets(), crypto = new SecretCrypto(Buffer.alloc(32, 7).toString('base64'));
  const projectId = randomUUID(); repository.projectIds.add(projectId);
  const service = new SecretService(repository, crypto);
  return { repository, service, projectId, crypto };
}

test('project roles merge only granted native profiles, preserve unchanged HOME, and revoke live access', async () => {
  const { service, repository, projectId, crypto } = fixture(); await service.init();
  const root = await mkdtemp(join(tmpdir(), 'cocell-roles-')); await service.mountHomes(root);
  try {
    const create = (name: string, tool: string) => service.create({ name: 'Credential ' + name, tool, path: tool === 'mysql' ? '.my.cnf' : '.kube/config', format: 'text', mutable: false,
      content: tool === 'mysql' ? '[' + name + ']\nuser=fixture\npassword=synthetic-' + name + '\n'
        : JSON.stringify({ apiVersion: 'v1', kind: 'Config', clusters: [{ name: 'shared', cluster: { server: 'https://' + name + '.example.test' } }], users: [{ name: 'admin', user: { token: 'synthetic-' + name } }], contexts: [{ name, context: { cluster: 'shared', user: 'admin' } }], 'current-context': name }) });
    const mysqlA = await create('analytics', 'mysql'), mysqlB = await create('warehouse', 'mysql');
    const kubeA = await create('staging', 'kubectl'), kubeB = await create('production', 'kubectl');
    const connections = [mysqlA, mysqlB, kubeA, kubeB].map(secret => ({ tool: secret.tool!, secretId: secret.id }));
    const role = await service.roles.save({ name: 'Data operators', connections }); await service.roles.assign(projectId, role.id); await service.publishHome(projectId);
    await service.registerRuntime('role-box', projectId, 1); await service.registerRuntime('other-box', randomUUID(), 1);
    const files = await service.provision(projectId); assert.equal(files.length, 2);
    assert.deepEqual(files.map(file => file.path).sort(), ['.kube/config', '.mylogin.cnf']);
    const home = join(root, 'runtime/debug-homes', projectId);
    const kube = JSON.parse(await readFile(join(home, '.kube/config'), 'utf8'));
    assert.deepEqual(kube.contexts.map((item: { name: string }) => item.name), ['staging', 'production']);
    for (const connection of role.connections) {
      const name = connection.nativeNames![0];
      const args = connection.tool === 'mysql' ? ['--login-path=' + name, '-e', 'SELECT 1'] : ['--context=' + name, 'get', 'pods'];
      const auth = await service.authorize('role-box', connection.tool, args);
      assert.equal(auth.path, connection.tool === 'mysql' ? '.mylogin.cnf' : '.kube/config');
      assert.ok(!JSON.stringify(auth).includes('synthetic-'));
      assert(auth.args.includes(args[0]));
      await assert.rejects(service.authorize('other-box', connection.tool, args), /未授权/);
    }
    await assert.rejects(service.authorize('role-box', 'mysql', ['-e', 'SELECT 1']), /login-path/);
    await assert.rejects(service.authorize('role-box', 'mysql', ['--login-path=missing', '-e', 'SELECT 1']), /未授权/);
    await assert.rejects(service.authorize('role-box', 'mysql', ['--login-path=analytics', '--login-path=warehouse', '-e', 'SELECT 1']), /名称无效/);
    await assert.rejects(service.authorize('role-box', 'kubectl', ['--context=staging', '--kubeconfig=/tmp/other', 'get', 'pods']), /覆盖/);
    await assert.rejects(service.authorize('role-box', 'mysql', ['--login-path=analytics', '--host=other', '-e', 'SELECT 1']), /mysql/);
    const restarted = new SecretService(repository, crypto); await restarted.mountHomes(root); await restarted.init();
    assert.deepEqual(await restarted.roles.state(projectId), await service.roles.state(projectId));
    assert.equal((await restarted.authorize('role-box', 'mysql', ['--login-path', 'analytics', '-e', 'SELECT 1'])).path, '.mylogin.cnf');
    const before = await readFile(join(home, '.mylogin.cnf')); await service.publishHome(projectId);
    assert.deepEqual(await readFile(join(home, '.mylogin.cnf')), before);
    await service.update(mysqlA.id, { enabled: false });
    await assert.rejects(service.authorize('role-box', 'mysql', ['--login-path=analytics', '-e', 'SELECT 1']), /未授权/);
    assert.notDeepEqual(await readFile(join(home, '.mylogin.cnf')), before);
    assert.equal((await service.authorize('role-box', 'mysql', ['--login-path=warehouse', '-e', 'SELECT 1'])).path, '.mylogin.cnf');
    await service.roles.save({ name: role.name, connections: connections.filter(item => item.secretId === mysqlB.id) }, role.id);
    await assert.rejects(service.authorize('role-box', 'kubectl', ['get', 'pods']), /未授权/);
    await assert.rejects(readFile(join(home, '.kube/config')), { code: 'ENOENT' });
    await service.delete(mysqlB.id); assert.equal((await service.provision(projectId)).length, 0);
    await assert.rejects(readFile(join(home, '.mylogin.cnf')), { code: 'ENOENT' });
    await service.roles.assign(projectId, null); assert.deepEqual(await service.roles.state(projectId), { roleId: null, connections: [] });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('role API requires operator access and validates grants before changing roles', async () => {
  const { service, projectId } = fixture();
  await service.init();
  const app = new Hono();
  app.onError((error, c) => c.json({ error: error.message }, error instanceof HttpError ? error.status as 400 : 400));
  installOperatorAccess(app, { token: 'operator-role-fixture-0123456789abcdef', publicUrl: 'https://app.example.test', projects: () => [] });
  installSecretRoutes(app, service, id => id === projectId);
  const headers = { Authorization: 'Bearer operator-role-fixture-0123456789abcdef', 'Content-Type': 'application/json' };
  assert.equal((await app.request('https://app.example.test/api/tool-roles')).status, 401);
  assert.equal((await app.request('https://app.example.test/api/tool-roles', { method: 'POST', body: JSON.stringify({ name: 'Denied', connections: [] }) })).status, 401);
  const created = await app.request('https://app.example.test/api/tool-roles', { method: 'POST', headers, body: JSON.stringify({ name: 'No tools', connections: [] }) });
  assert.equal(created.status, 201);
  const role = await created.json();
  assert.equal((await app.request('https://app.example.test/api/tool-roles/default', { method: 'PUT', headers, body: JSON.stringify({ roleId: role.id }) })).status, 200);
  assert.equal((await app.request(`https://app.example.test/api/projects/${projectId}/tool-role`, { method: 'PUT', headers, body: JSON.stringify({ roleId: role.id }) })).status, 200);
  assert.equal((await app.request(`https://app.example.test/api/tool-roles/${role.id}`, { method: 'DELETE', headers })).status, 409);
  const secret = await service.create({ name: 'glab', tool: 'glab', path: '.config/glab/config.yml', format: 'text', content: 'fixture', mutable: false });
  await assert.rejects(service.roles.save({ name: 'Wrong tool', connections: [{ tool: 'mysql', secretId: secret.id }] }), /已启用/);
  await assert.rejects(service.roles.save({ name: 'Duplicate', connections: [{ tool: 'glab', secretId: secret.id }, { tool: 'glab', secretId: secret.id }] }), /重复/);
  assert.equal((await service.roles.catalog()).roles.length, 2);
  const selection = { tool: 'glab', secretId: secret.id };
  const selected = await app.request('https://app.example.test/api/tool-roles', { method: 'POST', headers, body: JSON.stringify({ name: 'GitLab access', connections: [selection] }) });
  assert.equal(selected.status, 201);
  assert.deepEqual((await selected.json()).connections, [{ ...selection, alias: secret.name }]);
  const customAlias = await app.request('https://app.example.test/api/tool-roles', { method: 'POST', headers, body: JSON.stringify({ name: 'Custom alias', connections: [{ ...selection, alias: 'override' }] }) });
  assert.equal(customAlias.status, 400);
});


test('bootstrap binds every historical project to empty Default, removes mounted credentials, and preserves later operator initialization', async () => {
  const { service, repository, projectId, crypto } = fixture();
  const archivedId = randomUUID(); repository.projectIds.add(archivedId);
  const root = await mkdtemp(join(tmpdir(), 'cocell-default-migration-'));
  await service.mountHomes(root);
  try {
    const secret = await service.create({ name: 'Old database', tool: 'mysql', path: '.my.cnf', format: 'text', mutable: false, content: '[client]\npassword=fixture-private' });
    const preexisting = { id: randomUUID(), name: 'Old role', connections: [{ tool: 'mysql', alias: 'old', secretId: secret.id }], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    await repository.roles.saveRole(preexisting, 'create');
    await repository.roles.assign(projectId, preexisting.id);
    await repository.roles.assign(archivedId, null);
    // Simulate a previous release's manifest and credential file.
    await service.homes!.publish(projectId, async () => [{ tool: 'mysql', secretId: secret.id, alias: 'old', path: '.my.cnf', content: Buffer.from('old-private').toString('base64'), mutable: false, version: 1 }]);
    await service.registerRuntime('historical-box', projectId, 1);
    await service.init();
    const catalog = await service.roles.catalog();
    const defaultRole = catalog.roles.find(role => role.id === catalog.defaultRoleId)!;
    assert.equal(defaultRole.name, 'Default'); assert.deepEqual(defaultRole.connections, []);
    for (const id of [projectId, archivedId]) {
      assert.deepEqual(await service.roles.state(id), { roleId: defaultRole.id, connections: [] });
      assert.deepEqual(await service.provision(id), []);
    }
    await assert.rejects(readFile(join(root, 'runtime/debug-homes', projectId, '.my.cnf')), { code: 'ENOENT' });
    await assert.rejects(service.authorize('historical-box', 'mysql', ['-e', 'SELECT 1']), /未授权/);
    // The user initializes the role after migration. Repeated startup must not reset it.
    await service.roles.save({ name: defaultRole.name, connections: preexisting.connections }, defaultRole.id);
    const authorized = await service.authorize('historical-box', 'mysql', ['-e', 'SELECT 1']);
    await writeFile(join(root, 'runtime/debug-homes', projectId, authorized.path), 'native-refresh');
    const restarted = new SecretService(repository, crypto); await restarted.mountHomes(root); await restarted.init();
    assert.deepEqual((await restarted.roles.state(projectId)).connections, preexisting.connections.map(connection => ({ ...connection, alias: secret.name, nativeNames: [secret.name] })));
    assert.equal(await readFile(join(root, 'runtime/debug-homes', projectId, authorized.path), 'utf8'), 'native-refresh');
    const newId = randomUUID(); repository.projectIds.add(newId);
    await repository.roles.assignDefault(newId);
    assert.equal((await restarted.roles.state(newId)).roleId, defaultRole.id);
    assert.ok(!JSON.stringify(await service.list()).includes('fixture-private'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('retired grant and credential transport endpoints are absent and default cannot be cleared', async () => {
  const { service, projectId } = fixture(); await service.init();
  const app = new Hono();
  app.onError((error, c) => c.json({ error: error.message }, error instanceof HttpError ? error.status as 400 : 400));
  installSecretRoutes(app, service, id => id === projectId);
  for (const [method, path] of [
    ['GET', `/api/projects/${projectId}/tool-permissions`], ['PUT', `/api/projects/${projectId}/tool-permissions`],
    ['GET', `/api/projects/${projectId}/tool-grants`], ['PUT', `/api/projects/${projectId}/tool-grants`],
    ['POST', '/api/tool-runtime/start'], ['POST', '/api/tool-runtime/files'], ['POST', `/api/tool-runtime/${randomUUID()}/complete`],
  ]) assert.equal((await app.request(path, { method })).status, 404);
  assert.equal((await app.request('/api/tool-roles/default', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ roleId: null }) })).status, 400);
  assert.ok((await service.roles.catalog()).defaultRoleId);
});

test('native text secrets retain bytes and reject unsafe paths without granting access implicitly', async () => {
  const { service, projectId } = fixture(); await service.init();
  const original = '\uFEFF[client]\r\npassword=fixture\r\n';
  const secret = await service.create({ name: 'Database', tool: 'mysql', path: '.my.cnf', format: 'text', mutable: true, content: original });
  assert.equal((await service.content(secret.id)).content, original);
  await service.update(secret.id, { name: 'Renamed' });
  assert.equal((await service.content(secret.id)).content, original);
  assert.equal((await service.content(secret.id)).version, 1);
  assert.deepEqual(await service.provision(projectId), []);
  assert.throws(() => credentialPath('../escape'), /路径/);
  assert.throws(() => toolName('/bin/sh'), /工具名/);
  await assert.rejects(service.create({ name: 'Bad', tool: 'mysql', path: '../escape', format: 'text', mutable: false, content: 'x' }), /路径/);
  await service.update(secret.id, { content: '[client]\npassword=new' });
  assert.equal((await service.content(secret.id)).version, 2);
  assert.ok(!(await service.versions(secret.id)).some(version => 'ciphertext' in version));
  await service.delete(secret.id); assert.equal((await service.list()).length, 0);
});


test('native profile names survive credential-label edits and reject conflicting updates atomically', async () => {
  const { service, projectId } = fixture(); await service.init();
  const root = await mkdtemp(join(tmpdir(), 'cocell-credential-names-')); await service.mountHomes(root);
  try {
    const secret = await service.create({ name: 'MySQL · reports', tool: 'mysql', path: '.my.cnf', format: 'text', mutable: false, content: '[doris]\nuser=fixture' });
    const role = await service.roles.save({ name: 'Reports', connections: [{ tool: 'mysql', secretId: secret.id }] });
    assert.deepEqual(role.connections[0].nativeNames, ['doris']);
    await service.roles.assign(projectId, role.id); await service.publishHome(projectId); await service.registerRuntime('name-box', projectId, 1);
    const auth = await service.authorize('name-box', 'mysql', ['--login-path=doris', '-e', 'SELECT 1']); assert.equal(auth.path, '.mylogin.cnf');
    await service.update(secret.id, { name: 'Renamed credential' });
    assert.deepEqual((await service.roles.state(projectId)).connections[0].nativeNames, ['doris']);
    await service.authorize('name-box', 'mysql', ['--login-path=doris', '-e', 'SELECT 1']);
    await assert.rejects(service.authorize('name-box', 'mysql', ['--login-path=Renamed credential', '-e', 'SELECT 1']), /未授权/);
    const duplicate = await service.create({ name: 'Different label', tool: 'mysql', path: '.my.cnf', format: 'text', mutable: false, content: '[doris]\nuser=other' });
    await assert.rejects(service.roles.save({ name: role.name, connections: [secret, duplicate].map(item => ({ tool: 'mysql', secretId: item.id })) }, role.id), /名称重复/);
    await service.update(duplicate.id, { content: '[uat]\nuser=other' });
    await service.roles.save({ name: role.name, connections: [secret, duplicate].map(item => ({ tool: 'mysql', secretId: item.id })) }, role.id);
    const before = await service.content(duplicate.id);
    await assert.rejects(service.update(duplicate.id, { content: '[doris]\nuser=other' }), /名称重复/);
    assert.deepEqual(await service.content(duplicate.id), before);
    await service.authorize('name-box', 'mysql', ['--login-path=uat', '-e', 'SELECT 1']);
  } finally { await rm(root, { recursive: true, force: true }); }
});
