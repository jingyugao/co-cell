import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { DynamicTool, DynamicToolInput } from '../../protocol/tool-types.js';
import type { ToolScript, ToolScriptInput } from '../../protocol/tool-script-types.js';
import { MemoryRoleRepository } from './role-repository.js';
import { SecretService } from './service.js';
import type { SecretRepository } from './repository.js';
import { DynamicTools } from '../tools/service.js';
import type { ToolRepository } from '../tools/repository.js';
import type { ToolScriptRepository } from '../tools/script-repository.js';

class MemoryRepository implements SecretRepository {
  readonly projects = new Set<string>();
  readonly roles = new MemoryRoleRepository(() => [...this.projects]);
  private runtimes = new Map<string, { projectId: string; generation: number }>();
  private configs = new Map<string, Record<string, string>>();
  async init() { await this.roles.init(); }
  async registerRuntime(boxId: string, projectId: string, generation: number) { this.runtimes.set(boxId, { projectId, generation }); }
  async runtime(boxId: string) { return this.runtimes.get(boxId) ?? null; }
  async runtimeConfig(boxId: string, generation: number) { return { ...this.configs.get(`${boxId}:${generation}`) }; }
  async markRuntimeConfig(boxId: string, generation: number, slot: string, digest: string) {
    await this.markRuntimeConfigs(boxId, generation, { [slot]: digest });
  }
  async markRuntimeConfigs(boxId: string, generation: number, digests: Record<string, string>) {
    const key = `${boxId}:${generation}`;
    this.configs.set(key, { ...this.configs.get(key), ...digests });
  }
  async forgetRuntime(boxId: string) {
    this.runtimes.delete(boxId);
    for (const key of this.configs.keys()) if (key.startsWith(`${boxId}:`)) this.configs.delete(key);
  }
}

class MemoryScripts implements ToolScriptRepository {
  records = new Map<string, ToolScript>();
  async init() {}
  async list() { return [...this.records.values()]; }
  async get(id: string) { return this.records.get(id); }
  async save(input: ToolScriptInput, id?: string, version?: number) {
    const scriptId = id ?? randomUUID();
    const previous = this.records.get(scriptId);
    if (id && version !== undefined && previous?.version !== version) throw new Error('stale script');
    const script = { ...input, id: scriptId, version: (previous?.version ?? 0) + 1,
      createdAt: previous?.createdAt ?? new Date().toISOString(), updatedAt: new Date().toISOString() };
    this.records.set(scriptId, script);
    return script;
  }
  async delete(id: string, _version: number) { this.records.delete(id); }
}

class MemoryTools implements ToolRepository {
  readonly scripts = new MemoryScripts();
  constructor(private definitions: Map<string, DynamicTool>) {}
  async init() {}
  async list() { return [...this.definitions.values()]; }
  async get(name: string) { return this.definitions.get(name); }
  async save(input: DynamicToolInput) {
    const tool = definition(input.name, input);
    this.definitions.set(tool.name, tool);
    return tool;
  }
  async delete(name: string, _version: number) { this.definitions.delete(name); }
}

function definition(name: string, input: Partial<DynamicToolInput> = {}): DynamicTool {
  return { name, description: '', instructions: '', enabled: true, executable: `/usr/bin/${name}`, args: [], env: {}, timeoutMs: 20_000,
    version: 1, createdAt: '', updatedAt: '', ...input };
}

export function fixture(initial: DynamicTool[] = [definition('sample')]) {
  const repository = new MemoryRepository();
  const definitions = new Map(initial.map(tool => [tool.name, tool]));
  const toolRepository = new MemoryTools(definitions);
  const root = join(tmpdir(), `cocell-dynamic-tools-${randomUUID()}`);
  const tools = new DynamicTools(toolRepository, root);
  const service = new SecretService(repository, tools);
  const projectId = randomUUID();
  repository.projects.add(projectId);
  return { repository, scripts: toolRepository.scripts, definitions, service, projectId, tools, toolRoot: root };
}

test('role grants are checked on every invocation and follow definition/runtime lifecycle', async t => {
  const { repository, definitions, service, projectId, toolRoot } = fixture();
  t.after(() => rm(toolRoot, { recursive: true, force: true }));
  await service.tools.init();
  await service.init();
  const role = await service.roles.save({ name: 'Sample users', permissions: [{ tool: 'sample', enabled: true }] });
  await service.roles.assign(projectId, role.id);
  await service.registerRuntime('sample-box', projectId, 1);

  const auth = await service.authorize('sample-box', 'sample', ['run']);
  assert.deepEqual(auth, {
    tool: 'sample', args: ['run'], home: '/home/debug',
    execution: { executable: '/usr/bin/sample', args: [], env: {}, timeoutMs: 20_000 }, credentialPaths: [],
  });
  await service.roles.assign(projectId, null);
  await assert.rejects(service.authorize('sample-box', 'sample', ['run']), /未授权/);

  await service.roles.assign(projectId, role.id);
  definitions.set('sample', definition('sample', { enabled: false }));
  await assert.rejects(service.authorize('sample-box', 'sample', ['run']), /停用/);
  definitions.delete('sample');
  await assert.rejects(service.authorize('sample-box', 'sample', ['run']), /未注册|删除/);
  await repository.forgetRuntime('sample-box');
  await assert.rejects(service.authorize('sample-box', 'sample', ['run']), /未绑定/);
});

test('named credentials are discovered by Load hooks and checked against project grants per call', async t => {
  const permissionScriptId = randomUUID(), loadScriptId = randomUUID();
  const tool = definition('ssh', {
    executable: '/usr/bin/ssh', credentialMode: 'named', credentialPath: '.ssh/config', credentialPaths: ['.ssh'],
    permissionScriptId, credentialParseScriptId: loadScriptId,
  });
  const { repository, scripts, definitions, service, projectId, tools, toolRoot } = fixture([tool]);
  t.after(() => rm(toolRoot, { recursive: true, force: true }));
  await scripts.save({ name: 'ssh select credential', language: 'typescript', source: 'return { allow: true, credential: input.args[0] };' }, permissionScriptId);
  await scripts.save({ name: 'ssh discover hosts', language: 'typescript', source: "return { content: codec.utf8.decode(input.content), encoding: 'utf8', names: ['prod', 'stage'] };" }, loadScriptId);
  await tools.init();
  await service.init();
  const root = await mkdtemp(join(tmpdir(), 'cocell-dynamic-credentials-'));
  try {
    await service.mountHomes(root);
    const home = join(root, 'runtime/debug-homes');
    await mkdir(join(home, '.ssh'), { recursive: true });
    await writeFile(join(home, '.ssh/config'), 'Host prod\n HostName prod.example.test\n Host stage\n HostName stage.example.test\n');
    assert.deepEqual(await service.toolCatalog(), [{ name: 'ssh', kind: 'tool-with-credential', credentials: ['prod', 'stage'] }]);

    const role = await service.roles.save({ name: 'Prod SSH', permissions: [{ tool: 'ssh', enabled: true, credentials: ['prod'] }] });
    await service.roles.assign(projectId, role.id);
    await service.registerRuntime('ssh-box', projectId, 1);

    const auth = await service.authorize('ssh-box', 'ssh', ['prod', 'uptime']);
    assert.equal(auth.path, '.ssh/config');
    assert.deepEqual(auth.credentialPaths, ['.ssh']);
    // Authorization must rely on the permission hook and current role grant,
    // without reopening the credential file after catalog discovery.
    service.credentialFiles!.read = async () => { throw new Error('authorization must not read credential files'); };
    assert.equal((await service.authorize('ssh-box', 'ssh', ['prod', 'uptime'])).path, '.ssh/config');
    await assert.rejects(service.authorize('ssh-box', 'ssh', ['stage', 'uptime']), /未授权|必须选择项目已授权/);
    const permission = scripts.records.get(permissionScriptId)!;
    scripts.records.set(permissionScriptId, { ...permission, source: 'return true;' });
    await assert.rejects(service.authorize('ssh-box', 'ssh', ['prod', 'uptime']), /必须选择项目已授权/);
    scripts.records.set(permissionScriptId, permission);
    definitions.set('ssh', { ...tool, credentialMode: 'shared' });
    await assert.rejects(service.authorize('ssh-box', 'ssh', ['prod', 'uptime']), /模式不匹配/);
    definitions.set('ssh', tool);
    await service.roles.assign(projectId, null);
    await assert.rejects(service.authorize('ssh-box', 'ssh', ['prod', 'uptime']), /未授权/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
