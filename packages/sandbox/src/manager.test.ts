import assert from 'node:assert/strict';
import test from 'node:test';
import type { SandboxHandle, SandboxInfo } from './index.js';
import {
  SandboxManager,
  SandboxLifecycle,
  SandboxBusyError,
  SandboxPersistenceError,
  type SandboxProvider,
  type SandboxRecord,
} from './index.js';

const wait = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));

function fixture(initial: 'running' | 'paused' = 'paused', connectDelay = 0) {
  let state = initial;
  let endAt = new Date(Date.now() + 60_000);
  const counts = { create: 0, connect: 0, inspect: 0, renew: 0, pause: 0, kill: 0 };
  const handle = { sandboxId: 'sandbox-1' } as unknown as SandboxHandle;
  const info = (): SandboxInfo => ({
    sandboxId: 'sandbox-1', metadata: {},
    startedAt: new Date(0), endAt, state,
  });
  const provider: SandboxProvider = {
    async create() { counts.create += 1; state = 'running'; return handle; },
    async connect() { counts.connect += 1; if (connectDelay) await wait(connectDelay); state = 'running'; return handle; },
    async getInfo() { counts.inspect += 1; return info(); },
    async renew(_id, timeoutMs) { counts.renew += 1; endAt = new Date(Date.now() + timeoutMs); return info(); },
    async pause() { counts.pause += 1; state = 'paused'; return true; },
    async kill() { counts.kill += 1; return true; },
  };
  return { provider, counts, handle, setState: (value: 'running' | 'paused') => { state = value; } };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition timed out');
    await wait(2);
  }
}

async function waitForConnectWaiters(manager: SandboxManager, resourceKey: string, count: number): Promise<void> {
  const internals = manager as unknown as { entries: Map<string, { connecting?: { waiters: number } }> };
  await waitUntil(() => internals.entries.get(resourceKey)?.connecting?.waiters === count);
}

const record = (status: SandboxRecord['status'] = 'paused'): SandboxRecord => ({
  id: 'sandbox-1', template: 'template-1', status,
  lastActiveAt: new Date(0).toISOString(),
  ...(status === 'paused' ? { pausedAt: new Date(0).toISOString() } : {}),
});

test('lifecycle hooks surround transitions while acquire reuse and inspection stay read-only', async () => {
  const fake = fixture('running');
  const calls: string[] = [];
  const lifecycle = new SandboxLifecycle([{ name: 'test',
    pre: async context => { calls.push(`pre:${context.action}`); },
    post: async context => {
      calls.push(`post:${context.action}`);
      if (context.action === 'create') assert.equal(fake.counts.create, 1);
      if (context.action === 'pause') assert.equal(context.record?.status, 'paused');
      if (context.action === 'destroy') assert.equal(context.record?.status, 'deleted');
    },
  }]);
  const manager = new SandboxManager({ provider: fake.provider, lifecycle });
  try {
    const first = await manager.acquire('project:one', { usageId: 'one', create: { template: 'image' }, persist: async () => {} });
    await first.release();
    await manager.inspect('project:one');
    const second = await manager.acquire('project:one', { usageId: 'two' });
    await second.release();
    assert.deepEqual(calls, ['pre:create', 'post:create']);
    await manager.pause('project:one');
    const resumed = await manager.acquire('project:one', { usageId: 'three' });
    await resumed.release();
    await manager.destroy('project:one');
    assert.deepEqual(calls, ['pre:create', 'post:create', 'pre:pause', 'post:pause', 'pre:resume', 'post:resume', 'pre:destroy', 'post:destroy']);
  } finally { await manager.close(); }
});

test('a pre hook veto prevents remote creation and error hooks cannot mask the failure', async () => {
  const fake = fixture();
  let posts = 0, errors = 0;
  const manager = new SandboxManager({ provider: fake.provider, lifecycle: new SandboxLifecycle([{ name: 'policy',
    pre: async () => { throw new Error('veto'); },
    post: async () => { posts++; },
    error: async () => { errors++; throw new Error('notification failed'); },
  }]) });
  try {
    await assert.rejects(manager.acquire('project:one', { usageId: 'one', create: { template: 'image' }, persist: async () => {} }), /policy pre failed/);
    assert.equal(fake.counts.create, 0);
    assert.equal(manager.peek('project:one'), undefined);
    assert.equal(posts, 0);
    assert.equal(errors, 1);
  } finally { await manager.close(); }
});

test('a failed post hook retains the remote identity and gates readiness until reconnect succeeds', async () => {
  const fake = fixture();
  let fail = true;
  const saved: SandboxRecord[] = [];
  const manager = new SandboxManager({ provider: fake.provider, lifecycle: new SandboxLifecycle([{ name: 'config',
    post: async () => { if (fail) throw new Error('delivery failed'); },
  }]) });
  try {
    await assert.rejects(manager.acquire('project:one', { usageId: 'one', create: { template: 'image' },
      persist: async value => { saved.push(value); } }), /config post failed/);
    assert.equal(manager.peek('project:one')?.id, fake.handle.sandboxId);
    assert.equal(manager.peek('project:one')?.status, 'unavailable');
    assert.equal(saved[0].status, 'starting');
    assert.equal((await manager.inspect('project:one')).record.status, 'unavailable');
    fail = false;
    const lease = await manager.acquire('project:one', { usageId: 'two', create: { template: 'image' } });
    assert.equal(lease.record.status, 'ready');
    assert.equal(fake.counts.create, 1);
    assert.equal(fake.counts.connect, 1);
    await lease.release();
  } finally { await manager.close(); }
});

test('failed destroy post hooks preserve deleted state and can retry cleanup', async () => {
  const fake = fixture('running');
  let fail = true, completed = 0;
  const manager = new SandboxManager({ provider: fake.provider, extensions: [{ name: 'cleanup', post: async context => {
    if (context.action !== 'destroy') return;
    if (fail) throw new Error('cleanup failed');
    completed++;
  } }] });
  manager.track('resource', record('ready'), async () => {});
  try {
    await assert.rejects(manager.destroy('resource'), /cleanup post failed/);
    assert.equal(manager.peek('resource')?.status, 'deleted');
    fail = false;
    await manager.destroy('resource');
    assert.equal(completed, 1);
    assert.equal(manager.peek('resource')?.error, undefined);
  } finally { await manager.close(); }
});

test('an externally resumed generation runs connect hooks instead of reusing a stale handle', async () => {
  const fake = fixture('running');
  let generation = '1', posts = 0;
  const originalInfo = fake.provider.getInfo;
  fake.provider.getInfo = async id => ({ ...await originalInfo(id), metadata: { generation } });
  const manager = new SandboxManager({ provider: fake.provider, lifecycle: new SandboxLifecycle([{ name: 'config', post: async () => { posts++; } }]) });
  manager.track('resource', record('ready'), async () => {});
  try {
    const first = await manager.acquire('resource', { usageId: 'one' });
    await first.release();
    generation = '2';
    const second = await manager.acquire('resource', { usageId: 'two' });
    await second.release();
    assert.equal(posts, 2);
    assert.equal(fake.counts.connect, 2);
  } finally { await manager.close(); }
});

test('concurrent acquire connects once and registers both usages', async () => {
  const fake = fixture('paused', 20);
  const saved: SandboxRecord[] = [];
  const persist = async (value: SandboxRecord) => { saved.push(value); };
  const manager = new SandboxManager({ provider: fake.provider, policy: { scanIntervalMs: 60_000 } });
  manager.track('resource', record(), persist);
  const [first, second] = await Promise.all([
    manager.acquire('resource', { usageId: 'turn-1' }),
    manager.acquire('resource', { usageId: 'turn-2' }),
  ]);
  assert.equal(fake.counts.connect, 1);
  await assert.rejects(manager.pause('resource'), SandboxBusyError);
  await first.release();
  await second.release();
  await manager.pause('resource');
  assert.equal(fake.counts.pause, 1);
  assert.ok(saved.length > 0);
  await manager.close();
});

test('aborting one acquire waiter leaves the shared connection for remaining waiters', async () => {
  const fake = fixture('paused');
  let connectStarted!: (signal: AbortSignal | undefined) => void;
  const started = new Promise<AbortSignal | undefined>(resolve => { connectStarted = resolve; });
  let finishConnect!: () => void;
  const connectGate = new Promise<void>(resolve => { finishConnect = resolve; });
  const original = fake.provider.connect;
  fake.provider.connect = async (id, options) => {
    connectStarted(options.signal);
    await connectGate;
    options.signal?.throwIfAborted();
    return original(id, options);
  };
  const manager = new SandboxManager({ provider: fake.provider, policy: { scanIntervalMs: 60_000 } });
  manager.track('resource', record(), async () => {});
  const firstAbort = new AbortController();
  const secondAbort = new AbortController();
  const first = manager.acquire('resource', { usageId: 'one', signal: firstAbort.signal });
  const sharedSignal = await started;
  const second = manager.acquire('resource', { usageId: 'two', signal: secondAbort.signal });
  await waitForConnectWaiters(manager, 'resource', 2);
  firstAbort.abort(new Error('owner one disconnected'));
  await assert.rejects(first, /owner one disconnected/);
  assert.equal(sharedSignal?.aborted, false, 'one caller must not cancel another caller’s connection');
  finishConnect();
  const lease = await second;
  assert.equal(fake.counts.connect, 1);
  await lease.release();
  await manager.close();
});

test('aborting every acquire waiter cancels connect and skips lifecycle post hooks', async () => {
  const fake = fixture('paused');
  let connectStarted!: (signal: AbortSignal | undefined) => void;
  const started = new Promise<AbortSignal | undefined>(resolve => { connectStarted = resolve; });
  let finishConnect!: () => void;
  const connectGate = new Promise<void>(resolve => { finishConnect = resolve; });
  let postHooks = 0;
  fake.provider.connect = async (_id, options) => {
    connectStarted(options.signal);
    // Simulate a provider that returns despite cancellation; the manager and
    // lifecycle must still prevent post hooks and handle installation.
    await connectGate;
    return fake.handle;
  };
  const manager = new SandboxManager({ provider: fake.provider, policy: { scanIntervalMs: 60_000 },
    lifecycle: new SandboxLifecycle([{ name: 'resume-hooks', post: async () => { postHooks++; } }]) });
  manager.track('resource', record(), async () => {});
  const firstAbort = new AbortController();
  const secondAbort = new AbortController();
  const first = manager.acquire('resource', { usageId: 'one', signal: firstAbort.signal });
  const sharedSignal = await started;
  const second = manager.acquire('resource', { usageId: 'two', signal: secondAbort.signal });
  await waitForConnectWaiters(manager, 'resource', 2);
  firstAbort.abort(new Error('first owner disconnected'));
  await assert.rejects(first, /first owner disconnected/);
  assert.equal(sharedSignal?.aborted, false);
  secondAbort.abort(new Error('last owner disconnected'));
  await assert.rejects(second, /last owner disconnected/);
  await waitUntil(() => sharedSignal?.aborted === true);
  finishConnect();
  await manager.close();
  assert.equal(postHooks, 0, 'a canceled connection must not execute post hooks');
  assert.notEqual(manager.peek('resource')?.status, 'ready', 'canceled connect must not publish a ready binding');
});

test('inspect does not wait for an in-flight restore/connect', async () => {
  const fake = fixture('paused');
  let connectStarted!: () => void;
  const started = new Promise<void>(resolve => { connectStarted = resolve; });
  let finishConnect!: () => void;
  const connectGate = new Promise<void>(resolve => { finishConnect = resolve; });
  const connect = fake.provider.connect;
  fake.provider.connect = async (...args) => {
    connectStarted();
    await connectGate;
    return connect(...args);
  };
  const manager = new SandboxManager({ provider: fake.provider, policy: { scanIntervalMs: 60_000 } });
  manager.track('resource', record(), async () => {});
  const acquiring = manager.acquire('resource', { usageId: 'turn-1' });
  await started;
  try {
    const observation = await Promise.race([
      manager.inspect('resource'),
      wait(100).then(() => { throw new Error('inspect waited for connect'); }),
    ]);
    assert.equal(observation.info?.state, 'paused');
    assert.equal(observation.record.operation, 'resuming');
  } finally { finishConnect(); }
  const lease = await acquiring;
  assert.equal(manager.peek('resource')?.status, 'ready');
  await lease.release();
  await manager.close();
});

test('an inspect started before connect cannot overwrite the newer connection state', async () => {
  const fake = fixture('paused');
  let inspectStarted!: () => void;
  const started = new Promise<void>(resolve => { inspectStarted = resolve; });
  let finishInspect!: () => void;
  const inspectGate = new Promise<void>(resolve => { finishInspect = resolve; });
  const getInfo = fake.provider.getInfo;
  let first = true;
  fake.provider.getInfo = async id => {
    if (first) {
      first = false;
      const stale = await getInfo(id);
      inspectStarted();
      await inspectGate;
      return stale;
    }
    return getInfo(id);
  };
  const manager = new SandboxManager({ provider: fake.provider, policy: { scanIntervalMs: 60_000 } });
  manager.track('resource', record(), async () => {});
  const inspecting = manager.inspect('resource');
  await started;
  const lease = await manager.acquire('resource', { usageId: 'turn-1' });
  await lease.release();
  try {
    finishInspect();
    const stale = await inspecting;
    assert.equal(stale.info, undefined, 'a superseded response is not returned as a current observation');
    assert.equal(manager.peek('resource')?.status, 'ready');
  } finally {
    finishInspect();
    await manager.close();
  }
});

test('inspect rechecks the binding after snapshotting a deleted entry', async () => {
  const fake = fixture('running');
  const manager = new SandboxManager({ provider: fake.provider, policy: { scanIntervalMs: 60_000 } });
  manager.track('resource', { ...record('deleted'), id: 'sandbox-old' }, async () => {});
  let snapshotReady!: () => void;
  const ready = new Promise<void>(resolve => { snapshotReady = resolve; });
  let releaseSnapshot!: () => void;
  const gate = new Promise<void>(resolve => { releaseSnapshot = resolve; });
  const internal = manager as unknown as { lock: (key: string, action: () => Promise<unknown>) => Promise<unknown> };
  const originalLock = internal.lock.bind(manager);
  let pauseAfterSnapshot = true;
  internal.lock = async (key, action) => {
    const result = await originalLock(key, action);
    if (pauseAfterSnapshot) {
      pauseAfterSnapshot = false;
      snapshotReady();
      await gate;
    }
    return result;
  };

  const inspecting = manager.inspect('resource');
  await ready;
  await manager.replace('resource', 'sandbox-old', record('paused'));
  releaseSnapshot();
  const observation = await inspecting;
  assert.equal(observation.record.id, 'sandbox-1');
  assert.equal(observation.record.status, 'paused');
  await manager.close();
});

test('destructive operations fail promptly while an acquire is connecting', async () => {
  const fake = fixture('paused');
  let connectStarted!: () => void;
  const started = new Promise<void>(resolve => { connectStarted = resolve; });
  let finishConnect!: () => void;
  const connectGate = new Promise<void>(resolve => { finishConnect = resolve; });
  const connect = fake.provider.connect;
  fake.provider.connect = async (...args) => {
    connectStarted();
    await connectGate;
    return connect(...args);
  };
  const manager = new SandboxManager({ provider: fake.provider, policy: { scanIntervalMs: 60_000 } });
  manager.track('resource', record(), async () => {});
  const acquiring = manager.acquire('resource', { usageId: 'turn-1' });
  await started;
  try {
    const failFast = <T>(operation: Promise<T>) => Promise.race([
      assert.rejects(operation, SandboxBusyError),
      wait(100).then(() => { throw new Error('destructive operation waited for connect'); }),
    ]);
    await Promise.all([
      failFast(manager.pause('resource')),
      failFast(manager.destroy('resource')),
      failFast(manager.untrack('resource', 'sandbox-1')),
      failFast(manager.replace('resource', 'sandbox-1', { ...record(), id: 'sandbox-2' })),
    ]);
    assert.equal(fake.counts.pause, 0);
    assert.equal(fake.counts.kill, 0);
    assert.equal(manager.peek('resource')?.id, 'sandbox-1');
  } finally { finishConnect(); }
  const lease = await acquiring;
  await lease.release();
  await manager.close();
});

test('close drains an in-flight connect after leaving the resource lock', async () => {
  const fake = fixture('paused');
  let connectStarted!: () => void;
  const started = new Promise<void>(resolve => { connectStarted = resolve; });
  let finishConnect!: () => void;
  const connectGate = new Promise<void>(resolve => { finishConnect = resolve; });
  const connect = fake.provider.connect;
  fake.provider.connect = async (...args) => {
    connectStarted();
    await connectGate;
    return connect(...args);
  };
  const manager = new SandboxManager({ provider: fake.provider, policy: { scanIntervalMs: 60_000 } });
  manager.track('resource', record(), async () => {});
  const acquiring = manager.acquire('resource', { usageId: 'turn-1' });
  await started;
  let closed = false;
  const closing = manager.close().then(() => { closed = true; });
  await wait(5);
  assert.equal(closed, false);
  finishConnect();
  const lease = await acquiring;
  await closing;
  assert.equal(closed, true);
  await lease.release();
});

test('detached usage stays busy and the same usage can recover it', async () => {
  const fake = fixture('running');
  const persist = async () => {};
  const manager = new SandboxManager({ provider: fake.provider, policy: { scanIntervalMs: 60_000 } });
  manager.track('resource', record('ready'), persist);
  const original = await manager.acquire('resource', { usageId: 'turn-1' });
  await original.release({ detached: true });
  fake.setState('paused');
  await assert.rejects(manager.pause('resource'), SandboxBusyError);
  const recovered = await manager.acquire('resource', { usageId: 'turn-1' });
  assert.equal(fake.counts.connect, 2);
  await recovered.release();
  await manager.destroy('resource');
  assert.equal(fake.counts.kill, 1);
  await manager.close();
});

test('holdUsage is idempotent, blocks destruction, and is taken over by acquire', async () => {
  const fake = fixture('paused');
  const persist = async () => {};
  const manager = new SandboxManager({ provider: fake.provider, policy: { scanIntervalMs: 60_000 } });
  manager.track('resource', record(), persist);
  manager.holdUsage('resource', 'turn-1');
  manager.holdUsage('resource', 'turn-1');
  await assert.rejects(manager.destroy('resource'), SandboxBusyError);
  const lease = await manager.acquire('resource', { usageId: 'turn-1' });
  await lease.release();
  await manager.destroy('resource');
  await manager.close();
});

test('one of several detached usages can resume the shared sandbox', async () => {
  const fake = fixture('paused');
  const manager = new SandboxManager({ provider: fake.provider, policy: { scanIntervalMs: 60_000 } });
  manager.track('resource', record(), async () => {});
  manager.holdUsage('resource', 'turn-1');
  manager.holdUsage('resource', 'turn-2');
  const first = await manager.acquire('resource', { usageId: 'turn-1' });
  await first.release();
  await assert.rejects(manager.destroy('resource'), SandboxBusyError);
  const second = await manager.acquire('resource', { usageId: 'turn-2' });
  await second.release();
  await manager.destroy('resource');
  await manager.close();
});

test('inspect does not connect or renew a paused sandbox', async () => {
  const fake = fixture('paused');
  const manager = new SandboxManager({ provider: fake.provider, policy: { scanIntervalMs: 60_000 } });
  manager.track('resource', record(), async () => {});
  const observation = await manager.inspect('resource');
  assert.equal(observation.info?.state, 'paused');
  assert.equal(observation.record.status, 'paused');
  assert.equal(fake.counts.connect, 0);
  assert.equal(fake.counts.renew, 0);
  await manager.close();
});

test('checkpointed sandbox restores before reconnecting and clears its checkpoint record', async () => {
  let state: 'running' | 'paused' = 'running';
  const calls: string[] = [];
  const handle = { sandboxId: 'sandbox-1' } as unknown as SandboxHandle;
  const provider: SandboxProvider & { checkpoint(id: string): Promise<{ id: string; createdAt: string }>; restore(id: string, checkpointId: string): Promise<void> } = {
    create: async () => handle,
    connect: async () => { calls.push('connect'); assert.equal(state, 'running'); return handle; },
    getInfo: async () => ({ sandboxId: 'sandbox-1', state, startedAt: new Date(), endAt: new Date(Date.now() + 60_000) }),
    pause: async () => true, kill: async () => true,
    checkpoint: async () => { calls.push('checkpoint'); state = 'paused'; return { id: 'checkpoint-1', createdAt: new Date().toISOString() }; },
    restore: async () => { calls.push('restore'); state = 'running'; },
  };
  const hooks: string[] = [];
  const lifecycle = new SandboxLifecycle([{ name: 'observer',
    pre: async context => { hooks.push(`pre:${context.action}`); },
    post: async context => { hooks.push(`post:${context.action}`); },
  }]);
  const manager = new SandboxManager({ provider, lifecycle, policy: { autoCheckpointAfterMs: 1, scanIntervalMs: 2 } });
  manager.track('resource', { ...record('ready'), lastActiveAt: new Date(0).toISOString() }, async () => {});
  await waitUntil(() => manager.peek('resource')?.checkpoint?.id === 'checkpoint-1');
  assert.equal(manager.peek('resource')?.status, 'paused');
  const lease = await manager.acquire('resource', { usageId: 'turn-1' });
  assert.deepEqual(calls, ['checkpoint', 'restore', 'connect']);
  assert.deepEqual(hooks, ['pre:checkpoint', 'post:checkpoint', 'pre:resume', 'post:resume']);
  assert.equal(manager.peek('resource')?.checkpoint, undefined);
  await lease.release();
  await manager.close();
});

test('retry clears a checkpoint consumed by a restore whose owner aborted before local cleanup', async () => {
  let state: 'running' | 'paused' = 'paused';
  let restores = 0, connects = 0;
  const handle = { sandboxId: 'sandbox-1' } as unknown as SandboxHandle;
  let restoreStarted!: (signal: AbortSignal | undefined) => void;
  const started = new Promise<AbortSignal | undefined>(resolve => { restoreStarted = resolve; });
  let finishRestore!: () => void;
  const restoreGate = new Promise<void>(resolve => { finishRestore = resolve; });
  const provider: SandboxProvider & { checkpoint(id: string): Promise<{ id: string; createdAt: string }>; restore(id: string, checkpointId: string, options?: { signal?: AbortSignal }): Promise<void> } = {
    create: async () => handle,
    connect: async () => { connects++; assert.equal(state, 'running'); return handle; },
    getInfo: async () => ({ sandboxId: 'sandbox-1', state, startedAt: new Date(), endAt: new Date(Date.now() + 60_000) }),
    pause: async () => true, kill: async () => true,
    checkpoint: async () => ({ id: 'checkpoint-1', createdAt: new Date().toISOString() }),
    restore: async (_id, _checkpointId, options) => {
      restores++;
      state = 'running'; // Remote restore was accepted before the owner disconnected.
      restoreStarted(options?.signal);
      await restoreGate; // Deliberately return success despite the aborted signal.
    },
  };
  const manager = new SandboxManager({ provider, policy: { scanIntervalMs: 60_000 } });
  manager.track('resource', { ...record('paused'), checkpoint: { id: 'checkpoint-1', createdAt: new Date().toISOString() } }, async () => {});
  const owner = new AbortController();
  const first = manager.acquire('resource', { usageId: 'resume-owner', signal: owner.signal });
  const restoreSignal = await started;
  owner.abort(new Error('resume owner lost'));
  await assert.rejects(first, /resume owner lost/);
  assert.equal(restoreSignal?.aborted, true, 'checkpoint restore receives the shared flight cancellation');
  finishRestore();
  const internals = manager as unknown as { entries: Map<string, { connecting?: unknown }> };
  await waitUntil(() => !internals.entries.get('resource')?.connecting);
  assert.equal(manager.peek('resource')?.checkpoint?.id, 'checkpoint-1', 'unknown restore outcome stays recorded until provider state is rechecked');

  const retry = await manager.acquire('resource', { usageId: 'retry-owner' });
  assert.equal(restores, 1, 'running provider state proves the old checkpoint was consumed');
  assert.equal(connects, 1);
  assert.equal(manager.peek('resource')?.checkpoint, undefined);
  await retry.release();
  await manager.close();
});

test('multiple usages share renewal while inspect and idle scans never renew', async () => {
  const fake = fixture('paused');
  const manager = new SandboxManager({
    provider: fake.provider,
    policy: { timeoutMs: 10_000, renewalIntervalMs: 20, scanIntervalMs: 2 },
  });
  manager.track('resource', record(), async () => {});
  const first = await manager.acquire('resource', { usageId: 'turn-1' });
  const second = await manager.acquire('resource', { usageId: 'turn-2' });
  await waitUntil(() => fake.counts.renew === 1);
  assert.equal(fake.counts.renew, 1);
  await manager.inspect('resource');
  assert.equal(fake.counts.renew, 1);
  await first.release();
  await second.release();
  const afterRelease = fake.counts.renew;
  await wait(30);
  assert.equal(fake.counts.renew, afterRelease);
  await manager.close();
});

test('explicit ensure-running uses one keyed provider command and never persists manager transitions', async () => {
  const handle = { sandboxId: 'sandbox-1' } as SandboxHandle;
  let reads = 0, writes = 0;
  const lifecycleActions: string[] = [];
  const calls: Array<{ key: string; expectedGeneration?: number }> = [];
  const provider: SandboxProvider = {
    create: async () => handle,
    connect: async () => { assert.fail('ensure-running must not fall back to connect'); },
    getInfo: async () => {
      reads++;
      if (reads === 1) return { sandboxId: 'sandbox-1', state: 'paused', startedAt: new Date(0), endAt: new Date(9999999999999), metadata: { generation: '3' } };
      assert.fail('ensure-running must use its returned snapshot');
    },
    ensureRunning: async (_id, options) => {
      calls.push({ key: options.operationKey, expectedGeneration: options.expectedGeneration });
      return { handle, info: { sandboxId: 'sandbox-1', state: 'running', startedAt: new Date(0), endAt: new Date(9999999999999),
        metadata: { generation: '8', phase: 'running' }, capabilities: { sharedDirectory: true } } };
    },
    pause: async () => true, kill: async () => true,
  };
  const manager = new SandboxManager({ provider, policy: { scanIntervalMs: 60_000 },
    lifecycle: new SandboxLifecycle([{ name: 'record-actions', pre: async context => { lifecycleActions.push(`pre:${context.action}`); },
      post: async context => { lifecycleActions.push(`post:${context.action}`); } }]) });
  manager.track('resource', { ...record('paused'), version: 4, checkpoint: { id: 'checkpoint-1', createdAt: new Date(0).toISOString() } }, async () => { writes++; });
  // Seed a stale local observation. Explicit resume must trust the operation
  // key and returned snapshot instead of fencing against this cached generation.
  await manager.inspect('resource');
  reads = 0;
  const lease = await manager.ensureRunning('resource', 'resume-op-123');
  assert.deepEqual(calls, [{ key: 'resume-op-123', expectedGeneration: undefined }]);
  assert.equal(reads, 0);
  assert.equal(writes, 0);
  assert.equal(lease.info?.capabilities?.sharedDirectory, true);
  assert.equal(lease.record.status, 'ready');
  assert.equal(lease.record.checkpoint, undefined, 'checkpoint is cleared locally after provider ensure succeeds');
  assert.deepEqual(lifecycleActions, ['pre:resume', 'post:resume']);
  await lease.release();
  assert.equal(writes, 0, 'ephemeral resume usage release must not persist project metadata');
  assert.deepEqual(manager.peek('resource')?.operation, undefined);
  await manager.close();
});

test('ordinary acquire only attaches to a running Cellbox and never invokes ensure-running', async () => {
  const handle = { sandboxId: 'sandbox-1' } as SandboxHandle;
  let state: SandboxInfo['state'] = 'running';
  let connects = 0, ensures = 0, restores = 0;
  const provider: SandboxProvider & { checkpoint(id: string): Promise<{ id: string; createdAt: string }>; restore(id: string, checkpointId: string): Promise<void> } = {
    create: async () => handle,
    connect: async () => { connects++; return handle; },
    getInfo: async () => ({ sandboxId: 'sandbox-1', state, startedAt: new Date(0), metadata: { generation: '4' } }),
    ensureRunning: async () => { ensures++; throw new Error('ordinary acquire must not ensure-running'); },
    checkpoint: async () => ({ id: 'checkpoint', createdAt: new Date().toISOString() }),
    restore: async () => { restores++; },
    pause: async () => true, kill: async () => true,
  };
  const manager = new SandboxManager({ provider, policy: { scanIntervalMs: 60_000 } });
  manager.track('resource', record('ready'), async () => {});
  try {
    const lease = await manager.acquire('resource', { usageId: 'normal-work' });
    await lease.release();
    assert.equal(connects, 1);
    assert.equal(ensures, 0);

    state = 'paused';
    manager.track('paused-resource', { ...record('paused'), id: 'sandbox-1',
      checkpoint: { id: 'legacy-checkpoint', createdAt: new Date(0).toISOString() } }, async () => {});
    await assert.rejects(manager.acquire('paused-resource', { usageId: 'normal-work' }), /explicit ensure-running is required/);
    assert.equal(connects, 1, 'paused ordinary acquire is rejected before provider connect');
    assert.equal(ensures, 0, 'paused ordinary acquire does not submit a lifecycle command');
    assert.equal(restores, 0, 'Cellbox checkpoint markers are not implicitly restored');
  } finally { await manager.close(); }
});

test('explicit running ensure coexists with an active usage, while pause remains busy', async () => {
  const handle = { sandboxId: 'sandbox-1' } as SandboxHandle;
  let ensures = 0, pauses = 0;
  const provider: SandboxProvider = {
    create: async () => handle,
    connect: async () => handle,
    getInfo: async () => ({ sandboxId: 'sandbox-1', state: 'running', startedAt: new Date(0), metadata: { generation: '7' } }),
    ensureRunning: async () => {
      ensures++;
      return { handle, info: { sandboxId: 'sandbox-1', state: 'running', startedAt: new Date(0),
        metadata: { generation: '7', phase: 'running' } } };
    },
    pause: async () => { pauses++; return true; },
    kill: async () => true,
  };
  const manager = new SandboxManager({ provider, policy: { scanIntervalMs: 60_000 } });
  manager.track('resource', record('ready'), async () => {});
  const usageIds = () => [...((manager as unknown as { entries: Map<string, { usages: Map<string, unknown> }> })
    .entries.get('resource')?.usages.keys() ?? [])];
  try {
    const original = await manager.acquire('resource', { usageId: 'active-session' });
    const operation = await manager.ensureRunning('resource', 'resume-operation');
    assert.equal(ensures, 1, 'explicit ensure reaches the provider despite a live local usage');
    assert.deepEqual(usageIds(), ['active-session', 'operation:resume-operation']);

    await operation.release();
    assert.deepEqual(usageIds(), ['active-session'], 'releasing the temporary operation lease preserves the original lease');
    await assert.rejects(manager.pause('resource'), { code: 'busy' });
    assert.equal(pauses, 0, 'pause remains protected while the original execution owns its usage');

    await original.release();
    await manager.pause('resource');
    assert.equal(pauses, 1, 'pause is allowed after the execution usage releases');
  } finally { await manager.close(); }
});

test('Cellbox suspended ensure preserves the provider BUSY error and the existing usage', async () => {
  const handle = { sandboxId: 'sandbox-1' } as SandboxHandle;
  const busy = Object.assign(new Error('sandbox has an active execution'), {
    name: 'CellboxError', code: 'BUSY', idempotencyKey: 'busy-resume-key',
  });
  const provider: SandboxProvider = {
    create: async () => handle,
    connect: async () => handle,
    getInfo: async () => ({ sandboxId: 'sandbox-1', state: 'running', startedAt: new Date(0), metadata: { generation: '7' } }),
    ensureRunning: async () => { throw busy; },
    pause: async () => true,
    kill: async () => true,
  };
  const manager = new SandboxManager({ provider, policy: { scanIntervalMs: 60_000 } });
  manager.track('resource', record('ready'), async () => {});
  const usageIds = () => [...((manager as unknown as { entries: Map<string, { usages: Map<string, unknown> }> })
    .entries.get('resource')?.usages.keys() ?? [])];
  try {
    const original = await manager.acquire('resource', { usageId: 'active-session' });
    await assert.rejects(manager.ensureRunning('resource', 'busy-resume-key'), (error: unknown) => {
      assert.equal(error, busy, 'provider BUSY is propagated without wrapping or losing its identity');
      assert.equal((error as typeof busy).code, 'BUSY');
      assert.equal((error as typeof busy).idempotencyKey, 'busy-resume-key');
      return true;
    });
    assert.deepEqual(usageIds(), ['active-session']);
    await original.release();
  } finally { await manager.close(); }
});

test('same-key ensure-running calls join one provider command and share operation usage', async () => {
  const handle = { sandboxId: 'sandbox-1' } as SandboxHandle;
  let submissions = 0;
  let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const provider: SandboxProvider = {
    create: async () => handle,
    connect: async () => { assert.fail('ensure-running must not fall back to connect'); },
    getInfo: async () => { assert.fail('ensure-running must not inspect before submission'); },
    ensureRunning: async () => {
      submissions++;
      await gate;
      return { handle, info: { sandboxId: 'sandbox-1', state: 'running', startedAt: new Date(0), endAt: new Date(9999999999999) } };
    },
    pause: async () => true, kill: async () => true,
  };
  const manager = new SandboxManager({ provider, policy: { scanIntervalMs: 60_000 } });
  manager.track('resource', record('paused'), async () => {});
  try {
    const first = manager.ensureRunning('resource', 'same-operation');
    await waitForConnectWaiters(manager, 'resource', 1);
    const second = manager.ensureRunning('resource', 'same-operation');
    await waitForConnectWaiters(manager, 'resource', 2);
    assert.equal(submissions, 1);
    finish();
    const [firstLease, secondLease] = await Promise.all([first, second]);
    assert.equal(submissions, 1);
    await firstLease.release();
    assert.equal(manager.peek('resource')?.status, 'ready');
    await secondLease.release();
  } finally { finish(); await manager.close(); }
});

test('close waits for an in-flight ensure-running command and its local publication', async () => {
  const handle = { sandboxId: 'sandbox-1' } as SandboxHandle;
  let finish!: () => void;
  let submitted!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const didSubmit = new Promise<void>(resolve => { submitted = resolve; });
  const provider: SandboxProvider = {
    create: async () => handle,
    connect: async () => { assert.fail('ensure-running must not fall back to connect'); },
    getInfo: async () => { assert.fail('ensure-running must not inspect before submission'); },
    ensureRunning: async () => {
      submitted();
      await gate;
      return { handle, info: { sandboxId: 'sandbox-1', state: 'running', startedAt: new Date(0),
        metadata: { generation: '2', phase: 'running' } } };
    },
    pause: async () => true, kill: async () => true,
  };
  const manager = new SandboxManager({ provider, policy: { scanIntervalMs: 60_000 } });
  manager.track('resource', record('paused'), async () => {});
  try {
    const ensuring = manager.ensureRunning('resource', 'close-waits-key');
    await didSubmit;
    let closed = false;
    const closing = manager.close().then(() => { closed = true; });
    await wait(10);
    assert.equal(closed, false, 'close must await the provider command, not only resource locks');
    finish();
    const lease = await ensuring;
    await closing;
    assert.equal(closed, true);
    assert.equal(lease.record.status, 'ready', 'local state publication completes before close returns');
  } finally { finish(); await manager.close(); }
});

test('recovered unknown checkpoint record resumes through one explicit command with no connect hook or persistence', async () => {
  const handle = { sandboxId: 'sandbox-1' } as SandboxHandle;
  const actions: string[] = [];
  let restores = 0, reads = 0, writes = 0, commands = 0;
  const provider: SandboxProvider & { checkpoint(id: string): Promise<{ id: string; createdAt: string }>; restore(id: string, checkpointId: string): Promise<void> } = {
    create: async () => handle,
    connect: async () => { assert.fail('recovered resume must not run connect'); },
    getInfo: async () => { reads++; assert.fail('recovered resume must trust the ensure snapshot'); },
    ensureRunning: async (_id, options) => {
      commands++;
      assert.equal(options.operationKey, 'durable-project-operation');
      assert.equal(options.expectedGeneration, undefined);
      return { handle, info: { sandboxId: 'sandbox-1', state: 'running', startedAt: new Date(0),
        metadata: { phase: 'running', generation: '12' } } };
    },
    checkpoint: async () => ({ id: 'new-checkpoint', createdAt: new Date().toISOString() }),
    restore: async () => { restores++; },
    pause: async () => true, kill: async () => true,
  };
  const manager = new SandboxManager({ provider, policy: { scanIntervalMs: 60_000 },
    lifecycle: new SandboxLifecycle([{ name: 'record-actions', pre: async context => { actions.push(`pre:${context.action}`); },
      post: async context => { actions.push(`post:${context.action}`); } }]) });
  manager.track('resource', { ...record('unavailable'), checkpoint: { id: 'old-checkpoint', createdAt: new Date(0).toISOString() } }, async () => { writes++; });
  try {
    const lease = await manager.ensureRunning('resource', 'durable-project-operation');
    assert.equal(commands, 1);
    assert.equal(reads, 0);
    assert.equal(restores, 0);
    assert.equal(writes, 0);
    assert.deepEqual(actions, ['pre:resume', 'post:resume']);
    assert.equal(lease.record.checkpoint, undefined);
    await lease.release();
  } finally { await manager.close(); }
});

test('unknown ensure-running outcome preserves provider code, key, and resumable local operation', async () => {
  const handle = { sandboxId: 'sandbox-1' } as SandboxHandle;
  const error = Object.assign(new Error('submission response lost'), { name: 'CellboxError', code: 'UNKNOWN_OUTCOME', idempotencyKey: 'resume-op-unknown' });
  let writes = 0;
  const provider: SandboxProvider = {
    create: async () => handle,
    connect: async () => { assert.fail('ensure-running must not fall back to connect'); },
    getInfo: async () => { assert.fail('ensure-running must not inspect before submission'); },
    ensureRunning: async () => { throw error; },
    pause: async () => true, kill: async () => true,
  };
  const manager = new SandboxManager({ provider, policy: { scanIntervalMs: 60_000 } });
  manager.track('resource', record('paused'), async () => { writes++; });
  await assert.rejects(manager.ensureRunning('resource', 'resume-op-unknown'), (caught: unknown) => {
    assert.equal(caught, error);
    assert.equal((caught as typeof error).code, 'UNKNOWN_OUTCOME');
    assert.equal((caught as typeof error).idempotencyKey, 'resume-op-unknown');
    return true;
  });
  assert.equal(manager.peek('resource')?.operation, 'resuming');
  assert.equal(writes, 0);
  await manager.close();
});

for (const detail of ['404 sandbox not found', 'error: no such object: sandbox-1']) {
test(`missing sandbox marks an ordinary record unavailable without creating a replacement: ${detail}`, async () => {
  const fake = fixture('paused');
  fake.provider.getInfo = async () => { throw new Error(detail); };
  const manager = new SandboxManager({ provider: fake.provider, policy: { scanIntervalMs: 60_000 } });
  manager.track('resource', record(), async () => {});
  await assert.rejects(manager.inspect('resource'), { code: 'not_accessible' });
  assert.equal(manager.peek('resource')?.status, 'unavailable');
  await assert.rejects(manager.acquire('resource', {
    usageId: 'turn-1', create: { template: 'replacement-must-not-be-created' },
  }), { code: 'not_accessible' });
  assert.equal(fake.counts.create, 0);
  await manager.close();
});
}

test('a stopped provider instance is unavailable on inspection and can become ready again', async () => {
  const fake = fixture('running');
  const manager = new SandboxManager({ provider: fake.provider, policy: { scanIntervalMs: 60_000 } });
  manager.track('resource', record('ready'), async () => {});
  const getInfo = fake.provider.getInfo;
  try {
    fake.provider.getInfo = async id => ({ ...await getInfo(id), state: 'unknown' });
    await manager.inspect('resource');
    assert.equal(manager.peek('resource')?.status, 'unavailable');
    assert.equal(fake.counts.connect, 0);
    assert.equal(fake.counts.create, 0);
    fake.provider.getInfo = getInfo;
    await manager.inspect('resource');
    assert.equal(manager.peek('resource')?.status, 'ready');
  } finally { await manager.close(); }
});

test('repeated pause preserves the original pausedAt', async () => {
  const fake = fixture('paused');
  const pausedAt = new Date(0).toISOString();
  const manager = new SandboxManager({ provider: fake.provider, policy: { scanIntervalMs: 60_000 } });
  manager.track('resource', { ...record(), pausedAt }, async () => {});
  const result = await manager.pause('resource');
  assert.equal(result.pausedAt, pausedAt);
  assert.equal(fake.counts.pause, 0);
  await manager.close();
});

test('an aborted waiter returns promptly without cancelling or leaking the shared connection', async () => {
  const fake = fixture('paused', 80);
  const manager = new SandboxManager({ provider: fake.provider, policy: { scanIntervalMs: 60_000 } });
  manager.track('resource', record(), async () => {});
  const first = manager.acquire('resource', { usageId: 'turn-1' });
  await wait(5);
  const cancellation = new AbortController();
  const second = manager.acquire('resource', { usageId: 'turn-2', signal: cancellation.signal });
  cancellation.abort(new Error('cancelled'));
  await assert.rejects(second, /cancelled/);
  const lease = await first;
  await lease.release();
  await manager.pause('resource');
  assert.equal(fake.counts.connect, 1);
  await manager.close();
});

test('abort during persistence does not register an ownerless usage', async () => {
  const fake = fixture('running');
  let saveStarted!: () => void;
  const started = new Promise<void>(resolve => { saveStarted = resolve; });
  let unblock!: () => void;
  const blocked = new Promise<void>(resolve => { unblock = resolve; });
  const persist = async () => { saveStarted(); await blocked; };
  const manager = new SandboxManager({ provider: fake.provider, policy: { scanIntervalMs: 60_000 } });
  manager.track('resource', record('ready'), persist);
  const cancellation = new AbortController();
  const acquiring = manager.acquire('resource', { usageId: 'turn-1', signal: cancellation.signal });
  await started;
  cancellation.abort(new Error('cancelled while saving'));
  await assert.rejects(acquiring, /cancelled while saving/);
  unblock();
  await wait(5);
  await manager.pause('resource');
  assert.equal(fake.counts.pause, 1);
  await manager.close();
});

test('late cancellation restores a detached recovery claim while discarding its lease', async () => {
  const fake = fixture('running');
  const manager = new SandboxManager({ provider: fake.provider, policy: { scanIntervalMs: 60_000 } });
  const cancellation = new AbortController();
  let resolveOperation!: (value: unknown) => void;
  const operation = new Promise(resolve => { resolveOperation = resolve; });
  let releasedWith: { detached?: boolean } | undefined;
  const lease = {
    resourceKey: 'resource', usageId: 'turn-1', sandbox: fake.handle,
    record: record('ready'), signal: new AbortController().signal,
    async release(options?: { detached?: boolean }) { releasedWith = options; },
  };
  const result = (manager as unknown as {
    abortableLease(value: Promise<unknown>, signal: AbortSignal): Promise<unknown>;
  }).abortableLease(operation, cancellation.signal);
  cancellation.abort(new Error('cancelled after lease creation'));
  resolveOperation({ lease, restoreDetachedOnAbort: true });
  await assert.rejects(result, /cancelled after lease creation/);
  await waitUntil(() => releasedWith !== undefined);
  assert.deepEqual(releasedWith, { detached: true });
  await manager.close();
});

test('a failed create persistence does not create a replacement sandbox', async () => {
  const fake = fixture('paused');
  let saves = 0;
  const persist = async () => {
    saves += 1;
    if (saves === 1) throw new Error('disk full');
  };
  const manager = new SandboxManager({ provider: fake.provider, policy: { scanIntervalMs: 60_000 } });
  await assert.rejects(
    manager.acquire('resource', { usageId: 'turn-1', persist, create: { template: 'template-1' } }),
    SandboxPersistenceError,
  );
  const lease = await manager.acquire('resource', { usageId: 'turn-1', persist });
  assert.equal(fake.counts.create, 1);
  await lease.release();
  await manager.close();
});

test('replace persists through the original callback before switching and invalidates the old handle', async () => {
  const fake = fixture('running');
  const saved: SandboxRecord[] = [];
  const persist = async (value: SandboxRecord) => { saved.push(value); };
  const manager = new SandboxManager({ provider: fake.provider, policy: { scanIntervalMs: 60_000 } });
  manager.track('resource', record('ready'), persist);
  const oldLease = await manager.acquire('resource', { usageId: 'turn-1' });
  await oldLease.release();

  const replacement = { ...record('paused'), id: 'sandbox-2', template: 'template-2' };
  await manager.replace('resource', 'sandbox-1', replacement);

  assert.deepEqual(manager.peek('resource'), replacement);
  assert.deepEqual(saved.at(-1), replacement);
  assert.equal(oldLease.signal.aborted, true);
  assert.equal(fake.counts.kill, 0);
  await manager.close();
});

test('replace rejects active and detached usages', async () => {
  const fake = fixture('running');
  const manager = new SandboxManager({ provider: fake.provider, policy: { scanIntervalMs: 60_000 } });
  manager.track('resource', record('ready'), async () => {});
  const lease = await manager.acquire('resource', { usageId: 'turn-1' });
  const replacement = { ...record('paused'), id: 'sandbox-2' };

  await assert.rejects(manager.replace('resource', 'sandbox-1', replacement), SandboxBusyError);
  await lease.release({ detached: true });
  await assert.rejects(manager.replace('resource', 'sandbox-1', replacement), SandboxBusyError);
  assert.equal(manager.peek('resource')?.id, 'sandbox-1');
  await manager.close();
});

test('replace validates the expected sandbox ID under the resource lock', async () => {
  const fake = fixture('paused');
  const manager = new SandboxManager({ provider: fake.provider, policy: { scanIntervalMs: 60_000 } });
  manager.track('resource', record(), async () => {});

  await assert.rejects(
    manager.replace('resource', 'stale-sandbox', { ...record(), id: 'sandbox-2' }),
    /bound to sandbox-1, not stale-sandbox/,
  );
  assert.equal(manager.peek('resource')?.id, 'sandbox-1');
  await manager.close();
});

test('failed replacement persistence leaves the old binding valid and can be retried', async () => {
  const fake = fixture('running');
  let failReplacement = true;
  const persist = async (value: SandboxRecord) => {
    if (value.id === 'sandbox-2' && failReplacement) throw new Error('disk full');
  };
  const manager = new SandboxManager({ provider: fake.provider, policy: { scanIntervalMs: 60_000 } });
  manager.track('resource', record('ready'), persist);
  const oldLease = await manager.acquire('resource', { usageId: 'turn-1' });
  await oldLease.release();
  const replacement = { ...record('paused'), id: 'sandbox-2' };

  await assert.rejects(manager.replace('resource', 'sandbox-1', replacement), SandboxPersistenceError);
  assert.equal(manager.peek('resource')?.id, 'sandbox-1');
  assert.equal(oldLease.signal.aborted, false);

  failReplacement = false;
  await manager.replace('resource', 'sandbox-1', replacement);
  assert.equal(manager.peek('resource')?.id, 'sandbox-2');
  assert.equal(oldLease.signal.aborted, true);
  await manager.close();
});

test('replace flushes pending old state before persisting the replacement', async () => {
  const fake = fixture('running');
  const savedIds: string[] = [];
  let failFirstSave = true;
  const persist = async (value: SandboxRecord) => {
    savedIds.push(value.id);
    if (failFirstSave) {
      failFirstSave = false;
      throw new Error('temporary storage failure');
    }
  };
  const manager = new SandboxManager({ provider: fake.provider, policy: { scanIntervalMs: 60_000 } });
  manager.track('resource', record('ready'), persist);
  await assert.rejects(manager.acquire('resource', { usageId: 'turn-1' }), SandboxPersistenceError);

  await manager.replace('resource', 'sandbox-1', { ...record('paused'), id: 'sandbox-2' });
  assert.deepEqual(savedIds, ['sandbox-1', 'sandbox-1', 'sandbox-2']);
  assert.equal(manager.peek('resource')?.id, 'sandbox-2');
  await manager.close();
});

test('replace does not persist a replacement while old state is still pending', async () => {
  const fake = fixture('running');
  const attemptedIds: string[] = [];
  const persist = async (value: SandboxRecord) => {
    attemptedIds.push(value.id);
    throw new Error('storage unavailable');
  };
  const manager = new SandboxManager({ provider: fake.provider, policy: { scanIntervalMs: 60_000 } });
  manager.track('resource', record('ready'), persist);
  await assert.rejects(manager.acquire('resource', { usageId: 'turn-1' }), SandboxPersistenceError);

  await assert.rejects(
    manager.replace('resource', 'sandbox-1', { ...record('paused'), id: 'sandbox-2' }),
    SandboxPersistenceError,
  );
  assert.deepEqual(attemptedIds, ['sandbox-1', 'sandbox-1']);
  assert.equal(manager.peek('resource')?.id, 'sandbox-1');
  await manager.close();
});

test('concurrent replacements serialize and only the expected binding wins', async () => {
  const fake = fixture('paused');
  let unblock!: () => void;
  const blocked = new Promise<void>(resolve => { unblock = resolve; });
  let replacementSaveStarted!: () => void;
  const saveStarted = new Promise<void>(resolve => { replacementSaveStarted = resolve; });
  const persistedIds: string[] = [];
  const persist = async (value: SandboxRecord) => {
    persistedIds.push(value.id);
    if (value.id === 'sandbox-2') {
      replacementSaveStarted();
      await blocked;
    }
  };
  const manager = new SandboxManager({ provider: fake.provider, policy: { scanIntervalMs: 60_000 } });
  manager.track('resource', record(), persist);
  const first = manager.replace('resource', 'sandbox-1', { ...record(), id: 'sandbox-2' });
  await saveStarted;
  const second = manager.replace('resource', 'sandbox-1', { ...record(), id: 'sandbox-3' });
  unblock();

  await first;
  await assert.rejects(second, /bound to sandbox-2, not sandbox-1/);
  assert.deepEqual(persistedIds, ['sandbox-2']);
  assert.equal(manager.peek('resource')?.id, 'sandbox-2');
  await manager.close();
});

test('untrack removes an idle binding without killing the sandbox and is idempotent', async () => {
  const fake = fixture('running');
  const manager = new SandboxManager({ provider: fake.provider, policy: { scanIntervalMs: 60_000 } });
  manager.track('resource', record('ready'), async () => {});
  const lease = await manager.acquire('resource', { usageId: 'turn-1' });
  await lease.release();

  await manager.untrack('resource', 'sandbox-1');
  await manager.untrack('resource', 'sandbox-1');

  assert.equal(manager.peek('resource'), undefined);
  assert.equal(lease.signal.aborted, true);
  assert.equal(fake.counts.kill, 0);
  assert.equal(fake.counts.pause, 0);
  await manager.close();
});

test('untrack validates the expected sandbox and rejects active or detached usage', async () => {
  const fake = fixture('running');
  const manager = new SandboxManager({ provider: fake.provider, policy: { scanIntervalMs: 60_000 } });
  manager.track('resource', record('ready'), async () => {});

  await assert.rejects(manager.untrack('resource', 'stale-sandbox'), /bound to sandbox-1, not stale-sandbox/);
  const lease = await manager.acquire('resource', { usageId: 'turn-1' });
  await assert.rejects(manager.untrack('resource', 'sandbox-1'), SandboxBusyError);
  await lease.release({ detached: true });
  await assert.rejects(manager.untrack('resource', 'sandbox-1'), SandboxBusyError);
  assert.equal(manager.peek('resource')?.id, 'sandbox-1');
  await manager.close();
});

test('untrack flushes pending state before removing the binding', async () => {
  const fake = fixture('running');
  let saves = 0;
  const persist = async () => {
    saves += 1;
    if (saves === 1) throw new Error('temporary storage failure');
  };
  const manager = new SandboxManager({ provider: fake.provider, policy: { scanIntervalMs: 60_000 } });
  manager.track('resource', record('ready'), persist);
  await assert.rejects(manager.acquire('resource', { usageId: 'turn-1' }), SandboxPersistenceError);

  await manager.untrack('resource', 'sandbox-1');

  assert.equal(saves, 2);
  assert.equal(manager.peek('resource'), undefined);
  await manager.close();
});

test('bind persists before exposing a record and can be retried after persistence failure', async () => {
  const fake = fixture('paused');
  let fail = true;
  const saved: SandboxRecord[] = [];
  const persist = async (value: SandboxRecord) => {
    saved.push(value);
    if (fail) throw new Error('disk full');
  };
  const manager = new SandboxManager({ provider: fake.provider, policy: { scanIntervalMs: 60_000 } });
  const replacement = { ...record('paused'), id: 'sandbox-2', template: 'template-2' };

  await assert.rejects(manager.bind('resource', replacement, persist), SandboxPersistenceError);
  assert.equal(manager.peek('resource'), undefined);
  fail = false;
  await manager.bind('resource', replacement, persist);

  assert.deepEqual(manager.peek('resource'), replacement);
  assert.deepEqual(saved, [replacement, replacement]);
  assert.equal(fake.counts.create, 0);
  assert.equal(fake.counts.connect, 0);
  await manager.close();
});

test('concurrent binds serialize and only one binding succeeds', async () => {
  const fake = fixture('paused');
  let unblock!: () => void;
  const blocked = new Promise<void>(resolve => { unblock = resolve; });
  let announceSave!: () => void;
  const saving = new Promise<void>(resolve => { announceSave = resolve; });
  const manager = new SandboxManager({ provider: fake.provider, policy: { scanIntervalMs: 60_000 } });
  const firstRecord = { ...record('paused'), id: 'sandbox-2' };
  const secondRecord = { ...record('paused'), id: 'sandbox-3' };
  const first = manager.bind('resource', firstRecord, async () => { announceSave(); await blocked; });
  await saving;
  const second = manager.bind('resource', secondRecord, async () => {});
  unblock();

  await first;
  await assert.rejects(second, /already bound to sandbox-2/);
  assert.equal(manager.peek('resource')?.id, 'sandbox-2');
  await manager.close();
});

test('close does not pause or kill remote sandboxes', async () => {
  const fake = fixture('running');
  const manager = new SandboxManager({ provider: fake.provider, policy: { scanIntervalMs: 60_000 } });
  manager.track('resource', record('ready'), async () => {});
  await manager.close();
  assert.equal(fake.counts.pause, 0);
  assert.equal(fake.counts.kill, 0);
  await assert.rejects(manager.pause('resource'), /manager is closed/i);
  await assert.rejects(manager.destroy('resource'), /manager is closed/i);
});

test('close waits for an in-flight persistence callback', async () => {
  const fake = fixture('running');
  let saveStarted!: () => void;
  const started = new Promise<void>(resolve => { saveStarted = resolve; });
  let unblock!: () => void;
  const blocked = new Promise<void>(resolve => { unblock = resolve; });
  const manager = new SandboxManager({ provider: fake.provider, policy: { scanIntervalMs: 60_000 } });
  manager.track('resource', record('ready'), async () => { saveStarted(); await blocked; });
  const acquiring = manager.acquire('resource', { usageId: 'turn-1' });
  await started;
  let closed = false;
  const closing = manager.close().then(() => { closed = true; });
  await wait(5);
  assert.equal(closed, false);
  unblock();
  const lease = await acquiring;
  await closing;
  assert.equal(closed, true);
  await lease.release();
});
