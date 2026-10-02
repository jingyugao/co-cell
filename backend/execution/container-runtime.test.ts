import assert from 'node:assert/strict';
import test from 'node:test';
import type { SandboxHandle, SandboxProvider } from '@co-cell/sandbox';
import { ContainerCodexRuntime } from './container-runtime.js';
import type { ProjectSandboxes } from '../sandboxes/project-sandboxes.js';

test('health verification uses a non-resuming connection and never prepares the environment', async () => {
  let probes = 0;
  const handle = { commands: { run: async () => { probes++; throw new Error('probe failed'); } } } as unknown as SandboxHandle;
  const provider = {
    getInfo: async () => ({ state: 'running' }),
    connect: async () => { assert.fail('health verification must not resume a box'); },
    connectForSetup: async () => handle,
  } as unknown as SandboxProvider;
  const runtime = new ContainerCodexRuntime({ provider, sandboxes: {} as ProjectSandboxes, apiKey: '',
    paths: { root: '/workspace', runtime: '/runtime', codexHome: '/codex', node: '/node' },
    prepareRemote: async () => { assert.fail('health verification must not initialize or distribute configuration'); },
  });
  await assert.rejects(runtime.verifySandbox({ id: 'box-one', template: 'image', status: 'starting', workingDirectory: '/workspace' }, 50), /probe failed/);
  assert.equal(probes, 1);
});
