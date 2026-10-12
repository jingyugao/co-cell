import { once } from 'node:events';
import assert from 'node:assert/strict';
import test from 'node:test';
import type { SandboxHandle, SandboxProvider } from '@co-cell/sandbox';
import { ContainerCodexRuntime } from './container-runtime.js';
import type { ProjectSandboxes } from '../sandboxes/project-sandboxes.js';
import type { Session } from '../../protocol/types.js';
import { AppServerReader } from './app-server-reader.js';
import { CodexAppServerClient } from '../../packages/agentcore/src/index.mjs';

test('turns reuse the read transport and keep native success when activity persistence fails', async t => {
  let connects = 0, releases = 0;
  t.mock.method(CodexAppServerClient.prototype, 'connect', async () => { connects++; });
  t.mock.method(CodexAppServerClient.prototype, 'request', async () => ({ thread: { id: 'thread-one' } }));
  t.mock.method(CodexAppServerClient.prototype, 'turnStart', async function (this: CodexAppServerClient) {
    this.emit('notification', { method: 'turn/completed', params: { threadId: 'thread-one', turn: { id: 'native-one', status: 'completed' } } });
    return { turn: { id: 'native-one' } };
  });
  const reader = new AppServerReader(async () => ({ url: 'ws://test' }), error => assert.fail(String(error)));
  const runtime = new ContainerCodexRuntime({ provider: {} as SandboxProvider,
    sandboxes: { close: async () => {} } as unknown as ProjectSandboxes, apiKey: '', appServerReader: reader,
    appServer: async () => ({ url: 'ws://test' }),
    paths: { root: '/workspace', runtime: '/runtime', codexHome: '/codex', node: '/node' }, prepareRemote: async () => false });
  // Keep real execution/stream/cleanup behavior; isolate provider setup.
  t.mock.method(runtime as any, 'acquire', async () => ({ metadata: { id: 'box-one' },
    lease: { release: async () => { releases++; throw new Error('activity write failed'); } } }));
  t.mock.method(runtime as any, 'prepareEnvironment', async () => {});
  const session = { threadId: 'thread-one', settings: { workingDirectory: '/workspace' } } as Session;
  try {
    await reader.read('box-one', async () => {});
    for (let index = 0; index < 2; index++) {
      const events = [];
      for await (const event of runtime.run(session, { id: `turn-${index}`, prompt: 'hello', images: [], status: 'running', items: [], startedAt: new Date().toISOString() },
        new AbortController().signal, async () => {})) events.push(event);
      assert.equal(events.at(-1)?.type, 'turn.completed');
    }
    assert.equal(connects, 1);
    assert.equal(releases, 2);
  } finally { await runtime.close(); }
});

test('history maintenance keeps BUSY classification through runtime error sanitization', async () => {
  const reader = new AppServerReader(async () => { throw new Error('must not connect during maintenance'); }, () => {});
  const runtime = new ContainerCodexRuntime({ provider: {} as SandboxProvider,
    sandboxes: { close: async () => {} } as unknown as ProjectSandboxes, apiKey: 'test-secret', appServerReader: reader,
    paths: { root: '/workspace', runtime: '/runtime', codexHome: '/codex', node: '/node' }, prepareRemote: async () => false });
  const release = await reader.extension.pre!({ action: 'checkpoint', resourceKey: 'p', sandboxId: 'box-one' });
  const session = { threadId: 'thread-one', sandbox: { id: 'box-one' } } as Session;
  try {
    for (const request of [() => runtime.history(session), () => runtime.subagents(session)]) {
      await assert.rejects(request(), error => error instanceof Error && 'code' in error && error.code === 'BUSY');
    }
  } finally { release?.(); await runtime.close(); }
});

test('interrupt sends a remote native turn interruption without recovering the turn', async () => {
  let address: unknown;
  let rpc: unknown;
  const reader = {
    read: async (sandboxId: string, action: (client: { turnInterrupt(params: unknown): Promise<void> }) => Promise<void>) => {
      address = sandboxId;
      return action({ turnInterrupt: async params => { rpc = params; } });
    },
    close: async () => {},
  } as unknown as AppServerReader;
  const runtime = new ContainerCodexRuntime({ provider: {} as SandboxProvider,
    sandboxes: { close: async () => {} } as unknown as ProjectSandboxes, apiKey: 'test-secret', appServerReader: reader,
    paths: { root: '/workspace', runtime: '/runtime', codexHome: '/codex', node: '/node' }, prepareRemote: async () => false });

  await runtime.interrupt({ threadId: 'thread-one', sandbox: { id: 'box-one' } } as Session,
    { id: 'turn-one', nativeTurnId: 'native-turn-one' } as Session['turns'][number]);

  assert.equal(address, 'box-one');
  assert.deepEqual(rpc, { threadId: 'thread-one', turnId: 'native-turn-one' });
  await runtime.close();
});

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

test('native preview access holds its sandbox lease and releases once on close or failed acquisition', async t => {
  let releases = 0;
  let fail = false;
  const runtime = new ContainerCodexRuntime({ provider: {} as SandboxProvider,
    sandboxes: { close: async () => {} } as unknown as ProjectSandboxes, apiKey: '',
    paths: { root: '/workspace', runtime: '/runtime', codexHome: '/codex', node: '/node' }, prepareRemote: async () => false,
    serviceAccess: async (id, port) => {
      assert.equal(id, 'preview-box'); assert.equal(port, 8080);
      if (fail) throw new Error('service access failed');
      return { url: 'http://localhost:8080/internal/', headers: { 'X-Cellbox-Client-ID': 'internal' } };
    },
  });
  t.mock.method(runtime as any, 'acquire', async () => ({ sandbox: { sandboxId: 'preview-box' },
    metadata: { id: 'preview-box' }, lease: { release: async () => { releases++; } } }));
  const target = { id: 'project', updatedAt: new Date().toISOString(), settings: { workingDirectory: '/workspace' } };
  const access = await runtime.openServiceAccess(target, 8080, new AbortController().signal);
  assert.equal(releases, 0);
  assert.equal(access.url, 'http://localhost:8080/internal/');
  await access.release(); await access.release();
  assert.equal(releases, 1);
  fail = true;
  await assert.rejects(runtime.openServiceAccess(target, 8080, new AbortController().signal), /service access failed/);
  assert.equal(releases, 2);
  await runtime.close();
});

test('legacy service proxy preserves compression headers alongside raw compressed bytes', async t => {
  const { createServer } = await import('node:http');
  const { gzipSync } = await import('node:zlib');
  const bytes = gzipSync('legacy preview content');
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip', 'content-length': String(bytes.length) });
    res.end(bytes);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as import('node:net').AddressInfo).port;
  let releases = 0;
  const runtime = new ContainerCodexRuntime({ provider: {} as SandboxProvider,
    sandboxes: { close: async () => {} } as unknown as ProjectSandboxes, apiKey: '',
    paths: { root: '/workspace', runtime: '/runtime', codexHome: '/codex', node: '/node' }, prepareRemote: async () => false,
    serviceAccess: async () => ({ url: `http://127.0.0.1:${port}/`, headers: {} }),
  });
  t.mock.method(runtime as any, 'acquire', async () => ({ sandbox: { sandboxId: 'preview-box' },
    metadata: { id: 'preview-box' }, lease: { release: async () => { releases++; } } }));
  try {
    const response = await runtime.service({ id: 'project', updatedAt: new Date().toISOString(), settings: { workingDirectory: '/workspace' } },
      port, '/gzip', new Request('https://cocell.example.test/gzip'));
    assert.equal(response.headers.get('content-encoding'), 'gzip');
    assert.equal(response.headers.get('content-length'), String(bytes.length));
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
    assert.equal(releases, 1);
  } finally { await runtime.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
