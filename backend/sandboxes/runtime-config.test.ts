import assert from 'node:assert/strict';
import test from 'node:test';
import { SandboxLifecycle } from '@co-cell/sandbox';
import type { CellboxSandboxProvider } from '../../packages/sandbox/src/providers/cellbox/index.js';
import type { SecretService } from '../secrets/service.js';
import { SandboxRuntimeConfig } from './runtime-config.js';

function fixture() {
  let generation = 1;
  const acknowledgements = new Map<string, Record<string, string>>();
  const writes: Array<{ slot: string; bytes: string }> = [];
  const repository = {
    runtime: async () => ({ projectId: 'project-one', generation }),
    runtimeConfig: async (boxId: string, gen: number) => ({ ...acknowledgements.get(`${boxId}:${gen}`) }),
    markRuntimeConfig: async (boxId: string, gen: number, slot: string, digest: string) => {
      const key = `${boxId}:${gen}`;
      acknowledgements.set(key, { ...acknowledgements.get(key), [slot]: digest });
    },
    forgetRuntime: async (boxId: string) => { for (const key of acknowledgements.keys()) if (key.startsWith(`${boxId}:`)) acknowledgements.delete(key); },
  };
  const provider = { client: {
    getBox: async () => ({ phase: 'running', generation, capabilities: { protectedTools: true } }),
    writeCredential: async (_id: string, slot: string, bytes: Uint8Array) => { writes.push({ slot, bytes: Buffer.from(bytes).toString() }); },
  } } as unknown as CellboxSandboxProvider;
  const secrets = { repository, registerRuntime: async (_id: string, projectId: string, gen: number) => {
    assert.equal(projectId, 'project-one'); return `runtime-${gen}`;
  } } as unknown as SecretService;
  const options = { provider, secrets, toolBrokerUrl: 'http://broker.example.test' };
  const lifecycle = () => new SandboxLifecycle([new SandboxRuntimeConfig(options).extension]);
  const reconcile = (host = lifecycle()) => host.run({ action: 'reconcile', resourceKey: 'project:project-one', sandboxId: 'box-one' }, async () => {});
  return { provider, options, lifecycle, reconcile, acknowledgements, writes, setGeneration: (value: number) => { generation = value; } };
}

test('durable acknowledgements skip writes across restarts and refresh only changed slots or generations', async () => {
  const fake = fixture();
  await fake.reconcile();
  assert.equal(fake.writes.length, 3);
  await fake.reconcile(); // New host/extension simulates a service restart.
  assert.equal(fake.writes.length, 3);
  fake.options.toolBrokerUrl = 'http://new-broker.example.test';
  await fake.reconcile();
  assert.equal(fake.writes.length, 4);
  assert.equal(fake.writes[3].slot, 'cocell_tool_runtime');
  assert.equal(JSON.parse(fake.writes[3].bytes).url, fake.options.toolBrokerUrl);
  fake.setGeneration(2);
  await fake.reconcile();
  assert.equal(fake.writes.length, 7);
  assert.equal(Object.keys(fake.acknowledgements.get('box-one:2')!).length, 3);
  await fake.lifecycle().run({ action: 'destroy', resourceKey: 'project:project-one', sandboxId: 'box-one' }, async () => {});
  assert.equal(fake.acknowledgements.size, 0);
});

test('partial delivery persists successful slots and a restart retries only the remainder', async () => {
  const fake = fixture();
  const originalWrite = fake.provider.client.writeCredential.bind(fake.provider.client);
  let fail = true;
  fake.provider.client.writeCredential = async (id, slot, bytes) => {
    if (slot === 'cocell_oss_access_key' && fail) { fail = false; throw new Error('transport failed'); }
    await originalWrite(id, slot, bytes);
  };
  await assert.rejects(fake.reconcile(), /runtime-config post failed/);
  assert.deepEqual(fake.writes.map(write => write.slot), ['cocell_tool_runtime']);
  await fake.reconcile();
  assert.deepEqual(fake.writes.map(write => write.slot), ['cocell_tool_runtime', 'cocell_oss_access_key', 'cocell_oss_secret_key']);
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
  assert.equal(JSON.parse(fake.writes[1].bytes).token, 'runtime-2');
  assert.equal(fake.acknowledgements.has('box-one:1'), false);
});
