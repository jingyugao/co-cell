import assert from 'node:assert/strict';
import test from 'node:test';
import { SandboxLifecycle } from '@co-cell/sandbox';
import type { CellboxSandboxProvider } from '../../packages/sandbox/src/providers/cellbox/index.js';
import { CellboxError } from '../../packages/sandbox/src/providers/cellbox/index.js';
import type { SecretService } from '../secrets/service.js';
import { SandboxRuntimeConfig } from './runtime-config.js';

function fixture(batch = false) {
  let generation = 1;
  let registeredGeneration = 1;
  let publications = 0;
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
    getBox: async () => ({ phase: 'running', generation, capabilities: { protectedTools: true, credentialBatch: batch, mountedDebugHome: true } }),
    writeCredential: async (_id: string, slot: string, bytes: Uint8Array) => { writes.push({ slot, bytes: Buffer.from(bytes).toString() }); },
    writeCredentials: async (_id: string, gen: number, slots: Record<string, Uint8Array>) => {
      if (gen !== generation) throw new CellboxError('STALE_GENERATION', 'Runtime changed');
      batches.push(Object.keys(slots));
      for (const [slot, bytes] of Object.entries(slots)) writes.push({ slot, bytes: Buffer.from(bytes).toString() });
    },
  } } as unknown as CellboxSandboxProvider;
  const secrets = { repository, homes: {}, publishHome: async () => { publications++; }, registerRuntime: async (_id: string, projectId: string, gen: number) => {
    assert.equal(projectId, 'project-one'); registeredGeneration = gen; return `runtime-${gen}`;
  } } as unknown as SecretService;
  const options = { provider, secrets, toolBrokerUrl: 'http://broker.example.test' };
  const lifecycle = () => new SandboxLifecycle([new SandboxRuntimeConfig(options).extension]);
  const reconcile = (host = lifecycle()) => host.run({ action: 'reconcile', resourceKey: 'project:project-one', sandboxId: 'box-one' }, async () => {});
  return { provider, options, lifecycle, reconcile, acknowledgements, writes, batches,
    setGeneration: (value: number) => { generation = value; }, publications: () => publications };
}

test('lifecycle publishes only native HOME descriptors and durable acknowledgements deduplicate restarts', async () => {
  const fake = fixture(true);
  await fake.lifecycle().run({ action: 'create', resourceKey: 'project:project-one', sandboxId: 'box-one' }, async () => {});
  assert.deepEqual(JSON.parse(fake.writes[0].bytes), { mode: 'home', boxId: 'box-one', url: fake.options.toolBrokerUrl });
  await fake.reconcile();
  assert.equal(fake.writes.length, 1);
  fake.options.toolBrokerUrl = 'http://new-broker.example.test';
  await fake.lifecycle().run({ action: 'restore', resourceKey: 'project:project-one', sandboxId: 'box-one' }, async () => {});
  assert.equal(JSON.parse(fake.writes[1].bytes).url, fake.options.toolBrokerUrl);
  fake.setGeneration(2);
  await fake.reconcile();
  assert.equal(fake.writes.length, 2);
  assert.equal(fake.acknowledgements.has('box-one:2'), false, 'Keep the stable provisioning revision');
  assert.deepEqual(fake.batches, [['cocell_tool_runtime'], ['cocell_tool_runtime']]);
  await fake.lifecycle().run({ action: 'destroy', resourceKey: 'project:project-one', sandboxId: 'box-one' }, async () => {});
  assert.equal(fake.acknowledgements.size, 0);
  assert.equal(fake.publications(), 0, 'Sandbox lifecycle must not rewrite shared CLI files');
});

test('runtime credentials require a Sandbox with mounted HOME support', async () => {
  const fake = fixture();
  fake.provider.client.getBox = async () => ({ phase: 'running', generation: 1, capabilities: { protectedTools: true } }) as never;
  await assert.rejects(fake.reconcile(), error => error instanceof Error &&
    (error as Error & { cause?: Error }).cause?.message === 'Mounted HOME credentials are required; rebuild the Sandbox with a current Cellbox image');
  assert.equal(fake.writes.length, 0);
  assert.equal(fake.publications(), 0);
});

test('cold rebuild restores a lost native HOME descriptor while retaining its provisioning revision', async () => {
  const fake = fixture(true);
  await fake.reconcile();
  const descriptor = fake.writes[0].bytes;
  fake.setGeneration(2);
  await fake.reconcile();
  assert.equal(fake.writes.length, 1, 'Ordinary reconnect keeps deduplication');
  await fake.lifecycle().run({ action: 'reconcile', resourceKey: 'project:project-one', sandboxId: 'box-one',
    metadata: { restoreRuntimeConfig: 'true' } }, async () => {});
  assert.equal(fake.writes.length, 2);
  assert.equal(fake.writes[1].bytes, descriptor);
  assert.equal(fake.acknowledgements.has('box-one:2'), false);
  assert.equal(fake.publications(), 0);
});

test('archive OSS slots remain independent from native HOME credentials and retry only unacknowledged slots', async () => {
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

test('archive OSS slots batch when supported and a failed batch is retried without acknowledgement', async () => {
  const fake = fixture(true);
  await fake.reconcile();
  const write = fake.provider.client.writeCredentials.bind(fake.provider.client);
  let fail = true;
  fake.provider.client.writeCredentials = async (id, generation, slots) => {
    if (Object.keys(slots).some(slot => slot.startsWith('cocell_oss_')) && fail) { fail = false; throw new CellboxError('UNKNOWN_OUTCOME', 'Interrupted batch'); }
    return write(id, generation, slots);
  };
  const runtime = new SandboxRuntimeConfig(fake.options);
  await assert.rejects(runtime.ensureArchiveCredentials('box-one'), /Interrupted batch/);
  assert.deepEqual(Object.keys(fake.acknowledgements.get('box-one:1')!), ['cocell_tool_runtime']);
  await runtime.ensureArchiveCredentials('box-one');
  assert.deepEqual(fake.batches.at(-1), ['cocell_oss_access_key', 'cocell_oss_secret_key']);
});

test('a stale credential batch cannot activate a Sandbox', async () => {
  const fake = fixture(true);
  fake.provider.client.writeCredentials = async () => { throw new CellboxError('STALE_GENERATION', 'Runtime changed'); };
  let activated = false;
  await assert.rejects(fake.lifecycle().run({ action: 'activate', resourceKey: 'project:project-one', sandboxId: 'box-one' },
    async () => { activated = true; }), /runtime-config pre failed/);
  assert.equal(activated, false);
  assert.equal(fake.acknowledgements.size, 0);
});

test('a generation change during delivery is not acknowledged and activation waits for setup', async () => {
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
  assert.deepEqual(JSON.parse(fake.writes[1].bytes), { mode: 'home', boxId: 'box-one', url: fake.options.toolBrokerUrl });
  assert.equal(fake.acknowledgements.has('box-one:2'), false);
});

test('an aborted queued runtime configuration never starts after the active one finishes', async () => {
  const fake = fixture();
  const runtime = new SandboxRuntimeConfig(fake.options);
  const lifecycle = new SandboxLifecycle([runtime.extension]);
  let releaseRead!: () => void, enteredRead!: () => void;
  const readGate = new Promise<void>(resolve => { releaseRead = resolve; });
  const entered = new Promise<void>(resolve => { enteredRead = resolve; });
  const getBox = fake.provider.client.getBox.bind(fake.provider.client);
  let reads = 0;
  fake.provider.client.getBox = async (id, signal) => {
    if (++reads === 1) { enteredRead(); await readGate; }
    return getBox(id, signal);
  };
  try {
    const first = lifecycle.run({ action: 'reconcile', resourceKey: 'project:project-one', sandboxId: 'box-one' }, async () => {});
    await entered;
    const controller = new AbortController();
    const queued = lifecycle.run({ action: 'connect', resourceKey: 'project:project-one', sandboxId: 'box-one', signal: controller.signal }, async () => {});
    controller.abort();
    await assert.rejects(queued, /abort/i);
    releaseRead();
    await first;
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(reads, 2);
    assert.equal(fake.writes.length, 1);
    assert.equal(fake.acknowledgements.size, 1);
  } finally { releaseRead(); }
});
