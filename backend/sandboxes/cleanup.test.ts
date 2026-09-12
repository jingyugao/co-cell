import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { SandboxDataArchive } from '../../protocol/sandbox-types.js';
import { SandboxCleanupService, type SandboxCleanupOptions } from './cleanup.js';

const archive = (sandboxId: string): SandboxDataArchive => ({
  key: '00000000-0000-4000-8000-000000000000.tar.gz', sizeBytes: 10, sha256: 'a'.repeat(64),
  createdAt: '2026-01-01T00:00:00.000Z', format: 'codex-workspace-v1', workingDirectory: '/home/user/workspace',
  threadIds: [], manifestSha256: 'b'.repeat(64), sourceSandboxId: sandboxId,
});

async function fixture(overrides: Partial<SandboxCleanupOptions> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'hive-cleanup-'));
  let time = Date.parse('2026-01-02T00:00:00.000Z');
  const calls = { referenced: [] as string[], paused: [] as string[], removed: [] as string[], verified: [] as string[], released: [] as string[] };
  const options: SandboxCleanupOptions = {
    directory, retentionMs: 1_000, scanIntervalMs: 60_000, now: () => time,
    isReferenced: async id => { calls.referenced.push(id); return false; },
    pause: async id => { calls.paused.push(id); },
    remove: async id => { calls.removed.push(id); },
    verifyArchive: async value => { calls.verified.push(value.key); },
    releaseArchive: async value => { calls.released.push(value.key); },
    ...overrides,
  };
  const service = new SandboxCleanupService(options);
  await service.init();
  return { directory, service, calls, advance: (milliseconds: number) => { time += milliseconds; } };
}

test('upgrade is durably scheduled, paused after detach, and deleted after retention', async () => {
  let referenced = true;
  const item = await fixture({ isReferenced: () => referenced });
  try {
    const record = await item.service.schedule('old-sandbox', 'upgrade', archive('old-sandbox'));
    assert.equal(Date.parse(record.deleteAfter) - Date.parse(record.scheduledAt), 1_000);
    const persisted = JSON.parse(await readFile(join(item.directory, 'cleanup.json'), 'utf8'));
    assert.equal(persisted.records[0].sandboxId, 'old-sandbox');

    await item.service.sweep();
    assert.deepEqual(item.calls.paused, []);
    referenced = false;
    await item.service.sweep();
    assert.deepEqual(item.calls.paused, ['old-sandbox']);
    assert.deepEqual(item.calls.removed, []);
    item.advance(1_000);
    await item.service.sweep();
    assert.deepEqual(item.calls.paused, ['old-sandbox']);
    assert.deepEqual(item.calls.removed, ['old-sandbox']);
    assert.deepEqual(await item.service.list(), []);
  } finally { await item.service.close(); await rm(item.directory, { recursive: true, force: true }); }
});

test('idle cleanup requires a valid archive while failed restore is removed immediately', async () => {
  const item = await fixture();
  try {
    await item.service.schedule('idle-sandbox', 'idle');
    await item.service.schedule('candidate-sandbox', 'failed_restore');
    await item.service.sweep();
    assert.deepEqual(item.calls.removed, ['candidate-sandbox']);
    const remaining = await item.service.list();
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].sandboxId, 'idle-sandbox');
    assert.equal(remaining[0].attempts, 1);
    assert.match(remaining[0].lastError!, /归档/);
  } finally { await item.service.close(); await rm(item.directory, { recursive: true, force: true }); }
});

test('archive verification and provider failures retain durable retry records', async () => {
  let verificationFails = true;
  let removalFails = true;
  const item = await fixture({
    verifyArchive: async () => { if (verificationFails) throw new Error('archive unavailable'); },
    remove: async id => { item.calls.removed.push(id); if (removalFails) throw new Error('provider unavailable'); },
  });
  try {
    await item.service.schedule('idle-sandbox', 'idle', archive('idle-sandbox'));
    await item.service.sweep();
    assert.equal((await item.service.list())[0].attempts, 1);
    assert.match((await item.service.list())[0].lastError!, /archive unavailable/);
    verificationFails = false;
    await item.service.sweep();
    assert.equal((await item.service.list())[0].attempts, 2);
    assert.match((await item.service.list())[0].lastError!, /provider unavailable/);
    removalFails = false;
    await item.service.sweep();
    assert.deepEqual(await item.service.list(), []);
  } finally { await item.service.close(); await rm(item.directory, { recursive: true, force: true }); }
});

test('restart loads pending records without starting a timer and list is defensive', async () => {
  const item = await fixture();
  try {
    await item.service.schedule('old-sandbox', 'upgrade', archive('old-sandbox'));
    await item.service.close();
    const removed: string[] = [];
    const restarted = new SandboxCleanupService({
      directory: item.directory, retentionMs: 1_000, now: () => Date.parse('2026-01-03T00:00:00.000Z'),
      scanIntervalMs: 60_000, isReferenced: () => false, pause: async () => {}, remove: async id => { removed.push(id); },
      verifyArchive: async () => {},
    });
    await restarted.init();
    const snapshot = await restarted.list();
    snapshot[0].attempts = 99;
    assert.equal((await restarted.list())[0].attempts, 0);
    assert.deepEqual(removed, []);
    await restarted.sweep();
    assert.deepEqual(removed, ['old-sandbox']);
    await restarted.close();
  } finally { await rm(item.directory, { recursive: true, force: true }); }
});

test('concurrent sweeps and rescheduling serialize provider actions and preserve the latest record', async () => {
  let release!: () => void;
  let removing!: () => void;
  const removingStarted = new Promise<void>(resolve => { removing = resolve; });
  const item = await fixture({ remove: async id => {
    item.calls.removed.push(id);
    removing();
    await new Promise<void>(resolve => { release = resolve; });
  } });
  try {
    await item.service.schedule('candidate', 'failed_restore');
    const first = item.service.sweep();
    await removingStarted;
    const second = item.service.sweep();
    const rescheduled = item.service.schedule('candidate', 'upgrade', archive('candidate'));
    release();
    await Promise.all([first, second, rescheduled]);
    assert.deepEqual(item.calls.removed, ['candidate']);
    assert.equal((await item.service.list())[0].reason, 'upgrade');
  } finally { release?.(); await item.service.close(); await rm(item.directory, { recursive: true, force: true }); }
});

test('manual deletion only forgets explicitly matching cleanup records', async () => {
  const item = await fixture();
  try {
    await item.service.schedule('one', 'failed_restore');
    await item.service.schedule('two', 'failed_restore');
    await item.service.deleted('one');
    await item.service.deleted('unknown');
    assert.deepEqual((await item.service.list()).map(record => record.sandboxId), ['two']);
    assert.deepEqual(item.calls.removed, []);
  } finally { await item.service.close(); await rm(item.directory, { recursive: true, force: true }); }
});

test('a failed durable write leaves the in-memory schedule unchanged', async () => {
  const item = await fixture();
  try {
    await item.service.schedule('existing', 'failed_restore');
    const statePath = join(item.directory, 'cleanup.json');
    await rm(statePath);
    await mkdir(statePath);
    await assert.rejects(item.service.schedule('unwritten', 'failed_restore'));
    assert.deepEqual((await item.service.list()).map(record => record.sandboxId), ['existing']);
  } finally { await item.service.close(); await rm(item.directory, { recursive: true, force: true }); }
});

test('sandbox deletion commits before archive release and a failed release retries after restart', async () => {
  let releaseFails = true;
  const released: string[] = [];
  const item = await fixture({ releaseArchive: async value => {
    released.push(value.key);
    if (releaseFails) throw new Error('archive store unavailable');
  } });
  try {
    const saved = archive('idle-sandbox');
    await item.service.schedule('idle-sandbox', 'idle', saved);
    await item.service.sweep();
    assert.deepEqual(await item.service.list(), []);
    assert.deepEqual(item.calls.removed, ['idle-sandbox']);
    const persisted = JSON.parse(await readFile(join(item.directory, 'cleanup.json'), 'utf8'));
    assert.deepEqual(persisted.records, []);
    assert.equal(persisted.archiveReleases[0].key, saved.key);
    await item.service.close();

    releaseFails = false;
    const restarted = new SandboxCleanupService({
      directory: item.directory, isReferenced: () => false, pause: async () => {},
      remove: async () => { assert.fail('deleted sandbox must not be retried for an archive-release failure'); },
      releaseArchive: async value => { released.push(value.key); },
    });
    await restarted.init();
    assert.equal(released.length, 1, 'init must not start background work');
    await restarted.sweep();
    assert.deepEqual(released, [saved.key, saved.key]);
    assert.deepEqual(JSON.parse(await readFile(join(item.directory, 'cleanup.json'), 'utf8')).archiveReleases, []);
    await restarted.close();
  } finally { await item.service.close(); await rm(item.directory, { recursive: true, force: true }); }
});

test('manual deletion releases an archive only after its final cleanup reference disappears', async () => {
  const item = await fixture();
  try {
    const shared = archive('one');
    await item.service.schedule('one', 'upgrade', shared);
    await item.service.schedule('two', 'upgrade', shared);
    await item.service.deleted('one');
    assert.deepEqual(item.calls.released, []);
    await item.service.deleted('two');
    assert.deepEqual(item.calls.released, [shared.key]);
    assert.deepEqual(item.calls.removed, []);
  } finally { await item.service.close(); await rm(item.directory, { recursive: true, force: true }); }
});

test('an explicitly queued archive release remains pinned by cleanup records', async () => {
  const item = await fixture();
  try {
    const saved = archive('old-sandbox');
    await item.service.schedule('old-sandbox', 'upgrade', saved);
    await item.service.queueArchiveRelease(saved);
    assert.deepEqual(item.calls.released, []);
    assert.equal(JSON.parse(await readFile(join(item.directory, 'cleanup.json'), 'utf8')).archiveReleases.length, 1);
    await item.service.deleted('old-sandbox');
    assert.deepEqual(item.calls.released, [saved.key]);
  } finally { await item.service.close(); await rm(item.directory, { recursive: true, force: true }); }
});

test('rescheduling a sandbox releases the superseded archive after the durable replacement', async () => {
  const item = await fixture();
  try {
    const previous = archive('old-sandbox');
    const replacement = { ...archive('old-sandbox'), key: '11111111-1111-4111-8111-111111111111.tar.gz' };
    await item.service.schedule('old-sandbox', 'upgrade', previous);
    await item.service.schedule('old-sandbox', 'upgrade', replacement);
    assert.deepEqual(item.calls.released, [previous.key]);
    assert.equal((await item.service.list())[0].archive?.key, replacement.key);
  } finally { await item.service.close(); await rm(item.directory, { recursive: true, force: true }); }
});

test('rescheduling keeps a superseded archive pinned while another cleanup still uses it', async () => {
  const item = await fixture();
  try {
    const shared = archive('first');
    const replacement = { ...archive('first'), key: '22222222-2222-4222-8222-222222222222.tar.gz' };
    await item.service.schedule('first', 'upgrade', shared);
    await item.service.schedule('second', 'upgrade', { ...shared, sourceSandboxId: 'second' });
    await item.service.schedule('first', 'upgrade', replacement);
    assert.deepEqual(item.calls.released, []);
    await item.service.deleted('second');
    assert.deepEqual(item.calls.released, [shared.key]);
  } finally { await item.service.close(); await rm(item.directory, { recursive: true, force: true }); }
});
