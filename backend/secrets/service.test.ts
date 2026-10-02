import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Hono } from 'hono';
import { installOperatorAccess } from '../access/operator.js';
import { installSecretRoutes } from './routes.js';
import { HttpError } from '../../util/errors.js';
import type { ProjectToolGrant } from '../../protocol/secret-types.js';
import { SecretCrypto } from './crypto.js';
import { validateToolArgs } from './policy.js';
import { SecretService } from './service.js';
import type { SecretRepository, StoredInvocation, StoredSecret, StoredVersion } from './repository.js';

export class MemorySecrets implements SecretRepository {
  records = new Map<string, StoredSecret>(); history: StoredVersion[] = [];
  bindings = new Map<string, ProjectToolGrant>(); runs = new Map<string, StoredInvocation>();
  runtimes = new Map<string, { projectId: string; generation: number }>();
  async init() {}
  async list() { return [...this.records.values()]; }
  async get(id: string) { return this.records.get(id) ?? null; }
  async save(secret: StoredSecret, version: StoredVersion | null) {
    const previous = this.records.get(secret.id);
    const changed = version?.changes.some(field => ['created', 'content'].includes(field));
    this.records.set(secret.id, { ...secret, version: (previous?.version ?? 0) + (changed ? 1 : 0), currentVersionId: changed ? version!.id : previous!.currentVersionId, ciphertext: changed ? version!.ciphertext : previous!.ciphertext });
    if (version) this.history.push(version);
  }
  async versions(id: string) { return this.history.filter(version => version.secretId === id); }
  async grants(projectId: string) { return [...this.bindings.values()].filter(grant => grant.projectId === projectId); }
  async allGrants() { return [...this.bindings.values()]; }
  async saveGrant(grant: ProjectToolGrant) { this.bindings.set(grant.id, grant); }
  async deleteGrant(projectId: string, id: string) { if (this.bindings.get(id)?.projectId === projectId) this.bindings.delete(id); }
  async registerRuntime(boxId: string, projectId: string, generation: number) { this.runtimes.set(boxId, { projectId, generation }); }
  readonly configs = new Map<string, Record<string, string>>();
  async runtimeConfig(boxId: string, generation: number) { return { ...this.configs.get(`${boxId}:${generation}`) }; }
  async markRuntimeConfig(boxId: string, generation: number, slot: string, digest: string) {
    const key = `${boxId}:${generation}`;
    this.configs.set(key, { ...this.configs.get(key), [slot]: digest });
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
test('Secrets are encrypted and concurrent stale snapshots use last commit wins without replay', async () => {
  const { repository, service, projectId, crypto } = fixture();
  const secret = await service.create({ name: 'OAuth', format: 'json', mutable: true, content: '{"access_token":"access-original","refresh_token":"refresh-original"}' });
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
test('SQL comment tricks and kubectl scope/endpoint overrides fail closed', () => {
  const grant: ProjectToolGrant = { id: randomUUID(), projectId: randomUUID(), tool: 'mysql', alias: 'doris', enabled: true, files: [], policy: { namespaces: ['staging'], resources: ['pods', 'pods/log'], commandPrefixes: [] }, updatedAt: new Date().toISOString() };
  assert.deepEqual(validateToolArgs('mysql', ['--login-path=doris', '-e', 'SELECT 1'], grant), ['--login-path=doris', '-e', 'SELECT 1']);
  for (const sql of ["SELECT 1 INTO/**/OUTFILE '/tmp/x'", 'EXPLAIN INSERT INTO x VALUES(1)', 'SELECT 1; SELECT 2', 'SELECT GET_LOCK("x", 1)']) assert.throws(() => validateToolArgs('mysql', ['--login-path=doris', '-e', sql], grant));
  for (const args of [['get', 'pods', '-s', 'https://example.invalid'], ['get', 'secrets'], ['get', 'pods', '-A'], ['get', 'pods', '-n', 'prod'], ['get', 'pods', '--token=x'], ['delete', 'pods', 'x']]) assert.throws(() => validateToolArgs('kubectl', args, grant));
  assert.deepEqual(validateToolArgs('kubectl', ['get', 'pods'], grant), ['--namespace', 'staging', 'get', 'pods']);
});
test('internal broker accepts only scoped runtime tokens and cannot access operator Secret APIs', async () => {
  const { service, projectId } = fixture();
  const operatorToken = 'operator-token-' + 'x'.repeat(32), origin = 'https://cocell.example.test';
  const app = new Hono();
  installOperatorAccess(app, { token: operatorToken, publicUrl: origin, projects: () => [], provider: {
    getAccessRequest: async () => { throw Error(); }, approveAccessRequest: async () => { throw Error(); },
  } });
  app.onError((error, c) => c.json({ error: error instanceof HttpError ? error.message : 'failed' }, error instanceof HttpError ? error.status as 400 : 500));
  installSecretRoutes(app, service, id => id === projectId);
  const token = await service.registerRuntime('box-a', projectId, 1);
  const secret = await service.create({ name: 'doris', format: 'json', mutable: false, content: '{"host":"db.example.test","user":"project-a","password":"password-sensitive"}' });
  await service.saveGrant(projectId, { tool: 'mysql', alias: 'doris', enabled: true, files: [{ secretId: secret.id, path: '.my.cnf' }], policy: { namespaces: [], resources: [], commandPrefixes: [] } });
  const start = (bearer: string) => app.request('http://cocell.internal/api/tool-runtime/start', { method: 'POST', headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ tool: 'mysql', alias: 'doris', args: ['--login-path=doris', '-e', 'SELECT 1'] }) });
  assert.equal((await start(operatorToken)).status, 401);
  assert.equal((await start(token + 'x')).status, 401);
  const allowed = await start(token); assert.equal(allowed.status, 200);
  assert.ok(Buffer.from((await allowed.json()).files[0].content, 'base64').toString().includes('password-sensitive'));
  assert.equal((await app.request(`${origin}/api/secrets/${secret.id}/content`, { headers: { Authorization: `Bearer ${token}` } })).status, 401);
  assert.equal((await app.request(`${origin}/api/secrets/${secret.id}/content`, { headers: { Authorization: `Bearer ${operatorToken}` } })).status, 200);
  const list = await app.request(`${origin}/api/secrets`, { headers: { Authorization: `Bearer ${operatorToken}` } });
  assert.ok(!(await list.text()).includes('password-sensitive'));
});
