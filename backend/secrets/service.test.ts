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
  readonly roles = new MemoryRoleRepository(() => [...this.projectIds]);
  records = new Map<string, StoredSecret>(); history: StoredVersion[] = [];
  runtimes = new Map<string, { projectId: string; generation: number }>();
  readonly configs = new Map<string, Record<string, string>>();
  async init() {}
  async list() { return [...this.records.values()]; }
  async toolConfigs(tool: string) {
    return [...this.records.values()].filter(secret => secret.tool === tool)
      .map(({ path, format, enabled }) => ({ path, format, enabled }));
  }
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

test('generic tool authorization needs only its role and never reads credential contents', async () => {
  const { service, repository, projectId } = fixture();
  await service.init();
  const tools = ['lark-cli', 'meegle', 'git', 'glab'];
  const role = await service.roles.save({ name: 'Native tools', permissions: tools.map(tool => ({ tool, enabled: true })) });
  await service.roles.assign(projectId, role.id);
  await service.registerRuntime('generic-box', projectId, 1);
  const registered = await service.create({ name: 'Lark HOME', tool: 'lark-cli', path: '.lark-cli/config.json', format: 'home', mutable: true });
  repository.list = async () => { throw Object.assign(new Error('native credential file is missing'), { code: 'ENOENT' }); };

  for (const tool of tools) for (const args of [['auth', '--help'], ['auth', 'status']]) {
    const result = await service.authorize('generic-box', tool, args);
    assert.deepEqual(result, { tool, args, home: '/home/debug', ...(tool === 'lark-cli' ? { path: registered.path } : {}) });
  }
  await service.roles.assign(projectId, null);
  await assert.rejects(service.authorize('generic-box', 'lark-cli', ['auth', '--help']),
    error => error instanceof HttpError && error.status === 403);
});

test('registered native HOME is shared while tool access remains role-gated', async () => {
  const { service, repository, projectId } = fixture();
  const root = await mkdtemp(join(tmpdir(), 'cocell-native-authorization-'));
  try {
    await service.mountHomes(root); await service.init();
    const secret = await service.create({ name: 'Native CLI', tool: 'custom-cli', path: '.tool/config', format: 'text', mutable: true, content: 'initial' });
    const role = await service.roles.save({ name: 'Operators', permissions: [{ tool: 'custom-cli', enabled: true }] });
    await service.roles.assign(projectId, role.id); await service.publishHome();
    const sharedHome = join(root, 'runtime/debug-homes');
    const credential = join(sharedHome, '.tool/config');
    await writeFile(credential, 'live-native-state');
    await service.registerRuntime('native-box', projectId, 1);
    const auth = await service.authorize('native-box', 'custom-cli', ['status']);
    assert.equal(auth.home, '/home/debug');
    assert.equal(auth.path, '.tool/config');
    assert.equal(await readFile(credential, 'utf8'), 'live-native-state');
    assert.equal((await service.list())[0].homeDirectory, auth.home);
    const consumer = randomUUID(); await service.roles.assign(consumer, role.id);
    await service.registerRuntime('consumer-box', consumer, 1);
    assert.equal((await service.authorize('consumer-box', 'custom-cli', ['status'])).home, '/home/debug');
    await service.roles.assign(consumer, null);
    await assert.rejects(service.authorize('consumer-box', 'custom-cli', ['status']), /未授权/);
    assert.equal(await readFile(credential, 'utf8'), 'live-native-state', 'revocation does not rewrite shared CLI state');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('authorization never republishes native configuration after a source edit', async () => {
  const { service, repository, projectId, crypto } = fixture();
  const root = await mkdtemp(join(tmpdir(), 'cocell-native-mysql-'));
  try {
    await service.mountHomes(root); await service.init();
    const secret = await service.create({ name: 'Warehouse', tool: 'mysql', path: '.my.cnf', format: 'text', mutable: true, content: '[warehouse]\nhost=old.example.test\nuser=synthetic\n' });
    repository.records.get(secret.id)!.nativeHome = secret.id;
    const role = await service.roles.save({ name: 'Warehouse readers', permissions: [{ tool: 'mysql', enabled: true, credentials: ['warehouse'] }] });
    await service.roles.assign(projectId, role.id); await service.publishHome();
    await service.registerRuntime('native-mysql-box', projectId, 1);
    const file = join(root, 'runtime/debug-homes', '.mylogin.cnf');
    const before = await readFile(file);
    const current = repository.records.get(secret.id)!;
    current.ciphertext = crypto.seal(current.id, current.currentVersionId, Buffer.from('[warehouse]\nhost=new.example.test\nuser=synthetic\n'));
    const auth = await service.authorize('native-mysql-box', 'mysql', ['--login-path=warehouse', '-e', 'SELECT 1']);
    assert.equal(auth.home, '/home/debug');
    assert.deepEqual(await readFile(file), before, 'runtime authorization does not rewrite CLI configuration');
    assert.equal(current.version, secret.version);
    await service.publishHome();
    assert.notDeepEqual(await readFile(file), before, 'explicit configuration publishing remains independent');
    await assert.rejects(service.authorize('native-mysql-box', 'mysql', ['--login-path=ungranted', '-e', 'SELECT 1']), /未授权/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('all enabled native profiles share one HOME while project roles only grant access', async () => {
  const { service, repository, projectId, crypto } = fixture(); await service.init();
  const root = await mkdtemp(join(tmpdir(), 'cocell-roles-')); await service.mountHomes(root);
  try {
    const create = (name: string, tool: string) => service.create({ name: 'Credential ' + name, tool, path: tool === 'mysql' ? '.my.cnf' : '.kube/config', format: 'text', mutable: false,
      content: tool === 'mysql' ? '[' + name + ']\nuser=fixture\npassword=synthetic-' + name + '\n'
        : JSON.stringify({ apiVersion: 'v1', kind: 'Config', clusters: [{ name: 'shared', cluster: { server: 'https://' + name + '.example.test' } }], users: [{ name: 'admin', user: { token: 'synthetic-' + name } }], contexts: [{ name, context: { cluster: 'shared', user: 'admin' } }], 'current-context': name }) });
    const mysqlA = await create('analytics', 'mysql'), mysqlB = await create('warehouse', 'mysql');
    const kubeA = await create('staging', 'kubectl'), kubeB = await create('production', 'kubectl');
    const roleA = await service.roles.save({ name: 'Analytics operators', permissions: [
      { tool: 'mysql', enabled: true, credentials: ['analytics'] }, { tool: 'kubectl', enabled: true, credentials: ['staging'] },
    ] });
    const roleB = await service.roles.save({ name: 'Warehouse operators', permissions: [
      { tool: 'mysql', enabled: true, credentials: ['warehouse'] }, { tool: 'kubectl', enabled: true, credentials: ['production'] },
    ] });
    const projectB = randomUUID();
    await service.roles.assign(projectId, roleA.id); await service.roles.assign(projectB, roleB.id); await service.publishHome();
    await service.registerRuntime('role-box', projectId, 1); await service.registerRuntime('other-box', projectB, 1);
    const files = await service.provision(); assert.equal(files.length, 2);
    assert.deepEqual(files.map(file => file.path).sort(), ['.kube/config', '.mylogin.cnf']);
    const home = join(root, 'runtime/debug-homes');
    const kube = JSON.parse(await readFile(join(home, '.kube/config'), 'utf8'));
    assert.deepEqual(kube.contexts.map((item: { name: string }) => item.name), ['staging', 'production']);
    const projectAConfigs = { mysql: await readFile(join(home, '.mylogin.cnf')), kube: await readFile(join(home, '.kube/config')) };
    const authorized = async (box: string, tool: string, name: string) => service.authorize(box, tool,
      tool === 'mysql' ? ['--login-path=' + name, '-e', 'SELECT 1'] : ['--context=' + name, 'get', 'pods']);
    for (const [box, tool, name] of [['role-box', 'mysql', 'analytics'], ['role-box', 'kubectl', 'staging'], ['other-box', 'mysql', 'warehouse'], ['other-box', 'kubectl', 'production']]) {
      const auth = await authorized(box, tool, name);
      assert.equal(auth.home, '/home/debug');
      assert.equal(auth.path, tool === 'mysql' ? '.mylogin.cnf' : '.kube/config');
      assert.ok(!JSON.stringify(auth).includes('synthetic-'));
    }
    // A role selects its own native profile names; shared files do not widen
    // that role's authorization, including informational/version requests.
    await assert.rejects(authorized('role-box', 'mysql', 'warehouse'), /未授权|权限/);
    await assert.rejects(authorized('other-box', 'mysql', 'analytics'), /未授权|权限/);
    await assert.rejects(authorized('role-box', 'kubectl', 'production'), /未授权|权限/);
    await assert.rejects(service.authorize('other-box', 'kubectl', ['get', 'pods']), /--context/);
    await assert.rejects(service.authorize('role-box', 'mysql', ['-e', 'SELECT 1']), /login-path|连接/);
    await assert.rejects(service.authorize('role-box', 'kubectl', ['get', 'pods']), /--context/,
      'runtime authorization never infers the shared native default');
    assert.equal((await service.authorize('role-box', 'mysql', ['--login-path=analytics', '--version'])).path, '.mylogin.cnf');
    await assert.rejects(service.authorize('role-box', 'mysql', ['--login-path=warehouse', '--version']), /未授权|权限/);
    await assert.rejects(service.authorize('role-box', 'kubectl', ['--context=production', 'version']), /未授权|权限/);
    await assert.rejects(service.authorize('role-box', 'mysql', ['--login-path=analytics', '--login-path=analytics', '-e', 'SELECT 1']), /缺失|重复|无效|selector/i);
    await assert.rejects(service.authorize('role-box', 'kubectl', ['--context=staging', '--context=production', 'get', 'pods']), /重复|selector|context/i);
    await assert.rejects(service.authorize('role-box', 'mysql', ['--login-path=missing', '-e', 'SELECT 1']), /未授权/);
    await assert.rejects(service.authorize('role-box', 'mysql', ['--login-path=analytics', '--login-path=warehouse', '-e', 'SELECT 1']), /缺失|重复|无效|selector/i);
    await assert.rejects(service.authorize('role-box', 'kubectl', ['--context=staging', '--kubeconfig=/tmp/other', 'get', 'pods']), /覆盖/);
    await assert.rejects(service.authorize('role-box', 'mysql', ['--login-path=analytics', '--host=other', '-e', 'SELECT 1']), /mysql/);
    const restarted = new SecretService(repository, crypto); await restarted.mountHomes(root); await restarted.init();
    assert.deepEqual(await restarted.roles.state(projectId), await service.roles.state(projectId));
    assert.equal((await restarted.authorize('role-box', 'mysql', ['--login-path', 'analytics', '-e', 'SELECT 1'])).path, '.mylogin.cnf');
    const before = await readFile(join(home, '.mylogin.cnf')); await service.publishHome();
    assert.deepEqual(await readFile(join(home, '.mylogin.cnf')), before);
    await service.roles.assign(projectB, null);
    assert.deepEqual(await readFile(join(home, '.mylogin.cnf')), before, 'changing project grants leaves the shared config untouched');
    assert.deepEqual(await readFile(join(home, '.kube/config')), projectAConfigs.kube, 'revoking one project does not remove global contexts');
    await assert.rejects(authorized('other-box', 'mysql', 'warehouse'), /未授权/);
    assert.equal((await authorized('role-box', 'mysql', 'analytics')).home, '/home/debug');
    await service.roles.assign(projectB, roleB.id);
    assert.deepEqual(await readFile(join(home, '.mylogin.cnf')), before, 'regranting a project does not rewrite the shared config');
    await service.update(mysqlA.id, { enabled: false });
    assert.equal((await service.authorize('role-box', 'mysql', ['--login-path=analytics', '-e', 'SELECT 1'])).path, '.mylogin.cnf',
      'removing credential material does not change the role grant; the CLI reports missing credentials');
    assert.notDeepEqual(await readFile(join(home, '.mylogin.cnf')), before);
    assert.equal((await authorized('other-box', 'mysql', 'warehouse')).path, '.mylogin.cnf');
    await service.roles.save({ name: roleA.name, permissions: [{ tool: 'mysql', enabled: true, credentials: ['warehouse'] }] }, roleA.id);
    await assert.rejects(service.authorize('role-box', 'kubectl', ['get', 'pods']), /未授权/);
    assert.deepEqual(await readFile(join(home, '.kube/config')), projectAConfigs.kube, 'role edits cannot remove shared Kubernetes contexts');
    await service.delete(mysqlB.id); assert.equal((await service.provision()).length, 1);
    await assert.rejects(readFile(join(home, '.mylogin.cnf')), { code: 'ENOENT' });
    await service.roles.assign(projectId, null); assert.deepEqual(await service.roles.state(projectId), { roleId: null, permissions: [] });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('ordinary tools have one enabled shared config and can register a replacement after disable', async () => {
  const { service, projectId } = fixture();
  const root = await mkdtemp(join(tmpdir(), 'cocell-single-tool-config-'));
  try {
    await service.mountHomes(root); await service.init();
    const first = await service.create({ name: 'GitLab primary', tool: 'glab', path: '.config/glab/config.yml', format: 'text', mutable: false, content: 'host: first.example.test' });
    await assert.rejects(service.create({ name: 'GitLab replacement', tool: 'glab', path: '.config/glab/alternate.yml', format: 'text', mutable: false, content: 'host: second.example.test' }), /共用一份主配置/);
    assert.equal((await service.list()).length, 1, 'the rejected second registration is not persisted');

    await service.update(first.id, { enabled: false });
    const replacement = await service.create({ name: 'GitLab replacement', tool: 'glab', path: '.config/glab/alternate.yml', format: 'text', mutable: false, content: 'host: second.example.test' });
    const role = await service.roles.save({ name: 'GitLab users', permissions: [{ tool: 'glab', enabled: true }] });
    await service.roles.assign(projectId, role.id);
    await service.registerRuntime('single-config-box', projectId, 1);

    const files = await service.provision();
    assert.deepEqual(files.map(file => file.path), ['.config/glab/alternate.yml']);
    assert.equal((await service.authorize('single-config-box', 'glab', ['auth', 'status'])).path, replacement.path);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('credential authorization checks grants without reading or publishing native files', async () => {
  const { service, projectId } = fixture();
  const root = await mkdtemp(join(tmpdir(), 'cocell-missing-kubeconfig-'));
  try {
    await service.mountHomes(root); await service.init();
    await service.create({ name: 'Staging cluster', tool: 'kubectl', path: '.kube/config', format: 'text', mutable: false,
      content: JSON.stringify({ apiVersion: 'v1', kind: 'Config', clusters: [{ name: 'staging', cluster: { server: 'https://staging.example.test' } }], users: [{ name: 'operator', user: { token: 'synthetic-token' } }], contexts: [{ name: 'staging', context: { cluster: 'staging', user: 'operator' } }], 'current-context': 'staging' }) });
    await service.create({ name: 'Database', tool: 'mysql', path: '.my.cnf', format: 'text', mutable: false, content: '[reports]\nuser=synthetic' });
    const role = await service.roles.save({ name: 'Staging operators', permissions: [
      { tool: 'kubectl', enabled: true, credentials: ['staging'] }, { tool: 'mysql', enabled: true, credentials: ['reports'] },
    ] });
    await service.roles.assign(projectId, role.id);
    await service.registerRuntime('missing-kubeconfig-box', projectId, 1);

    const canonical = join(root, 'runtime/debug-homes/.kube/config');
    const before = (await service.toolCatalog()).find(item => item.name === 'kubectl');
    assert(before?.kind === 'tool-with-credential');
    assert.equal(before.defaultCredential, 'staging');
    await rm(canonical);

    const kubectl = (await service.toolCatalog()).find(item => item.name === 'kubectl');
    assert.ok(kubectl && !('defaultCredential' in kubectl), 'a missing mounted config cannot claim a current-context default');
    await rm(join(root, 'runtime/debug-homes/.mylogin.cnf'));
    service.repository.list = async () => { throw new Error('runtime must not read native credentials'); };
    service.repository.toolConfigs = async () => { throw new Error('runtime must not look up credential existence'); };
    service.homes!.read = async () => { throw new Error('runtime must not inspect native files'); };
    service.publishHome = async () => { throw new Error('runtime must not publish configuration'); };
    for (const [tool, args, path] of [
      ['kubectl', ['--context=staging', 'get', 'pods'], '.kube/config'],
      ['mysql', ['--login-path=reports', '-e', 'SELECT 1'], '.mylogin.cnf'],
      ['kubectl', ['version', '--client'], '.kube/config'],
      ['mysql', ['--help'], '.mylogin.cnf'],
    ] as const) {
      assert.equal((await service.authorize('missing-kubeconfig-box', tool, [...args])).path, path);
    }
    await assert.rejects(service.authorize('missing-kubeconfig-box', 'kubectl', ['--context=other', 'version', '--client']),
      error => error instanceof HttpError && error.status === 403);
    await assert.rejects(service.authorize('missing-kubeconfig-box', 'mysql', ['--login-path=other', '--version']),
      error => error instanceof HttpError && error.status === 403);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('role API requires operator access and validates tool permissions and credential names', async () => {
  const { service, projectId } = fixture();
  await service.init();
  const app = new Hono();
  app.onError((error, c) => c.json({ error: error.message }, error instanceof HttpError ? error.status as 400 : 400));
  installOperatorAccess(app, { token: 'operator-role-fixture-0123456789abcdef', publicUrl: 'https://app.example.test', projects: () => [] });
  installSecretRoutes(app, service, id => id === projectId);
  const headers = { Authorization: 'Bearer operator-role-fixture-0123456789abcdef', 'Content-Type': 'application/json' };
  assert.equal((await app.request('https://app.example.test/api/tool-roles')).status, 401);
  assert.equal((await app.request('https://app.example.test/api/tool-roles', { method: 'POST', body: JSON.stringify({ name: 'Denied', permissions: [] }) })).status, 401);
  assert.equal((await app.request('https://app.example.test/api/tools')).status, 401);
  const created = await app.request('https://app.example.test/api/tool-roles', { method: 'POST', headers, body: JSON.stringify({ name: 'No tools', permissions: [] }) });
  assert.equal(created.status, 201);
  const role = await created.json();
  assert.equal((await app.request('https://app.example.test/api/tool-roles/default', { method: 'PUT', headers, body: JSON.stringify({ roleId: role.id }) })).status, 200);
  const noTools = await app.request(`https://app.example.test/api/projects/${projectId}/tool-role`, { method: 'GET', headers });
  assert.deepEqual((await noTools.json()).permissions, []);
  assert.equal((await app.request(`https://app.example.test/api/projects/${projectId}/tool-role`, { method: 'PUT', headers, body: JSON.stringify({ roleId: role.id }) })).status, 200);
  assert.equal((await app.request(`https://app.example.test/api/tool-roles/${role.id}`, { method: 'DELETE', headers })).status, 409);
  await service.create({ name: 'glab', tool: 'glab', path: '.config/glab/config.yml', format: 'text', content: 'fixture', mutable: false });
  const mysqlSecret = await service.create({ name: 'Analytics', tool: 'mysql', path: '.my.cnf', format: 'text', mutable: false, content: '[analytics]\nuser=fixture' });
  const ordinary = { tool: 'glab', enabled: true };
  await assert.rejects(service.roles.save({ name: 'Missing native profile', permissions: [{ tool: 'mysql', enabled: true, credentials: ['missing'] }] }), /credential|连接|凭据/i);
  await assert.rejects(service.roles.save({ name: 'Empty native profile', permissions: [{ tool: 'mysql', enabled: true, credentials: [] }] }), /至少|credential|连接/i);
  await assert.rejects(service.roles.save({ name: 'Duplicate native profile', permissions: [{ tool: 'mysql', enabled: true, credentials: ['analytics', 'analytics'] }] }), /重复/);
  await assert.rejects(service.roles.save({ name: 'Ordinary tool with credentials', permissions: [{ tool: 'glab', enabled: true, credentials: ['analytics'] }] }), /只支持|凭据/);
  await assert.rejects(service.roles.save({ name: 'Duplicate tool', permissions: [ordinary, ordinary] }), /重复/);
  assert.equal((await service.roles.catalog()).roles.length, 2);
  const selectedPermissions = [ordinary, { tool: 'mysql', enabled: true, credentials: ['analytics'] }];
  const selected = await app.request('https://app.example.test/api/tool-roles', { method: 'POST', headers, body: JSON.stringify({ name: 'GitLab access', permissions: selectedPermissions }) });
  assert.equal(selected.status, 201);
  assert.deepEqual((await selected.json()).permissions, selectedPermissions);
  const customAlias = await app.request('https://app.example.test/api/tool-roles', { method: 'POST', headers, body: JSON.stringify({ name: 'Legacy connection input', connections: [{ tool: 'glab', secretId: mysqlSecret.id }] }) });
  assert.equal(customAlias.status, 400, 'roles no longer accept per-secret grants');
  const toolsResponse = await app.request('https://app.example.test/api/tools', { headers });
  assert.equal(toolsResponse.status, 200);
  const tools = await toolsResponse.json();
  assert.ok(tools.some((item: { name: string; kind: string }) => item.name === 'glab' && item.kind === 'tool'));
  const mysql = tools.find((item: { name: string }) => item.name === 'mysql');
  assert.equal(mysql.kind, 'tool-with-credential');
  assert.deepEqual(mysql.credentials, ['analytics']);
  if (mysql.defaultCredential !== undefined) assert.equal(mysql.defaultCredential, 'analytics');
  assert.ok(!JSON.stringify(tools).includes(mysqlSecret.id), 'tool catalog exposes native names, not Secret IDs');
  await service.registerRuntime('no-tools-box', projectId, 1);
  await assert.rejects(service.authorize('no-tools-box', 'mysql', ['--login-path=analytics', '--version']), /未授权/);
});


test('bootstrap resets historical project grants while shared config survives independently', async () => {
  const { service, repository, projectId, crypto } = fixture();
  const archivedId = randomUUID(); repository.projectIds.add(archivedId);
  const root = await mkdtemp(join(tmpdir(), 'cocell-default-migration-'));
  await service.mountHomes(root);
  try {
    const secret = await service.create({ name: 'Old database', tool: 'mysql', path: '.my.cnf', format: 'text', mutable: false, content: '[client]\npassword=fixture-private' });
    const preexisting = { id: randomUUID(), name: 'Old role', permissions: [{ tool: 'mysql', enabled: true, credentials: [secret.name] }], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    await repository.roles.saveRole(preexisting, 'create');
    await repository.roles.assign(projectId, preexisting.id);
    await repository.roles.assign(archivedId, null);
    await service.registerRuntime('historical-box', projectId, 1);
    await service.init();
    const catalog = await service.roles.catalog();
    const defaultRole = catalog.roles.find(role => role.id === catalog.defaultRoleId)!;
    assert.equal(defaultRole.name, 'Default'); assert.deepEqual(defaultRole.permissions, []);
    for (const id of [projectId, archivedId]) {
      assert.deepEqual(await service.roles.state(id), { roleId: defaultRole.id, permissions: [] });
    }
    assert.deepEqual((await service.provision()).map(file => file.path), ['.mylogin.cnf']);
    const home = join(root, 'runtime/debug-homes');
    assert.equal((await service.provision()).length, 1, 'enabled connections stay in the shared HOME independently of grants');
    await assert.rejects(service.authorize('historical-box', 'mysql', ['-e', 'SELECT 1']), /未授权/);
    // The user initializes the role after migration. Repeated startup must not reset it.
    await service.roles.save({ name: defaultRole.name, permissions: preexisting.permissions }, defaultRole.id);
    const authorized = await service.authorize('historical-box', 'mysql', ['--login-path=' + secret.name, '-e', 'SELECT 1']);
    assert.equal(authorized.home, '/home/debug');
    assert.ok(authorized.path);
    await writeFile(join(home, authorized.path), 'native-refresh');
    const restarted = new SecretService(repository, crypto); await restarted.mountHomes(root); await restarted.init();
    assert.deepEqual((await restarted.roles.state(projectId)).permissions, preexisting.permissions);
    assert.equal(await readFile(join(home, authorized.path), 'utf8'), 'native-refresh');
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
  assert.deepEqual((await service.provision()).map(file => file.path), ['.mylogin.cnf']);
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
    const role = await service.roles.save({ name: 'Reports', permissions: [{ tool: 'mysql', enabled: true, credentials: ['doris'] }] });
    assert.deepEqual(role.permissions[0].credentials, ['doris']);
    await service.roles.assign(projectId, role.id); await service.publishHome(); await service.registerRuntime('name-box', projectId, 1);
    const auth = await service.authorize('name-box', 'mysql', ['--login-path=doris', '-e', 'SELECT 1']); assert.equal(auth.path, '.mylogin.cnf');
    await service.update(secret.id, { name: 'Renamed credential' });
    assert.deepEqual((await service.roles.state(projectId)).permissions[0].credentials, ['doris']);
    await service.authorize('name-box', 'mysql', ['--login-path=doris', '-e', 'SELECT 1']);
    await assert.rejects(service.authorize('name-box', 'mysql', ['--login-path=Renamed credential', '-e', 'SELECT 1']), /未授权/);
    await assert.rejects(service.create({ name: 'Different label', tool: 'mysql', path: '.my.cnf', format: 'text', mutable: false, content: '[doris]\nuser=other' }), /名称重复/);
    const duplicate = await service.create({ name: 'Different label', tool: 'mysql', path: '.my.cnf', format: 'text', mutable: false, content: '[uat]\nuser=other' });
    await service.roles.save({ name: role.name, permissions: [{ tool: 'mysql', enabled: true, credentials: ['doris', 'uat'] }] }, role.id);
    const before = await service.content(duplicate.id);
    await assert.rejects(service.update(duplicate.id, { content: '[doris]\nuser=other' }), /名称重复/);
    assert.deepEqual(await service.content(duplicate.id), before);
    await service.authorize('name-box', 'mysql', ['--login-path=uat', '-e', 'SELECT 1']);
  } finally { await rm(root, { recursive: true, force: true }); }
});
