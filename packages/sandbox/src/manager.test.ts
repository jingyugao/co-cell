import assert from 'node:assert/strict';
import test from 'node:test';
import type { Sandbox, SandboxInfo } from 'e2b';
import {
  E2BSandboxManager,
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
  const handle = {
    sandboxId: 'sandbox-1',
    async setTimeout(timeoutMs: number) {
      counts.renew += 1;
      endAt = new Date(Date.now() + timeoutMs);
    },
  } as unknown as Sandbox;
  const info = (): SandboxInfo => ({
    sandboxId: 'sandbox-1', templateId: 'template-1', metadata: {},
    startedAt: new Date(0), endAt, state, cpuCount: 2, memoryMB: 512, envdVersion: 'test',
  });
  const provider: SandboxProvider = {
    async create() { counts.create += 1; state = 'running'; return handle; },
    async connect() { counts.connect += 1; if (connectDelay) await wait(connectDelay); state = 'running'; return handle; },
    async getInfo() { counts.inspect += 1; return info(); },
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

const record = (status: SandboxRecord['status'] = 'paused'): SandboxRecord => ({
  id: 'sandbox-1', template: 'template-1', status,
  lastActiveAt: new Date(0).toISOString(),
  ...(status === 'paused' ? { pausedAt: new Date(0).toISOString() } : {}),
});

test('concurrent acquire connects once and registers both usages', async () => {
  const fake = fixture('paused', 20);
  const saved: SandboxRecord[] = [];
  const persist = async (value: SandboxRecord) => { saved.push(value); };
  const manager = new E2BSandboxManager({ provider: fake.provider, connection: {}, policy: { scanIntervalMs: 60_000 } });
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

test('detached usage stays busy and the same usage can recover it', async () => {
  const fake = fixture('running');
  const persist = async () => {};
  const manager = new E2BSandboxManager({ provider: fake.provider, connection: {}, policy: { scanIntervalMs: 60_000 } });
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
  const manager = new E2BSandboxManager({ provider: fake.provider, connection: {}, policy: { scanIntervalMs: 60_000 } });
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
  const manager = new E2BSandboxManager({ provider: fake.provider, connection: {}, policy: { scanIntervalMs: 60_000 } });
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
  const manager = new E2BSandboxManager({ provider: fake.provider, connection: {}, policy: { scanIntervalMs: 60_000 } });
  manager.track('resource', record(), async () => {});
  const observation = await manager.inspect('resource');
  assert.equal(observation.info?.state, 'paused');
  assert.equal(observation.record.status, 'paused');
  assert.equal(fake.counts.connect, 0);
  assert.equal(fake.counts.renew, 0);
  await manager.close();
});

test('multiple usages share renewal while inspect and idle scans never renew', async () => {
  const fake = fixture('paused');
  const manager = new E2BSandboxManager({
    provider: fake.provider,
    connection: {},
    policy: { timeoutMs: 10_000, renewalIntervalMs: 20, scanIntervalMs: 2, archiveAfterMs: 60_000 },
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

test('seven-day paused sandbox archives and acquire restores the same ID', async () => {
  const fake = fixture('paused');
  const archive = { key: 'archive.tar.gz', sizeBytes: 12, sha256: 'a'.repeat(64), createdAt: new Date().toISOString() };
  const calls = { archive: 0, restore: 0 };
  const manager = new E2BSandboxManager({
    provider: fake.provider,
    connection: {},
    archives: {
      async archive(sandboxId) { calls.archive += 1; assert.equal(sandboxId, 'sandbox-1'); return archive; },
      async restore(sandboxId, value) { calls.restore += 1; assert.equal(sandboxId, 'sandbox-1'); assert.deepEqual(value, archive); },
    },
    policy: { scanIntervalMs: 2, archiveAfterMs: 7 * 24 * 60 * 60 * 1000 },
  });
  manager.track('resource', record(), async () => {});
  await waitUntil(() => manager.peek('resource')?.status === 'archived');
  assert.equal(calls.archive, 1);
  assert.equal(fake.counts.connect, 0);
  const lease = await manager.acquire('resource', { usageId: 'turn-1' });
  assert.equal(lease.record.id, 'sandbox-1');
  assert.equal(calls.restore, 1);
  assert.equal(fake.counts.connect, 1);
  await lease.release();
  await manager.close();
});

test('failed archive restore keeps the archive reference and archived status', async () => {
  const fake = fixture('paused');
  const archive = { key: 'archive.tar.gz', sizeBytes: 12, sha256: 'a'.repeat(64), createdAt: new Date().toISOString() };
  const manager = new E2BSandboxManager({
    provider: fake.provider,
    connection: {},
    archives: {
      async archive() { return archive; },
      async restore() { throw new Error('restore unavailable'); },
    },
    policy: { scanIntervalMs: 60_000 },
  });
  manager.track('resource', { ...record(), status: 'archived', archive }, async () => {});
  await assert.rejects(manager.acquire('resource', { usageId: 'turn-1' }), /restore unavailable/);
  assert.equal(manager.peek('resource')?.status, 'archived');
  assert.deepEqual(manager.peek('resource')?.archive, archive);
  await manager.close();
});

test('management 404 marks an ordinary record unavailable without creating a replacement', async () => {
  const fake = fixture('paused');
  fake.provider.getInfo = async () => { throw new Error('404 sandbox not found'); };
  const manager = new E2BSandboxManager({ provider: fake.provider, connection: {}, policy: { scanIntervalMs: 60_000 } });
  manager.track('resource', record(), async () => {});
  await assert.rejects(manager.inspect('resource'), /404 sandbox not found/);
  assert.equal(manager.peek('resource')?.status, 'unavailable');
  await assert.rejects(manager.acquire('resource', {
    usageId: 'turn-1', create: { template: 'replacement-must-not-be-created' },
  }), /404 sandbox not found/);
  assert.equal(fake.counts.create, 0);
  await manager.close();
});

test('archived record survives management 404 and can still use archive restoration', async () => {
  const fake = fixture('paused');
  fake.provider.getInfo = async () => { throw new Error('404 sandbox not found'); };
  const archive = { key: 'archive.tar.gz', sizeBytes: 12, sha256: 'a'.repeat(64), createdAt: new Date().toISOString() };
  const manager = new E2BSandboxManager({ provider: fake.provider, connection: {}, policy: { scanIntervalMs: 60_000 } });
  manager.track('resource', { ...record(), status: 'archived', archive }, async () => {});
  const observation = await manager.inspect('resource');
  assert.equal(observation.record.status, 'archived');
  assert.deepEqual(observation.record.archive, archive);
  await manager.close();
});

test('repeated pause preserves the original pausedAt', async () => {
  const fake = fixture('paused');
  const pausedAt = new Date(0).toISOString();
  const manager = new E2BSandboxManager({ provider: fake.provider, connection: {}, policy: { scanIntervalMs: 60_000 } });
  manager.track('resource', { ...record(), pausedAt }, async () => {});
  const result = await manager.pause('resource');
  assert.equal(result.pausedAt, pausedAt);
  assert.equal(fake.counts.pause, 0);
  await manager.close();
});

test('an aborted waiter returns promptly without cancelling or leaking the shared connection', async () => {
  const fake = fixture('paused', 80);
  const manager = new E2BSandboxManager({ provider: fake.provider, connection: {}, policy: { scanIntervalMs: 60_000 } });
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
  const manager = new E2BSandboxManager({ provider: fake.provider, connection: {}, policy: { scanIntervalMs: 60_000 } });
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
  const manager = new E2BSandboxManager({ provider: fake.provider, connection: {}, policy: { scanIntervalMs: 60_000 } });
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
  const manager = new E2BSandboxManager({ provider: fake.provider, connection: {}, policy: { scanIntervalMs: 60_000 } });
  await assert.rejects(
    manager.acquire('resource', { usageId: 'turn-1', persist, create: { template: 'template-1' } }),
    SandboxPersistenceError,
  );
  const lease = await manager.acquire('resource', { usageId: 'turn-1', persist });
  assert.equal(fake.counts.create, 1);
  await lease.release();
  await manager.close();
});

test('close does not pause or kill remote sandboxes', async () => {
  const fake = fixture('running');
  const manager = new E2BSandboxManager({ provider: fake.provider, connection: {}, policy: { scanIntervalMs: 60_000 } });
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
  const manager = new E2BSandboxManager({ provider: fake.provider, connection: {}, policy: { scanIntervalMs: 60_000 } });
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
