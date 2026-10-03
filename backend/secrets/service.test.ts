import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Hono } from 'hono';
import { installOperatorAccess } from '../access/operator.js';
import { installSecretRoutes } from './routes.js';
import { HttpError } from '../../util/errors.js';
import type { ProjectToolGrant, ProxyTool } from '../../protocol/secret-types.js';
import { SecretCrypto } from './crypto.js';
import { credentialPath, toolName, validateToolArgs } from './policy.js';
import { SecretService } from './service.js';
import type { SecretRepository, StoredInvocation, StoredSecret, StoredVersion } from './repository.js';

export class MemorySecrets implements SecretRepository {
  records = new Map<string, StoredSecret>(); history: StoredVersion[] = [];
  bindings = new Map<string, ProjectToolGrant>(); runs = new Map<string, StoredInvocation>();
  runtimes = new Map<string, { projectId: string; generation: number }>();
  async init() {}
  async list() { return [...this.records.values()]; }
  async get(id: string) { return this.records.get(id) ?? null; }
  async delete(id: string) {
    this.records.delete(id);
    this.history = this.history.filter(version => version.secretId !== id);
    for (const [key, grant] of this.bindings) if (grant.files.some(file => file.secretId === id)) this.bindings.delete(key);
  }
  async save(secret: StoredSecret, version: StoredVersion | null) {
    const previous = this.records.get(secret.id);
    const changed = version?.changes.some(field => ['created', 'content'].includes(field));
    this.records.set(secret.id, { ...secret, version: (previous?.version ?? 0) + (changed ? 1 : 0), currentVersionId: changed ? version!.id : previous!.currentVersionId, ciphertext: changed ? version!.ciphertext : previous!.ciphertext });
    if (version) this.history.push(version);
  }
  async versions(id: string) { return this.history.filter(version => version.secretId === id); }
  async grants(projectId: string) { return [...this.bindings.values()].filter(grant => grant.projectId === projectId); }
  async allGrants() { return [...this.bindings.values()]; }
  async saveGrant(grant: ProjectToolGrant) {
    for (const [id, previous] of this.bindings) if (previous.projectId === grant.projectId && previous.tool === grant.tool) this.bindings.delete(id);
    this.bindings.set(grant.id, grant);
  }
  async replaceGrants(projectId: string, grants: ProjectToolGrant[]) {
    for (const [id, previous] of this.bindings) if (previous.projectId === projectId) this.bindings.delete(id);
    for (const grant of grants) this.bindings.set(grant.id, grant);
  }
  async deleteGrant(projectId: string, id: string) { if (this.bindings.get(id)?.projectId === projectId) this.bindings.delete(id); }
  async registerRuntime(boxId: string, projectId: string, generation: number) { this.runtimes.set(boxId, { projectId, generation }); }
  readonly configs = new Map<string, Record<string, string>>();
  async runtimeConfig(boxId: string, generation: number) { return { ...this.configs.get(`${boxId}:${generation}`) }; }
  async markRuntimeConfig(boxId: string, generation: number, slot: string, digest: string) {
    const key = `${boxId}:${generation}`;
    this.configs.set(key, { ...this.configs.get(key), [slot]: digest });
  }
  async markRuntimeConfigs(boxId: string, generation: number, digests: Record<string, string>) {
    const key = `${boxId}:${generation}`;
    this.configs.set(key, { ...this.configs.get(key), ...digests });
  }
  async forgetRuntime(boxId: string) {
    this.runtimes.delete(boxId);
    for (const key of this.configs.keys()) if (key.startsWith(`${boxId}:`)) this.configs.delete(key);
  }
  async runtime(boxId: string) { return this.runtimes.get(boxId) ?? null; }
  async startInvocation(value: StoredInvocation) { this.runs.set(value.id, value); }
  async invocation(id: string) { return this.runs.get(id) ?? null; }
  async completeInvocation(value: StoredInvocation, changes: Array<{ secret: StoredSecret; version: StoredVersion }>, _exitCode: number) {
    if (this.runs.get(value.id)?.completedAt) return false;
    for (const { secret, version } of changes) {
      const current = this.records.get(secret.id)!;
      this.records.set(secret.id, { ...current, version: current.version + 1, currentVersionId: version.id, ciphertext: version.ciphertext, updatedAt: version.createdAt }); this.history.push(version);
    }
    this.runs.set(value.id, value); return true;
  }
}
export function fixture() {
  const repository = new MemorySecrets(), crypto = new SecretCrypto(Buffer.alloc(32, 7).toString('base64'));
  const projectId = randomUUID();
  const service = new SecretService(repository, crypto, async () => ({ generation: 1, phase: 'running' }), (project, box) => project === projectId && box === 'box-a');
  return { repository, service, projectId, crypto };
}
test('local file provisioning and last commit wins sync do not check current selections or live Sandbox status', async () => {
  const { repository, projectId, crypto } = fixture();
  const service = new SecretService(repository, crypto, async () => { assert.fail('File sync must not inspect live Sandbox state'); }, (project, box) => project === projectId && box === 'box-a');
  const raw = '\uFEFF{"access_token":"original","refresh_token":"fixture"}\r\n';
  const secret = await service.create({ name: 'Local fixture', tool: 'custom.cli', path: '.config/测试/auth file.json', format: 'text', mutable: true, content: raw });
  await service.saveSelections(projectId, selections('custom.cli', secret.id));
  const files = await service.provision(projectId);
  assert.equal(files.length, 1);
  assert.equal(Buffer.from(files[0].content, 'base64').toString(), raw);
  assert.equal(files[0].path, '.config/测试/auth file.json');
  const token = await service.registerRuntime('box-a', projectId, 1);
  await service.saveSelections(projectId, []);
  await service.update(secret.id, { content: '{"refresh_token":"operator"}' });
  const updates = (value: string) => [{ secretId: secret.id, content: Buffer.from(value).toString('base64'), baseVersion: files[0].version }];
  assert.deepEqual(await service.syncFiles(token, 'custom.cli', updates('{"refresh_token":"tool-first"}'), 1), { saved: true });
  assert.deepEqual(await service.syncFiles(token, 'custom.cli', updates('{"refresh_token":"tool-last"}'), 0), { saved: true });
  assert.equal((await service.content(secret.id)).content, '{"refresh_token":"tool-last"}');
  assert.equal((await service.versions(secret.id)).at(-1)?.baseVersion, 1);
  assert.deepEqual(await service.provision(projectId), []);
  const operatorToken = 'operator-' + 'x'.repeat(32), origin = 'https://cocell.example.test';
  const app = new Hono();
  installOperatorAccess(app, { token: operatorToken, publicUrl: origin, projects: () => [] });
  app.onError((error, c) => c.json({ error: error instanceof HttpError ? error.message : 'invalid' }, error instanceof HttpError ? error.status as 400 : 400));
  installSecretRoutes(app, service, value => value === projectId);
  const sync = (bearer: string) => app.request(`${origin}/api/tool-runtime/files`, { method: 'POST', headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ tool: 'custom.cli', updates: updates('{"refresh_token":"via-api"}'), exitCode: 0 }) });
  assert.equal((await sync(operatorToken)).status, 401);
  assert.equal((await sync(token)).status, 200);
  assert.equal((await service.content(secret.id)).content, '{"refresh_token":"via-api"}');
  await service.delete(secret.id);
  await assert.rejects(service.syncFiles(token + 'invalid', 'custom.cli', updates('after deletion'), 0), /认证/);
  assert.deepEqual(await service.syncFiles(token, 'custom.cli', updates('after deletion'), 0), { saved: false, discarded: true });
  assert.deepEqual(await (await sync(token)).json(), { saved: false, discarded: true });
  assert.equal(await repository.get(secret.id), null);
  assert.deepEqual(await repository.versions(secret.id), []);
});
test('Secrets are encrypted and concurrent stale snapshots use last commit wins without replay', async () => {
  const { repository, service, projectId, crypto } = fixture();
  const secret = await service.create({ name: 'OAuth', tool: 'meegle', path: '.meegle/credentials.json', format: 'text', mutable: true, content: '{"access_token":"access-original","refresh_token":"refresh-original"}' });
  assert.ok(!JSON.stringify(await service.list()).includes('refresh-original'));
  assert.ok(!repository.records.get(secret.id)!.ciphertext.includes('refresh-original'));
  const sealed = repository.records.get(secret.id)!;
  assert.throws(() => crypto.open(randomUUID(), sealed.currentVersionId, sealed.ciphertext), /decryption/);
  const grant = await service.saveGrant(projectId, { tool: 'meegle', alias: 'dev', enabled: true, files: [{ secretId: secret.id, path: '.meegle/credentials.json' }], policy: { namespaces: [], resources: [], commandPrefixes: [['workitem', 'list']] } });
  const token = await service.registerRuntime('box-a', projectId, 1);
  const [a, b] = await Promise.all([service.start(token, 'meegle', 'dev', ['workitem', 'list']), service.start(token, 'meegle', 'dev', ['workitem', 'list'])]);
  await service.update(secret.id, { content: '{"refresh_token":"manual-new"}' });
  await service.complete(token, b.id, [{ secretId: secret.id, content: Buffer.from('{"refresh_token":"tool-b"}').toString('base64') }], 0);
  await service.complete(token, a.id, [{ secretId: secret.id, content: Buffer.from('{"refresh_token":"tool-a-last"}').toString('base64') }], 1);
  assert.equal(JSON.parse((await service.content(secret.id)).content).refresh_token, 'tool-a-last');
  assert.equal((await service.content(secret.id)).version, 4);
  assert.equal((await service.versions(secret.id)).at(-1)?.baseVersion, 1);
  await service.update(secret.id, { name: 'OAuth renamed' });
  assert.equal((await service.content(secret.id)).version, 4);
  assert.equal(JSON.parse((await service.content(secret.id)).content).refresh_token, 'tool-a-last');
  assert.equal((await service.complete(token, a.id, [], 0)).saved, false);
  await assert.rejects(service.start(token + 'x', 'meegle', 'dev', ['workitem', 'list']), /认证/);
  const foreign = await service.registerRuntime('box-b', randomUUID(), 1);
  await assert.rejects(service.start(foreign, 'meegle', 'dev', ['workitem', 'list']), /当前项目/);
  await service.deleteGrant(projectId, grant.id);
  await assert.rejects(service.start(token, 'meegle', 'dev', ['workitem', 'list']), /未授权/);
});
test('coarse authorization delegates operations to credentials while preventing connection overrides', () => {
  const grant: ProjectToolGrant = { id: randomUUID(), projectId: randomUUID(), tool: 'mysql', alias: 'doris', enabled: true, files: [], policy: { namespaces: ['staging'], resources: ['pods'], commandPrefixes: [['issue', 'list']] }, updatedAt: new Date().toISOString() };
  for (const sql of ['SELECT 1', 'SELECT 1; SELECT 2', 'UPDATE example SET value=1']) {
    const checked = validateToolArgs('mysql', ['-e', sql], grant);
    assert.deepEqual(checked, ['--binary-mode', '--local-infile=0', '-e', sql]);
  }
  for (const args of [['get', 'secrets', '-A'], ['delete', 'pods', 'example', '-n', 'prod']])
    assert.deepEqual(validateToolArgs('kubectl', args, grant), args);
  assert.deepEqual(validateToolArgs('glab', ['issue', 'create', '--title', 'Example'], grant), ['issue', 'create', '--title', 'Example']);
  assert.deepEqual(validateToolArgs('kubectl', ['--context=other', 'get', 'pods'], grant), ['--context=other', 'get', 'pods']);
  for (const args of [['get', 'pods', '-s', 'https://example.invalid'], ['get', 'pods', '--token=x']])
    assert.throws(() => validateToolArgs('kubectl', args, grant));
  assert.throws(() => validateToolArgs('mysql', ['--login-path=other', '-e', 'SELECT 1'], grant));
  assert.throws(() => validateToolArgs('glab', ['issue', 'list', '--token=x'], grant));
});
test('internal broker accepts only scoped runtime tokens and cannot access operator Secret APIs', async () => {
  const { service, projectId } = fixture();
  const operatorToken = 'operator-token-' + 'x'.repeat(32), origin = 'https://cocell.example.test';
  const app = new Hono();
  installOperatorAccess(app, { token: operatorToken, publicUrl: origin, projects: () => [] });
  app.onError((error, c) => c.json({ error: error instanceof HttpError ? error.message : 'failed' }, error instanceof HttpError ? error.status as 400 : 500));
  installSecretRoutes(app, service, id => id === projectId);
  const token = await service.registerRuntime('box-a', projectId, 1);
  const secret = await service.create({ name: 'doris', tool: 'mysql', path: '.my.cnf', format: 'text', mutable: false, content: '[client]\nhost=db.example.test\nuser=project-a\npassword=password-sensitive\n' });
  await service.saveGrant(projectId, { tool: 'mysql', alias: 'doris', enabled: true, files: [{ secretId: secret.id, path: '.my.cnf' }], policy: { namespaces: [], resources: [], commandPrefixes: [] } });
  const start = (bearer: string) => app.request('http://cocell.internal/api/tool-runtime/start', { method: 'POST', headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ tool: 'mysql', args: ['-e', 'SELECT 1'] }) });
  assert.equal((await start(operatorToken)).status, 401);
  assert.equal((await start(token + 'x')).status, 401);
  const allowed = await start(token); assert.equal(allowed.status, 200);
  assert.ok(Buffer.from((await allowed.json()).files[0].content, 'base64').toString().includes('password-sensitive'));
  assert.equal((await app.request(`${origin}/api/secrets/${secret.id}/content`, { headers: { Authorization: `Bearer ${token}` } })).status, 401);
  assert.equal((await app.request(`${origin}/api/secrets/${secret.id}/content`, { headers: { Authorization: `Bearer ${operatorToken}` } })).status, 200);
  const list = await app.request(`${origin}/api/secrets`, { headers: { Authorization: `Bearer ${operatorToken}` } });
  assert.ok(!(await list.text()).includes('password-sensitive'));
});

const selections = (tool: ProxyTool, secretId: string | null) => [{ tool, secretId }];

test('a single selection replaces the previous key, revokes in-flight writeback, and can be cleared', async () => {
  const { service, projectId } = fixture();
  const create = (name: string) => service.create({ name, tool: 'meegle', path: '.meegle/credentials.json', format: 'text', mutable: true, content: '{"access_token":"fixture"}' });
  const a = await create('Key A'), b = await create('Key B');
  assert.equal(a.path, '.meegle/credentials.json');
  await service.saveSelections(projectId, selections('meegle', a.id));
  const token = await service.registerRuntime('box-a', projectId, 1);
  const started = await service.start(token, 'meegle', undefined, ['workitem', 'update']);
  await service.saveSelections(projectId, selections('meegle', b.id));
  const grants = await service.grants(projectId);
  assert.equal(grants.length, 1);
  assert.equal(grants[0].files[0].secretId, b.id);
  assert.equal(grants[0].policy, undefined);
  await assert.rejects(service.complete(token, started.id, [{ secretId: a.id, content: Buffer.from('{"access_token":"changed"}').toString('base64') }], 0), /撤销或变更/);
  const next = await service.start(token, 'meegle', undefined, ['workitem', 'update']);
  assert.equal(next.files[0].secretId, b.id);
  await service.saveSelections(projectId, selections('meegle', null));
  await assert.rejects(service.start(token, 'meegle', undefined, ['workitem', 'list']), /未授权/);
});

test('invalid or duplicate selections leave the whole project configuration unchanged', async () => {
  const { service, projectId } = fixture();
  const secret = await service.create({ name: 'Meegle', tool: 'meegle', path: '.meegle/credentials.json', format: 'text', mutable: true, content: '{}' });
  await service.saveSelections(projectId, selections('meegle', secret.id));
  const original = await service.grants(projectId);
  await assert.rejects(service.saveSelections(projectId, selections('mysql', secret.id)), /该工具/);
  const duplicated = selections('meegle', secret.id);
  duplicated.push({ ...duplicated[0] });
  await assert.rejects(service.saveSelections(projectId, duplicated), /只能配置一次/);
  await service.update(secret.id, { enabled: false });
  await assert.rejects(service.saveSelections(projectId, selections('meegle', secret.id)), /已启用/);
  assert.deepEqual(await service.grants(projectId), original);
  await assert.rejects(service.update(secret.id, { tool: 'lark-cli' }), /已被项目使用/);
});

test('legacy grants classify secrets and multiple keys fail closed even with an explicit alias', async () => {
  const { repository, service, projectId } = fixture();
  const secret = await service.create({ name: 'Legacy', tool: 'meegle', path: '.meegle/credentials.json', format: 'text', mutable: true, content: '{}' });
  repository.records.set(secret.id, { ...repository.records.get(secret.id)!, tool: null, path: null, alias: null });
  await service.update(secret.id, { name: 'Legacy renamed' });
  const old = await service.saveGrant(projectId, { tool: 'meegle', alias: 'legacy', enabled: true, files: [{ secretId: secret.id, path: '.meegle/credentials.json' }] });
  const list = await service.list();
  assert.equal(list[0].tool, 'meegle');
  assert.equal(list[0].path, '.meegle/credentials.json');
  repository.bindings.set('legacy-duplicate', { ...old, id: 'legacy-duplicate' });
  const token = await service.registerRuntime('box-a', projectId, 1);
  await assert.rejects(service.start(token, 'meegle', 'legacy', ['workitem', 'list']), /多密钥/);
  await service.saveSelections(projectId, selections('meegle', secret.id));
  assert.equal((await service.grants(projectId)).length, 1);
  await assert.rejects(service.saveGrant(projectId, { ...old, files: [...old.files, ...old.files] }), /只能选择一个/);
});

test('selection API accepts only operator access and persists or clears one key per tool', async () => {
  const { service, projectId } = fixture();
  const operatorToken = 'operator-' + 'x'.repeat(32), origin = 'https://cocell.example.test';
  const app = new Hono();
  installOperatorAccess(app, { token: operatorToken, publicUrl: origin, projects: () => [] });
  app.onError((error, c) => c.json({ error: error instanceof HttpError ? error.message : 'invalid' }, error instanceof HttpError ? error.status as 400 : 400));
  installSecretRoutes(app, service, id => id === projectId);
  const create = (body: unknown) => app.request(`${origin}/api/secrets`, { method: 'POST', headers: { Authorization: `Bearer ${operatorToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const raw = '# original\naccess_token: fixture\n';
  const created = await create({ name: 'Custom API', tool: 'custom-api', path: '.config/custom/auth.yaml', content: raw });
  assert.equal(created.status, 201);
  const secret = await created.json();
  assert.equal(secret.format, 'text');
  assert.equal((await service.content(secret.id)).content, raw);
  for (const format of ['json', 'binary']) assert.equal((await create({ name: 'Invalid', tool: 'custom-api', path: 'auth', format, content: raw })).status, 400);
  assert.equal((await create({ name: 'Invalid path', tool: 'custom-api', path: '../auth', content: raw })).status, 400);
  const token = await service.registerRuntime('box-a', projectId, 1);
  const put = (bearer: string, chosen: ReturnType<typeof selections>) => app.request(`${origin}/api/projects/${projectId}/tool-grants`, {
    method: 'PUT', headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ selections: chosen }),
  });
  assert.equal((await put(token, selections('custom-api', secret.id))).status, 401);
  const response = await put(operatorToken, selections('custom-api', secret.id));
  assert.equal(response.status, 200);
  assert.equal((await response.json())[0].files[0].secretId, secret.id);
  assert.equal((await put(operatorToken, [])).status, 200);
  assert.equal((await service.grants(projectId)).length, 0);
});

test('arbitrary tools and paths use unchanged text, including YAML, and refresh through the same boundary', async () => {
  const { service, projectId } = fixture();
  const original = '# 保留注释\r\naccess_token: original-token\r\nextra: [a, b]\r\n';
  const custom = await service.create({ name: 'Custom', tool: 'custom.cli', path: '.config/自定义工具/auth.yaml', format: 'text', mutable: true, content: original });
  const kube = await service.create({ name: 'Kube YAML', tool: 'kubectl', path: 'configs/user kube.yaml', format: 'text', mutable: false, content: 'apiVersion: v1\nkind: Config\n' });
  await service.saveSelections(projectId, [{ tool: 'custom.cli', secretId: custom.id }, { tool: 'kubectl', secretId: kube.id }]);
  const token = await service.registerRuntime('box-a', projectId, 1);
  const started = await service.start(token, 'custom.cli', undefined, ['inspect']);
  assert.equal(Buffer.from(started.files[0].content, 'base64').toString(), original);
  assert.equal(started.files[0].path, '.config/自定义工具/auth.yaml');
  const rawKube = await service.start(token, 'kubectl', undefined, ['config', 'current-context']);
  assert.equal(Buffer.from(rawKube.files[0].content, 'base64').toString(), 'apiVersion: v1\nkind: Config\n');
  const updated = 'access_token: refreshed-token\n';
  await service.complete(token, started.id, [{ secretId: custom.id, content: Buffer.from(updated).toString('base64') }], 1);
  assert.equal((await service.content(custom.id)).content, updated);
  await service.saveSelections(projectId, []);
  await assert.rejects(service.start(token, 'custom.cli', undefined, ['inspect']), /未授权/);
  for (const value of ['../tool', '/bin/tool', 'tool/child', 'tool\0']) assert.throws(() => toolName(value));
  for (const value of ['../auth', '/etc/auth', '.config/../auth', './auth', 'auth\\file', '.']) assert.throws(() => credentialPath(value));
});

test('old non-text secrets retain ciphertext until explicitly reimported and cannot reach tool execution', async () => {
  const { repository, service, projectId } = fixture();
  const secret = await service.create({ name: 'Old format', tool: 'mysql', path: '.my.cnf', format: 'text', mutable: false, content: '[client]\nuser=fixture\n' });
  await service.saveSelections(projectId, selections('mysql', secret.id));
  const original = repository.records.get(secret.id)!;
  repository.records.set(secret.id, { ...original, format: 'binary' });
  assert.equal((await service.list())[0].requiresTextImport, true);
  assert.equal((await service.content(secret.id)).content, '');
  await service.update(secret.id, { name: 'Old renamed' });
  assert.equal(repository.records.get(secret.id)!.ciphertext, original.ciphertext);
  const token = await service.registerRuntime('box-a', projectId, 1);
  await assert.rejects(service.start(token, 'mysql', undefined, ['-e', 'SELECT 1']), /重新导入/);
  const raw = '[client]\nuser=reimported\n';
  await service.update(secret.id, { content: raw });
  assert.equal(repository.records.get(secret.id)!.format, 'text');
  assert.equal((await service.list())[0].requiresTextImport, false);
  const started = await service.start(token, 'mysql', undefined, ['-e', 'SELECT 1']);
  assert.equal(Buffer.from(started.files[0].content, 'base64').toString(), raw);
  const jsonText = '{"refresh_token":"old-json-token"}';
  const oldJson = await service.create({ name: 'Old JSON', tool: 'custom-cli', path: '.config/auth.json', format: 'text', mutable: true, content: jsonText });
  repository.records.set(oldJson.id, { ...repository.records.get(oldJson.id)!, format: 'json' });
  assert.equal((await service.content(oldJson.id)).content, jsonText);
  await service.update(oldJson.id, { content: jsonText });
  assert.equal(repository.records.get(oldJson.id)!.format, 'text');
  assert.equal((await service.content(oldJson.id)).content, jsonText);
});

test('operator deletion removes history and every project binding while discarding in-flight refreshes', async () => {
  const { repository, service, projectId } = fixture();
  const otherProject = randomUUID();
  const secret = await service.create({ name: 'Delete fixture', tool: 'custom.cli', path: 'auth.json', format: 'text', mutable: true, content: '{"refresh_token":"original"}' });
  const preserved = await service.create({ name: 'Keep fixture', tool: 'mysql', path: '.my.cnf', format: 'text', mutable: false, content: '[client]\nuser=fixture\n' });
  await service.saveSelections(projectId, [{ tool: 'custom.cli', secretId: secret.id }, { tool: 'mysql', secretId: preserved.id }]);
  await service.saveSelections(otherProject, selections('custom.cli', secret.id));
  const token = await service.registerRuntime('box-a', projectId, 1);
  const started = await service.start(token, 'custom.cli', undefined, ['refresh']);
  const runtime = await repository.runtime('box-a');
  const operatorToken = 'operator-' + 'x'.repeat(32), origin = 'https://cocell.example.test';
  const app = new Hono();
  installOperatorAccess(app, { token: operatorToken, publicUrl: origin, projects: () => [] });
  app.onError((error, c) => c.json({ error: error instanceof HttpError ? error.message : 'invalid' }, error instanceof HttpError ? error.status as 400 : 400));
  installSecretRoutes(app, service, value => value === projectId || value === otherProject);
  const remove = (bearer: string, id = secret.id) => app.request(`${origin}/api/secrets/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${bearer}` } });
  assert.equal((await remove(token)).status, 401);
  assert.ok(await repository.get(secret.id));
  assert.equal((await remove(operatorToken, 'not-a-uuid')).status, 400);
  const response = await remove(operatorToken);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(await repository.get(secret.id), null);
  assert.deepEqual(await repository.versions(secret.id), []);
  assert.equal((await service.list()).some(item => item.id === secret.id), false);
  assert.deepEqual((await service.grants(projectId)).map(grant => grant.files[0].secretId), [preserved.id]);
  assert.deepEqual(await service.grants(otherProject), []);
  assert.deepEqual(await repository.runtime('box-a'), runtime);
  for (const suffix of ['/content', '/versions']) {
    assert.equal((await app.request(`${origin}/api/secrets/${secret.id}${suffix}`, { headers: { Authorization: `Bearer ${operatorToken}` } })).status, 404);
  }
  await assert.rejects(service.start(token, 'custom.cli', undefined, ['refresh']), /未授权/);
  const update = [{ secretId: secret.id, content: Buffer.from('{"refresh_token":"after-deletion"}').toString('base64') }];
  await assert.rejects(service.complete(token + 'x', started.id, update, 0), /认证/);
  assert.deepEqual(await service.complete(token, started.id, update, 0), { saved: false, discarded: true });
  assert.ok(repository.runs.get(started.id)?.completedAt);
  assert.equal(await repository.get(secret.id), null);
  assert.deepEqual(await repository.versions(secret.id), []);
  assert.equal((await remove(operatorToken)).status, 200);

  // Deletion can also win after authorization and before the storage write.
  const racing = await service.create({ name: 'Racing fixture', tool: 'race.cli', path: 'auth', format: 'text', mutable: true, content: 'original' });
  await service.saveGrant(projectId, { tool: 'race.cli', alias: 'default', enabled: true, files: [{ secretId: racing.id, path: 'auth' }] });
  const inFlight = await service.start(token, 'race.cli', undefined, []);
  const complete = repository.completeInvocation.bind(repository);
  repository.completeInvocation = async (invocation, changes, code) => {
    if (changes.some(change => change.secret.id === racing.id)) {
      await repository.delete(racing.id);
      throw new Error('Secret is no longer writable');
    }
    return complete(invocation, changes, code);
  };
  assert.deepEqual(await service.complete(token, inFlight.id, [{ secretId: racing.id, content: Buffer.from('refreshed').toString('base64') }], 1), { saved: false, discarded: true });
  assert.equal(await repository.get(racing.id), null);
  assert.deepEqual(await repository.versions(racing.id), []);
  assert.equal((await service.grants(projectId))[0].files[0].secretId, preserved.id);
});
