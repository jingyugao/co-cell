import assert from 'node:assert/strict';
import test from 'node:test';
import { SandboxLifecycle } from '@co-cell/sandbox';
import type { CellboxSandboxProvider } from '../../packages/sandbox/src/providers/cellbox/index.js';
import type { SecretService } from '../secrets/service.js';
import { SandboxRuntimeConfig } from './runtime-config.js';
import type { ProvisionedToolFile } from '../../protocol/secret-types.js';
import { CellboxError } from '../../packages/sandbox/src/providers/cellbox/index.js';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function fixture(batch = false) {
  let generation = 1;
  let registeredGeneration = 1;
  let files: ProvisionedToolFile[] = [], provisions = 0;
  const acknowledgements = new Map<string, Record<string, string>>();
  const writes: Array<{ slot: string; bytes: string }> = [];
  const batches: string[][] = [];
  const repository = {
    runtime: async () => ({ projectId: 'project-one', generation: registeredGeneration }),
    runtimeConfig: async (boxId: string, gen: number) => ({ ...acknowledgements.get(`${boxId}:${gen}`) }),
    markRuntimeConfig: async (boxId: string, gen: number, slot: string, digest: string) => {
      const key = `${boxId}:${gen}`;
      acknowledgements.set(key, { ...acknowledgements.get(key), [slot]: digest });
    },
    markRuntimeConfigs: async (boxId: string, gen: number, digests: Record<string, string>) => {
      const key = `${boxId}:${gen}`;
      acknowledgements.set(key, { ...acknowledgements.get(key), ...digests });
    },
    forgetRuntime: async (boxId: string) => { for (const key of acknowledgements.keys()) if (key.startsWith(`${boxId}:`)) acknowledgements.delete(key); },
  };
  const provider = { client: {
    getBox: async () => ({ phase: 'running', generation, capabilities: { protectedTools: true, credentialBatch: batch } }),
    writeCredential: async (_id: string, slot: string, bytes: Uint8Array) => { writes.push({ slot, bytes: Buffer.from(bytes).toString() }); },
    writeCredentials: async (_id: string, gen: number, slots: Record<string, Uint8Array>) => {
      if (gen !== generation) throw new CellboxError('STALE_GENERATION', 'Runtime changed');
      batches.push(Object.keys(slots));
      for (const [slot, bytes] of Object.entries(slots)) writes.push({ slot, bytes: Buffer.from(bytes).toString() });
    },
  } } as unknown as CellboxSandboxProvider;
  const secrets = { repository, provision: async () => { provisions++; return files; }, registerRuntime: async (_id: string, projectId: string, gen: number) => {
    assert.equal(projectId, 'project-one'); registeredGeneration = gen; return `runtime-${gen}`;
  } } as unknown as SecretService;
  const options = { provider, secrets, toolBrokerUrl: 'http://broker.example.test' };
  const lifecycle = () => new SandboxLifecycle([new SandboxRuntimeConfig(options).extension]);
  const reconcile = (host = lifecycle()) => host.run({ action: 'reconcile', resourceKey: 'project:project-one', sandboxId: 'box-one' }, async () => {});
  return { provider, options, lifecycle, reconcile, acknowledgements, writes, batches, setGeneration: (value: number) => { generation = value; }, setFiles: (value: ProvisionedToolFile[]) => { files = value; }, provisions: () => provisions };
}

test('connect and resume preserve provisioned files; explicit restore applies a fresh snapshot', async () => {
  const fake = fixture();
  const file = { tool: 'custom.cli', secretId: 'secret', path: 'auth.json', content: Buffer.from('{"token":"fixture"}').toString('base64'), mutable: true, version: 1 };
  fake.setFiles([file]);
  const run = (action: 'create' | 'connect' | 'resume' | 'restore') => fake.lifecycle().run({ action, resourceKey: 'project:project-one', sandboxId: 'box-one' }, async () => {});
  await run('create');
  assert.deepEqual(JSON.parse(fake.writes[0].bytes).files, [file]);
  fake.setFiles([]);
  await run('connect');
  await fake.reconcile();
  assert.equal(fake.writes.length, 1);
  assert.equal(fake.provisions(), 1);
  fake.setGeneration(2);
  await run('resume');
  assert.equal(fake.writes.length, 1);
  assert.equal(fake.provisions(), 1);
  await run('restore');
  assert.equal(fake.writes.length, 2);
  assert.equal(fake.provisions(), 2);
  assert.deepEqual(JSON.parse(fake.writes[1].bytes).files, []);
});

test('mounted credentials survive restart and resume without runtime queries or file updates, and destroy removes them', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cocell-runtime-mount-'));
  const fake = fixture(true);
  const getBox = fake.provider.client.getBox;
  fake.provider.client.getBox = async id => {
    const box = await getBox(id);
    return { ...box, capabilities: { ...box.capabilities, mountedToolRuntime: true } };
  };
  const options = { ...fake.options, sharedDataRoot: root };
  const file = { tool: 'git', secretId: 'secret', path: '.gitconfig', content: Buffer.from('fixture').toString('base64'), mutable: true, version: 1 };
  const path = join(root, 'runtime', 'boxes', 'box-one', 'tool-runtime.json');
  const run = (action: 'create' | 'connect' | 'resume' | 'destroy') => new SandboxLifecycle([new SandboxRuntimeConfig(options).extension])
    .run({ action, resourceKey: 'project:project-one', sandboxId: 'box-one' }, async () => {});
  try {
    fake.setFiles([file]);
    await run('create');
    assert.equal(fake.writes.length, 1);
    assert.deepEqual(JSON.parse(fake.writes[0].bytes), { mode: 'mount', path: '/var/lib/cellbox/shared/runtime/boxes/box-one/tool-runtime.json' });
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')).files, [file]);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    fake.setFiles([]);
    await run('connect'); // Restart cannot erase a previously selected file.
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')).files, [file]);
    assert.equal(fake.provisions(), 1);
    const initialBytes = await readFile(path, 'utf8'), initialFile = await stat(path);
    fake.setGeneration(2);
    fake.provider.client.getBox = async () => { assert.fail('Resume must not query the Box for credential setup'); };
    await run('resume');
    const resumed = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(resumed.revision, 1); assert.equal(resumed.boxId, 'box-one'); assert.deepEqual(resumed.files, [file]);
    assert.equal(await readFile(path, 'utf8'), initialBytes);
    assert.equal((await stat(path)).ino, initialFile.ino);
    assert.equal(fake.provisions(), 1);
    assert.equal(fake.writes.length, 1, 'Checkpoint retains its descriptor and mounted snapshot');
    assert.equal(fake.batches.length, 1);
    assert.equal(fake.acknowledgements.has('box-one:2'), false);
    await run('destroy');
    assert.equal(await stat(path).catch(() => null), null);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a changed generation during mounted delivery is not acknowledged', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cocell-runtime-stale-'));
  const fake = fixture(true), getBox = fake.provider.client.getBox;
  let observations = 0;
  fake.provider.client.getBox = async id => {
    if (++observations === 2) fake.setGeneration(2);
    const box = await getBox(id);
    return { ...box, capabilities: { ...box.capabilities, mountedToolRuntime: true } };
  };
  try {
    const lifecycle = new SandboxLifecycle([new SandboxRuntimeConfig({ ...fake.options, sharedDataRoot: root }).extension]);
    let activated = false;
    await assert.rejects(lifecycle.run({ action: 'activate', resourceKey: 'project:project-one', sandboxId: 'box-one' },
      async () => { activated = true; }), /runtime-config pre failed/);
    assert.equal(activated, false); assert.equal(fake.acknowledgements.size, 0); assert.equal(fake.writes.length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('durable acknowledgements survive execution changes and explicit provisioning refreshes changed configuration', async () => {
  const fake = fixture();
  await fake.reconcile();
  assert.equal(fake.writes.length, 1);
  await fake.reconcile(); // New host/extension simulates a service restart.
  assert.equal(fake.writes.length, 1);
  fake.options.toolBrokerUrl = 'http://new-broker.example.test';
  await fake.lifecycle().run({ action: 'restore', resourceKey: 'project:project-one', sandboxId: 'box-one' }, async () => {});
  assert.equal(fake.writes.length, 2);
  assert.equal(fake.writes[1].slot, 'cocell_tool_runtime');
  assert.equal(JSON.parse(fake.writes[1].bytes).url, fake.options.toolBrokerUrl);
  fake.setGeneration(2);
  await fake.reconcile();
  assert.equal(fake.writes.length, 2);
  assert.equal(fake.acknowledgements.has('box-one:2'), false);
  assert.equal(Object.keys(fake.acknowledgements.get('box-one:1')!).length, 1);
  await fake.lifecycle().run({ action: 'destroy', resourceKey: 'project:project-one', sandboxId: 'box-one' }, async () => {});
  assert.equal(fake.acknowledgements.size, 0);
});

test('legacy archive delivery persists successful slots and a restart retries only the remainder', async () => {
  const fake = fixture();
  const originalWrite = fake.provider.client.writeCredential.bind(fake.provider.client);
  let fail = true;
  fake.provider.client.writeCredential = async (id, slot, bytes) => {
    if (slot === 'cocell_oss_secret_key' && fail) { fail = false; throw new Error('transport failed'); }
    await originalWrite(id, slot, bytes);
  };
  await fake.reconcile();
  await assert.rejects(new SandboxRuntimeConfig(fake.options).ensureArchiveCredentials('box-one'), /transport failed/);
  assert.deepEqual(fake.writes.map(write => write.slot), ['cocell_tool_runtime', 'cocell_oss_access_key']);
  await new SandboxRuntimeConfig(fake.options).ensureArchiveCredentials('box-one');
  assert.deepEqual(fake.writes.map(write => write.slot), ['cocell_tool_runtime', 'cocell_oss_access_key', 'cocell_oss_secret_key']);
});

test('startup delivers one configuration and archives batch OSS slots only when needed', async () => {
  const fake = fixture(true);
  const runtime = new SandboxRuntimeConfig(fake.options);
  await fake.lifecycle().run({ action: 'create', resourceKey: 'project:project-one', sandboxId: 'box-one' }, async () => {});
  assert.deepEqual(fake.batches, [['cocell_tool_runtime']]);
  await runtime.ensureArchiveCredentials('box-one');
  assert.deepEqual(fake.batches[1], ['cocell_oss_access_key', 'cocell_oss_secret_key']);
  await runtime.ensureArchiveCredentials('box-one');
  assert.equal(fake.batches.length, 2);
  assert.equal(fake.provisions(), 1);
});

test('failed credential batch is not acknowledged and a retry sends the entire batch', async () => {
  const fake = fixture(true);
  await fake.reconcile();
  const write = fake.provider.client.writeCredentials.bind(fake.provider.client);
  let fail = true;
  fake.provider.client.writeCredentials = async (id, generation, slots) => {
    if (fail) { fail = false; throw new CellboxError('UNKNOWN_OUTCOME', 'Interrupted batch'); }
    return write(id, generation, slots);
  };
  const runtime = new SandboxRuntimeConfig(fake.options);
  await assert.rejects(runtime.ensureArchiveCredentials('box-one'), /Interrupted batch/);
  assert.deepEqual(Object.keys(fake.acknowledgements.get('box-one:1')!), ['cocell_tool_runtime']);
  await runtime.ensureArchiveCredentials('box-one');
  assert.deepEqual(fake.batches[1], ['cocell_oss_access_key', 'cocell_oss_secret_key']);
});

test('older Guest fallback remains usable and a stale batch cannot activate', async () => {
  const fake = fixture(true);
  fake.provider.client.writeCredentials = async () => { throw new CellboxError('NOT_FOUND', 'Older Guest'); };
  await fake.reconcile();
  assert.equal(fake.writes.length, 1);
  const stale = fixture(true);
  stale.provider.client.writeCredentials = async () => { throw new CellboxError('STALE_GENERATION', 'Runtime changed'); };
  let activated = false;
  await assert.rejects(stale.lifecycle().run({ action: 'activate', resourceKey: 'project:project-one', sandboxId: 'box-one' },
    async () => { activated = true; }), /runtime-config pre failed/);
  assert.equal(activated, false);
  assert.equal(stale.acknowledgements.size, 0);
});

test('a generation change during delivery is not acknowledged and activation waits for successful setup', async () => {
  const fake = fixture();
  const originalWrite = fake.provider.client.writeCredential.bind(fake.provider.client);
  fake.provider.client.writeCredential = async (id, slot, bytes) => {
    await originalWrite(id, slot, bytes);
    fake.setGeneration(2);
  };
  let activated = false;
  await assert.rejects(fake.lifecycle().run({ action: 'activate', resourceKey: 'project:project-one', sandboxId: 'box-one' },
    async () => { activated = true; }), /runtime-config pre failed/);
  assert.equal(activated, false);
  assert.equal(fake.acknowledgements.size, 0);
  fake.provider.client.writeCredential = originalWrite;
  await fake.reconcile();
  assert.equal(JSON.parse(fake.writes[1].bytes).boxId, 'box-one');
  assert.equal(fake.acknowledgements.has('box-one:2'), false);
});
