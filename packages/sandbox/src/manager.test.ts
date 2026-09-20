import assert from 'node:assert/strict';
import test from 'node:test';
import type { SandboxHandle, SandboxInfo } from './index.js';
import {
  SandboxManager,
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
  } as unknown as SandboxHandle;
  const info = (): SandboxInfo => ({
    sandboxId: 'sandbox-1', metadata: {},
    startedAt: new Date(0), endAt, state,
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
  const handle = { sandboxId: 'sandbox-1', setTimeout: async () => {} } as unknown as SandboxHandle;
  const provider: SandboxProvider & { checkpoint(id: string): Promise<{ id: string; createdAt: string }>; restore(id: string, checkpointId: string): Promise<void> } = {
    create: async () => handle,
    connect: async () => { calls.push('connect'); assert.equal(state, 'running'); return handle; },
    getInfo: async () => ({ sandboxId: 'sandbox-1', state, startedAt: new Date(), endAt: new Date(Date.now() + 60_000) }),
    pause: async () => true, kill: async () => true,
    checkpoint: async () => { calls.push('checkpoint'); state = 'paused'; return { id: 'checkpoint-1', createdAt: new Date().toISOString() }; },
    restore: async () => { calls.push('restore'); state = 'running'; },
  };
  const manager = new SandboxManager({ provider, policy: { autoCheckpointAfterMs: 1, scanIntervalMs: 2 } });
  manager.track('resource', { ...record('ready'), lastActiveAt: new Date(0).toISOString() }, async () => {});
  await waitUntil(() => manager.peek('resource')?.checkpoint?.id === 'checkpoint-1');
  assert.equal(manager.peek('resource')?.status, 'paused');
  const lease = await manager.acquire('resource', { usageId: 'turn-1' });
  assert.deepEqual(calls, ['checkpoint', 'restore', 'connect']);
  assert.equal(manager.peek('resource')?.checkpoint, undefined);
  await lease.release();
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

test('management 404 marks an ordinary record unavailable without creating a replacement', async () => {
  const fake = fixture('paused');
  fake.provider.getInfo = async () => { throw new Error('404 sandbox not found'); };
  const manager = new SandboxManager({ provider: fake.provider, policy: { scanIntervalMs: 60_000 } });
  manager.track('resource', record(), async () => {});
  await assert.rejects(manager.inspect('resource'), /404 sandbox not found/);
  assert.equal(manager.peek('resource')?.status, 'unavailable');
  await assert.rejects(manager.acquire('resource', {
    usageId: 'turn-1', create: { template: 'replacement-must-not-be-created' },
  }), /404 sandbox not found/);
  assert.equal(fake.counts.create, 0);
  await manager.close();
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
