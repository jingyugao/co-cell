import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Socket } from 'node:net';
import { SandboxLifecycle, type SandboxHandle } from '@co-cell/sandbox';
import type { CellboxArchive, CellboxSandboxProvider } from '../../packages/sandbox/src/providers/cellbox/index.js';
import { CodexAppServerClient } from '../../packages/agentcore/src/index.mjs';
import type { ConnectionStore } from '../connections/store.js';
import type { SecretService } from '../secrets/service.js';
import type { RemoteArchiveRef } from '../../protocol/remote-archive-types.js';
import { CELLBOX_PRODUCT_PATHS, CellboxRuntimeIntegration } from './cellbox-runtime.js';

const target = { id: 'project-1', projectId: 'project-1', settings: { workingDirectory: '/home/agent/workspace/project-1' },
  updatedAt: new Date().toISOString(), sandbox: { id: 'box-1', template: 'k8s', status: 'ready' as const,
    workingDirectory: '/home/agent/workspace/project-1' } };
const result = { stdout: '', stderr: '', exitCode: 0 };

test('mounted startup does no remote config transfer or default-directory preparation; old boxes still work', async () => {
  const { handle, commands, files } = fakeHandle();
  let mounted = true;
  const { provider } = fakeProvider();
  provider.client.getBox = async () => ({ phase: 'running', generation: 1,
    capabilities: { sharedDirectory: mounted } }) as Awaited<ReturnType<typeof provider.client.getBox>>;
  const runtime = new CellboxRuntimeIntegration({ provider, profileId: 'k8s', appServerArgs: [], env: {}, sharedDirectory: true });
  const rootTarget = { ...target, settings: { workingDirectory: '/home/agent/workspace' } };
  await runtime.prepare(handle, rootTarget, AbortSignal.timeout(5_000));
  assert.equal(runtime.usesSharedDirectory('box-1'), true);
  assert.equal(commands.length, 0);
  assert.equal(files.size, 0);
  await runtime.prepare(handle, target, AbortSignal.timeout(5_000));
  assert.equal(commands.length, 1);
  assert(commands[0].command.includes('Unsafe project directory'));
  mounted = false;
  await runtime.prepare(handle, rootTarget, AbortSignal.timeout(5_000));
  assert.equal(runtime.usesSharedDirectory('box-1'), false);
  assert(commands.some(call => call.command.includes('Startup config was not consumed')));
  await runtime.close();
});

function fakeHandle() {
  const commands: Array<{ command: string; options: Record<string, unknown> }> = [];
  const files = new Map<string, { bytes: Buffer; mode?: number }>();
  let probeReady = false;
  const handle = {
    sandboxId: 'box-1', getHost: () => '127.0.0.1', setTimeout: async () => {},
    commands: { run: async (command: string, options: Record<string, unknown> = {}) => {
      commands.push({ command, options });
      if (command.includes('.connect(4500,') && !command.includes('Startup config was not consumed')) {
        if (!probeReady) throw Object.assign(new Error('not running'), { exitCode: 1 });
      }
      if (command.includes('chmod 600 -- ') && command.includes(' && mv -- ')) {
        const temp = [...files.keys()].find(path => path.includes('/.config-'));
        assert(temp, 'startup config was written before chmod and rename');
        files.set(`${CELLBOX_PRODUCT_PATHS.startup}/config.json`, { bytes: files.get(temp)!.bytes, mode: 0o600 });
        files.delete(temp);
      }
      if (command.includes('Startup config was not consumed')) {
        assert(files.has(`${CELLBOX_PRODUCT_PATHS.startup}/config.json`));
        files.delete(`${CELLBOX_PRODUCT_PATHS.startup}/config.json`); // Simulated workload consumption.
        probeReady = true;
      }
      return result;
    } },
    files: {
      write: async (path: string, value: Uint8Array | ArrayBuffer | string, options: Record<string, unknown> = {}) => {
        assert.equal(options.user, 'agent');
        files.set(path, { bytes: Buffer.from(value instanceof ArrayBuffer ? new Uint8Array(value) : value) });
      },
      remove: async (path: string) => { files.delete(path); },
      read: async (path: string) => files.get(path)?.bytes.toString() ?? '',
      exists: async (path: string) => files.has(path),
      rename: async (from: string, to: string) => { files.set(to, files.get(from)!); files.delete(from); },
    },
  } as unknown as SandboxHandle;
  return { handle, commands, files };
}

function fakeProvider(overrides: Record<string, unknown> = {}) {
  const events: string[] = [];
  const credentialWrites: Array<{ boxId: string; slot: string; bytes: Buffer }> = [];
  const archiveBytes = Buffer.from('cellbox archive bytes');
  const archive: CellboxArchive = {
    id: 'archive-1', sourceBoxId: 'box-1', profileId: 'k8s', imageId: 'image@sha256:abc',
    agent: { uid: 11000, gid: 11000 }, sha256: createHash('sha256').update(archiveBytes).digest('hex'),
    size: archiveBytes.length, consistency: 'workspace-best-effort', createdAt: new Date().toISOString(),
  };
  let leaseRenews = 0, leaseReleases = 0;
  const access = { url: 'http://cellbox.test/v1/boxes/box-1/services/4500/', headers: {} };
  const provider = {
    client: {
      writeCredential: async (boxId: string, slot: string, bytes: Uint8Array) => { credentialWrites.push({ boxId, slot, bytes: Buffer.from(bytes) }); },
      restoreBox: async () => { events.push('restore-submit'); return { id: 'op-restore', targetId: 'box-1',
        kind: 'restore', status: 'running', version: 1, createdAt: new Date().toISOString() }; },
      getBox: async () => { events.push('inspect-staged'); return { phase: 'staged', capabilities: { protectedTools: true }, image: 'image@sha256:abc', imageId: 'image@sha256:abc' }; },
      getArchive: async () => archive,
      downloadArchive: async (_id: string, maxBytes: number) => { assert.equal(maxBytes, 256 * 1024 * 1024); return archiveBytes; },
      deleteArchive: async () => {},
    },
    waitForOperation: async () => { events.push('wait-restore'); },
    connectForSetup: async () => { events.push('connect-staged'); return overrides.handle; },
    activateBox: async () => { events.push('activate'); },
    captureArchive: async () => ({ result: { archiveId: archive.id } }),
    getServiceAccess: async () => access,
    createLease: async () => ({ id: 'lease-1' }),
    renewLease: async () => { leaseRenews++; },
    releaseLease: async () => { leaseReleases++; },
    ...overrides,
  } as unknown as CellboxSandboxProvider;
  return { provider, events, credentialWrites, archive, archiveBytes,
    counts: () => ({ leaseRenews, leaseReleases }) };
}

test('setup stays in the agent workspace, writes 0600 startup config, and installs mapped slots only', async () => {
  const { handle, commands, files } = fakeHandle();
  const { provider, credentialWrites } = fakeProvider();
  const connections = { readRuntimeBundle: async () => ({ glabConfig: 'glab-secret', gitConfig: 'git-secret',
    gitCredentials: 'git-credentials-secret', mysqlLogin: Buffer.from('mysql-secret').toString('base64'),
    cliFiles: { 'cli/tool': Buffer.from('cli-secret').toString('base64') } }) } as unknown as ConnectionStore;
  const runtime = new CellboxRuntimeIntegration({ provider, profileId: 'k8s', appServerArgs: ['--feature', 'x'],
    env: { COCELL_TEST_MODE: 'yes' }, connections,
    credentialSlots: { 'glab/config.yml': 'glab_slot', 'cli/tool': 'cli_slot', 'missing': 'unused_slot' } });
  await runtime.reconcile(target);
  await runtime.prepare(handle, target, AbortSignal.timeout(5_000));
  assert(commands.every(call => call.options.user === 'agent'));
  assert(commands.every(call => !/\b(?:docker|kubectl|mount)\b/.test(call.command)));
  assert(commands.some(call => call.command.includes('fs.mkdirSync') && call.command.includes(CELLBOX_PRODUCT_PATHS.codexHome)));
  assert(commands.some(call => call.command.includes('chmod 600 -- ') && call.command.includes(' && mv -- ')));
  assert(commands.some(call => call.command.includes('Startup config was not consumed')));
  assert.equal(files.has(`${CELLBOX_PRODUCT_PATHS.startup}/config.json`), false);
  assert.deepEqual(credentialWrites.map(write => [write.boxId, write.slot, write.bytes.toString()]), [
    ['box-1', 'glab_slot', 'glab-secret'], ['box-1', 'cli_slot', 'cli-secret'], ['box-1', 'unused_slot', '\n'],
  ]);
  await runtime.close();
});

test('clearing a connection replaces its remote credential without submitting an empty payload', async () => {
  const { handle } = fakeHandle();
  const { provider, credentialWrites } = fakeProvider();
  let glabConfig = 'previous-secret';
  const connections = { readRuntimeBundle: async () => ({ glabConfig }) } as unknown as ConnectionStore;
  const runtime = new CellboxRuntimeIntegration({ provider, profileId: 'k8s', appServerArgs: [], env: {},
    connections, credentialSlots: { 'glab/config.yml': 'glab_slot' } });
  try {
    await runtime.reconcile(target);
    glabConfig = '';
    await runtime.reconcile(target);
    await runtime.reconcile(target);
    assert.deepEqual(credentialWrites.map(write => write.bytes.toString()), ['previous-secret', '\n']);
  } finally { await runtime.close(); }
});

test('imported images skip credentials, use native archives and restore with the pinned image', async () => {
  const previousEndpoint = process.env.OSS_ENDPOINT;
  process.env.OSS_ENDPOINT = 'http://127.0.0.1:9002';
  const { handle } = fakeHandle();
  const fake = fakeProvider();
  fake.provider.client.getBox = async () => ({ phase: 'staged', generation: 1, image: 'image@sha256:abc',
    capabilities: { protectedTools: false } }) as never;
  fake.provider.captureArchive = async (_id, key) => {
    assert.equal(key, 'capture-imported');
    return { result: { archiveId: fake.archive.id } } as never;
  };
  const imageSelection = { imageId: 'python', imageName: 'Python', category: '开发', versionId: 'v1', version: 'v1',
    importedImageId: 'imported-python-v1', image: 'image@sha256:abc' };
  fake.archive.portable = true;
  fake.provider.client.restoreBox = async input => {
    assert.equal(input.importedImageId, imageSelection.importedImageId);
    assert.equal(input.acceptImageChange, true);
    return { id: 'restore', targetId: 'box-1' } as never;
  };
  const runtime = new CellboxRuntimeIntegration({ provider: fake.provider, profileId: 'k8s', appServerArgs: [], env: {},
    connections: { readRuntimeBundle: async () => { assert.fail('must not read operator credentials for an imported image'); } } as unknown as ConnectionStore,
    credentialSlots: { __ossAccessKey: 'oss_access' } });
  try {
    await runtime.prepare(handle, { ...target, imageSelection }, AbortSignal.timeout(5000));
    assert.equal(fake.credentialWrites.length, 0);
    const archive = await runtime.remoteArchives.capture({ ...target, imageSelection }, 'capture-imported');
    assert.equal(archive.id, fake.archive.id);
    assert.equal(archive.portable, true);
    const candidate = await runtime.remoteArchives.restore({ ...target, imageSelection }, { ...archive, threadIds: [] }, 'restore-imported', async () => {});
    assert.equal(candidate.image?.reference, imageSelection.image);
  } finally {
    await runtime.close();
    if (previousEndpoint === undefined) delete process.env.OSS_ENDPOINT; else process.env.OSS_ENDPOINT = previousEndpoint;
  }
});

test('startup reconciliation leaves paused sandboxes asleep and archive workflows expose restore/activate hooks', async () => {
  const fake = fakeProvider({ handle: fakeHandle().handle });
  const hooks: string[] = [];
  const lifecycle = new SandboxLifecycle([{ name: 'observer',
    pre: async context => { hooks.push(`pre:${context.action}`); },
    post: async context => { hooks.push(`post:${context.action}`); },
  }]);
  const runtime = new CellboxRuntimeIntegration({ provider: fake.provider, profileId: 'k8s', appServerArgs: [], env: {}, lifecycle });
  const originalBox = fake.provider.client.getBox;
  fake.provider.client.getBox = async () => ({ phase: 'suspended' }) as never;
  try {
    await runtime.reconcile(target);
    assert.deepEqual(hooks, []);
    assert.equal(fake.credentialWrites.length, 0);
    fake.provider.client.getBox = originalBox;
    const ref: RemoteArchiveRef = { id: fake.archive.id, createdAt: fake.archive.createdAt,
      sizeBytes: fake.archive.size, sha256: fake.archive.sha256, imageId: fake.archive.imageId,
      sourceSandboxId: fake.archive.sourceBoxId, threadIds: [] };
    const candidate = await runtime.remoteArchives.restore(target, ref, 'key', async () => {});
    await runtime.remoteArchives.activate(candidate);
    assert.deepEqual(hooks, ['pre:restore', 'post:restore', 'pre:activate', 'post:activate']);
  } finally { await runtime.close(); }
});

test('only usage leases renew; anonymous App Server access needs no timer', async t => {
  const callbacks: Array<() => void> = [];
  t.mock.method(globalThis, 'setInterval', ((callback: () => void) => {
    callbacks.push(callback);
    return { unref() {} } as NodeJS.Timeout;
  }) as typeof setInterval);
  t.mock.method(globalThis, 'clearInterval', (() => {}) as typeof clearInterval);
  const { provider, counts } = fakeProvider();
  const runtime = new CellboxRuntimeIntegration({ provider, profileId: 'k8s', appServerArgs: [], env: {} });
  const endpoint = await runtime.appServer('box-1');
  assert.equal(endpoint.url, 'ws://cellbox.test/v1/boxes/box-1/services/4500/');
  assert.deepEqual(endpoint.headers, {});
  const releaseLease = await runtime.acquireUsage('box-1');
  assert.equal(callbacks.length, 1);
  callbacks.forEach(callback => callback());
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(counts(), { leaseRenews: 1, leaseReleases: 0 });
  await releaseLease();
  await runtime.close();
  assert.deepEqual(counts(), { leaseRenews: 1, leaseReleases: 1 });
});

test('mounted default-workspace initialization skips an empty remote lease; execution and custom setup retain it', async () => {
  let leases = 0;
  const { provider } = fakeProvider({
    client: { getBox: async () => ({ capabilities: { sharedDirectory: true } }) },
    createLease: async () => { leases++; return { id: 'lease-1' }; },
  });
  const runtime = new CellboxRuntimeIntegration({ provider, profileId: 'k8s', appServerArgs: [], env: {}, sharedDirectory: true });
  await (await runtime.acquireUsage('box-1', '/home/agent/workspace'))();
  assert.equal(leases, 0);
  await (await runtime.acquireUsage('box-1', '/home/agent/workspace/project'))();
  await (await runtime.acquireUsage('box-1'))();
  assert.equal(leases, 2);
  await runtime.close();
});

test('OSS backup skips permission changes for root debug and supports existing non-root boxes', async () => {
  const previous = process.env.OSS_ENDPOINT;
  process.env.OSS_ENDPOINT = 'http://127.0.0.1:9002';
  const { handle, commands } = fakeHandle();
  const fake = fakeProvider({ handle });
  let rootDebug = true;
  fake.provider.client.getBox = async () => ({ phase: 'running', generation: 1, capabilities: { protectedTools: true, rootDebug } }) as Awaited<ReturnType<typeof fake.provider.client.getBox>>;
  fake.provider.currentImageIdentity = async () => ({ reference: 'prepared:test', id: 'sha256:prepared', repoDigests: [] });
  fake.provider.client.runTool = async (_boxId, tool, args) => {
    assert.equal(tool, 'cocell_archive_backup');
    assert.deepEqual(args, ['project-1/capture-key.tar.gz']);
    assert.equal(commands.some(call => call.command === 'chmod -R g+rX -- /home/agent/workspace'), !rootDebug);
    return { ...result, stdout: JSON.stringify({ storageType: 'oss', objectKey: 'legacy-archives/project-1/capture-key.tar.gz',
      createdAt: '2026-09-27T00:00:00.000Z', sizeBytes: 10, sha256: 'a'.repeat(64) }) };
  };
  const runtime = new CellboxRuntimeIntegration({ provider: fake.provider, profileId: 'k8s', appServerArgs: [], env: {} });
  try {
    const archive = await runtime.remoteArchives.capture(target, 'capture-key');
    assert.equal(archive.storageType, 'oss');
    assert.equal(archive.sourceSandboxId, target.sandbox.id);
    assert.equal(commands.length, 0);
    rootDebug = false;
    await runtime.remoteArchives.capture(target, 'capture-key');
  } finally {
    await runtime.close();
    if (previous === undefined) delete process.env.OSS_ENDPOINT; else process.env.OSS_ENDPOINT = previous;
  }
});

test('restore records candidate before waiting, activates after setup, and verifies bounded archive bytes', async () => {
  const { handle, commands } = fakeHandle();
  const fake = fakeProvider({ handle });
  const runtime = new CellboxRuntimeIntegration({ provider: fake.provider, profileId: 'k8s', appServerArgs: [], env: {} });
  const ref: RemoteArchiveRef = { id: fake.archive.id, createdAt: fake.archive.createdAt,
    sizeBytes: fake.archive.size, sha256: fake.archive.sha256, imageId: fake.archive.imageId,
    sourceSandboxId: fake.archive.sourceBoxId, threadIds: [] };
  const candidate = await runtime.remoteArchives.restore(target, ref, 'restore-key', async value => {
    assert.equal(value.id, 'box-1'); fake.events.push('record-candidate');
  });
  assert.deepEqual(fake.events.slice(0, 4), ['restore-submit', 'record-candidate', 'wait-restore', 'inspect-staged']);
  assert.equal(candidate.status, 'starting');
  assert.equal(candidate.image?.id, 'image@sha256:abc');
  await runtime.remoteArchives.activate(candidate);
  assert(fake.events.indexOf('connect-staged') < fake.events.indexOf('activate'));
  assert(commands.some(call => call.command.includes('Startup config was not consumed')));
  const directory = await mkdtemp(join(tmpdir(), 'cellbox-runtime-test-'));
  try {
    const destination = join(directory, 'archive.tar.gz');
    await runtime.remoteArchives.download!(ref, destination);
    assert.deepEqual(await readFile(destination), fake.archiveBytes);
    assert.equal((await stat(destination)).mode & 0o777, 0o600);
    await assert.rejects(runtime.remoteArchives.download!({ ...ref, sizeBytes: ref.sizeBytes + 1 }, join(directory, 'bad-size')),
      /integrity check failed/);
    await assert.rejects(runtime.remoteArchives.download!({ ...ref, sizeBytes: 256 * 1024 * 1024 + 1 }, join(directory, 'too-large')),
      /256 MiB/);
  } finally { await rm(directory, { recursive: true, force: true }); await runtime.close(); }
});

test('mounted OSS restore holds startup until extraction completes and provisions tools first', async () => {
  const previous = { endpoint: process.env.OSS_ENDPOINT, access: process.env.OSS_ACCESS_KEY, secret: process.env.OSS_SECRET_KEY };
  process.env.OSS_ENDPOINT = 'http://127.0.0.1:9002';
  process.env.OSS_ACCESS_KEY = 'test-access';
  process.env.OSS_SECRET_KEY = 'test-secret';
  const { handle, commands } = fakeHandle();
  const fake = fakeProvider({ handle });
  fake.provider.client.getBox = async () => ({ phase: 'staged', generation: 1,
    capabilities: { protectedTools: true, sharedDirectory: true } }) as Awaited<ReturnType<typeof fake.provider.client.getBox>>;
  fake.provider.create = async (_profile, options) => {
    assert.equal(options?.metadata?.cellboxStaged, 'true');
    fake.events.push('create-staged');
    return handle;
  };
  fake.provider.currentImageIdentity = async () => ({ reference: 'prepared:test', id: 'sha256:prepared', repoDigests: [] });
  fake.provider.client.runTool = async (_boxId, tool) => {
    assert.equal(tool, 'cocell_archive_restore');
    assert.deepEqual(fake.credentialWrites.map(write => [write.slot, write.bytes.toString()]), [
      ['oss_access', 'test-access'], ['oss_secret', 'test-secret'],
    ]);
    assert(!fake.events.includes('activate'));
    fake.events.push('extract');
    return result;
  };
  const runtime = new CellboxRuntimeIntegration({ provider: fake.provider, profileId: 'k8s', appServerArgs: [], env: {},
    sharedDirectory: true,
    connections: { readRuntimeBundle: async () => null } as unknown as ConnectionStore,
    credentialSlots: { __ossAccessKey: 'oss_access', __ossSecretKey: 'oss_secret' } });
  try {
    const ref: RemoteArchiveRef = { id: 'oss:archive', createdAt: new Date().toISOString(), sizeBytes: 1,
      sha256: 'a'.repeat(64), imageId: 'sha256:prepared', sourceSandboxId: 'legacy', threadIds: [],
      storageType: 'oss', metadata: { objectKey: 'legacy-archives/archive.tar.gz' } };
    const candidate = await runtime.remoteArchives.restore({ ...target,
      settings: { workingDirectory: '/home/agent/workspace' } }, ref, 'restore-key', async value => {
      assert.equal(value.workingDirectory, '/home/agent/workspace');
    });
    assert.equal(candidate.workingDirectory, '/home/agent/workspace');
    await runtime.remoteArchives.activate(candidate);
    assert(fake.events.indexOf('extract') < fake.events.indexOf('activate'));
    assert.equal(commands.length, 0);
  } finally {
    await runtime.close();
    for (const [key, value] of Object.entries({ OSS_ENDPOINT: previous.endpoint,
      OSS_ACCESS_KEY: previous.access, OSS_SECRET_KEY: previous.secret })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

/** A tiny RFC6455 server verifies the actual Node 22 WebSocket handshake headers. */
test('CodexAppServerClient sends Authorization on the WebSocket upgrade', async () => {
  const server = createServer();
  const sockets = new Set<Socket>();
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  let authorization: string | undefined;
  server.on('upgrade', (request, socket, head) => {
    authorization = request.headers.authorization;
    const key = request.headers['sec-websocket-key'];
    assert.equal(typeof key, 'string');
    const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    let pending = Buffer.from(head);
    const respond = (message: Record<string, unknown>) => {
      const payload = Buffer.from(JSON.stringify(message));
      assert(payload.length < 126);
      socket.write(Buffer.concat([Buffer.from([0x81, payload.length]), payload]));
    };
    const consume = (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 2) {
        const wide = pending[1] & 0x7f;
        const header = wide === 126 ? 4 : wide === 127 ? 10 : 2;
        if (pending.length < header + 4) return;
        const length = wide === 126 ? pending.readUInt16BE(2) : wide;
        if (wide === 127 || pending.length < header + 4 + length) return;
        const mask = pending.subarray(header, header + 4);
        const payload = Buffer.from(pending.subarray(header + 4, header + 4 + length));
        pending = pending.subarray(header + 4 + length);
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
        if ((chunk[0] & 0x0f) === 0x8) return;
        const message = JSON.parse(payload.toString()) as { id?: number; method?: string };
        if (message.id) respond({ id: message.id, result: message.method === 'thread/list' ? { data: [] } : {} });
      }
    };
    socket.on('data', consume);
    if (pending.length) consume(Buffer.alloc(0));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address(); assert(address && typeof address !== 'string');
  let client: CodexAppServerClient | undefined;
  let startupTimer: NodeJS.Timeout | undefined;
  try {
    client = await Promise.race([
      CodexAppServerClient.spawn({ url: `ws://127.0.0.1:${address.port}/`,
        headers: { Authorization: 'Bearer wire-secret' }, requestTimeoutMs: 2_000 }),
      new Promise<never>((_, reject) => { startupTimer = setTimeout(() => reject(new Error('WebSocket startup timed out')), 3_000); }),
    ]);
    await client.request('thread/list', { limit: 1 });
    assert.equal(authorization, 'Bearer wire-secret');
  } finally {
    clearTimeout(startupTimer);
    await client?.close();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('environment preparation and readiness retries never distribute credentials', async () => {
  const { handle } = fakeHandle();
  const { provider, credentialWrites } = fakeProvider();
  const secrets = { registerRuntime: async () => { assert.fail('prepare must not register tool runtimes'); } } as unknown as SecretService;
  const runtime = new CellboxRuntimeIntegration({ provider, profileId: 'k8s', appServerArgs: [], env: {},
    secrets, toolBrokerUrl: 'http://broker.example.test' });
  const originalRun = handle.commands.run.bind(handle.commands);
  let fail = true;
  handle.commands.run = (async (command: string, runOptions?: { user?: string; signal?: AbortSignal; timeoutMs?: number }) => {
    if (fail && command.includes('.connect(4500,')) { fail = false; throw new Error('preparation timed out'); }
    return originalRun(command, runOptions);
  }) as typeof handle.commands.run;
  try {
    await assert.rejects(runtime.prepare(handle, target, AbortSignal.timeout(5_000)), /preparation timed out/);
    await runtime.prepare(handle, target, AbortSignal.timeout(5_000));
    await runtime.prepare(handle, target, AbortSignal.timeout(5_000));
    assert.equal(credentialWrites.length, 0);
  } finally { await runtime.close(); }
});
