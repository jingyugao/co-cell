import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { AppNotification } from '../../protocol/notification-types.js';
import { NotificationStore } from './store.js';

class MemoryRepository {
  readonly items = new Map<string, AppNotification>();
  imports = 0;
  importFailure?: Error;
  writeFailure?: Error;

  async list(limit: number): Promise<AppNotification[]> {
    return [...this.items.values()]
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .slice(0, limit)
      .map(item => structuredClone(item));
  }

  async save(notification: AppNotification): Promise<void> {
    if (this.writeFailure) throw this.writeFailure;
    this.items.set(notification.id, structuredClone(notification));
  }

  async markRead(id: string, readAt: string): Promise<void> {
    if (this.writeFailure) throw this.writeFailure;
    const item = this.items.get(id);
    if (item && !item.readAt) item.readAt = readAt;
  }

  async importLegacy(notifications: AppNotification[]): Promise<void> {
    this.imports += 1;
    if (this.importFailure) throw this.importFailure;
    for (const notification of notifications) {
      const existing = this.items.get(notification.id);
      this.items.set(notification.id, structuredClone({ ...notification,
        ...(existing?.readAt ? { readAt: existing.readAt } : {}),
      }));
    }
  }
}

const notification: AppNotification = {
  id: 'legacy-notification', type: 'turn_completed', title: 'Finished', body: 'Task complete',
  sessionId: 'session-1', sessionTitle: 'Migration', projectName: 'CoCell', turnId: 'turn-1',
  createdAt: '2026-10-01T00:00:00.000Z',
};

test('legacy primary and temporary notifications migrate once and retain read state after restart', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'cocell-notifications-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'notifications.json');
  const readAt = '2026-10-02T00:00:00.000Z';
  const newer = { ...notification, id: 'temporary-notification', createdAt: '2026-10-03T00:00:00.000Z' };
  await writeFile(path, JSON.stringify([notification]));
  await writeFile(path + '.tmp', JSON.stringify([{ ...notification, readAt }, newer]));
  const repository = new MemoryRepository();
  const store = new NotificationStore(repository, path);

  await store.init();

  assert.deepEqual(await store.list(), [newer, { ...notification, readAt }]);
  assert.equal(repository.imports, 1);
  for (const source of [path, path + '.tmp']) {
    await assert.rejects(readFile(source), { code: 'ENOENT' });
  }
  const restarted = new NotificationStore(repository, path);
  await restarted.init();
  assert.deepEqual(await restarted.list(), [newer, { ...notification, readAt }]);
  assert.equal(repository.imports, 1);
});

test('failed database import preserves both legacy sources for a later successful attempt', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'cocell-notifications-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'notifications.json');
  const primary = JSON.stringify([notification]);
  const temporary = JSON.stringify([{ ...notification, readAt: '2026-10-02T00:00:00.000Z' }]);
  await writeFile(path, primary);
  await writeFile(path + '.tmp', temporary);
  const repository = new MemoryRepository();
  const failure = new Error('MySQL unavailable');
  repository.importFailure = failure;

  await assert.rejects(new NotificationStore(repository, path).init(), error => error === failure);

  assert.equal(await readFile(path, 'utf8'), primary);
  assert.equal(await readFile(path + '.tmp', 'utf8'), temporary);
  assert.equal(repository.items.size, 0);
  repository.importFailure = undefined;
  await new NotificationStore(repository, path).init();
  assert.equal(repository.items.size, 1);
  await assert.rejects(readFile(path), { code: 'ENOENT' });
});

test('a remaining temporary notification file migrates when the primary file is absent', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'cocell-notifications-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'notifications.json');
  await writeFile(path + '.tmp', JSON.stringify([notification]));
  const repository = new MemoryRepository();
  const store = new NotificationStore(repository, path);

  await store.init();

  assert.deepEqual(await store.list(), [notification]);
  await assert.rejects(readFile(path + '.tmp'), { code: 'ENOENT' });
});

test('corrupt primary or invalid notification data rejects migration and preserves every source', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'cocell-notifications-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'notifications.json');
  const temporary = JSON.stringify([notification]);
  await writeFile(path + '.tmp', temporary);
  for (const primary of ['{corrupt', '{}', JSON.stringify([{ ...notification, type: 'invalid' }]),
    JSON.stringify([{ ...notification, type: ['turn_completed'] }]),
    JSON.stringify([{ ...notification, sessionId: null }]),
    JSON.stringify([{ ...notification, createdAt: 'invalid date' }])]) {
    await writeFile(path, primary);
    const repository = new MemoryRepository();

    await assert.rejects(new NotificationStore(repository, path).init());

    assert.equal(await readFile(path, 'utf8'), primary);
    assert.equal(await readFile(path + '.tmp', 'utf8'), temporary);
    assert.equal(repository.imports, 0);
  }
});

test('notifications add, read, and list through the repository without recreating local files', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'cocell-notifications-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'notifications.json');
  const repository = new MemoryRepository();
  const store = new NotificationStore(repository, path);
  await store.init();
  const added = await store.add({ type: 'turn_failed', title: 'Failed', body: 'Try again',
    sessionId: 'session-2', sessionTitle: 'Task' });

  assert.deepEqual(repository.items.get(added.id), added);
  await store.markRead(added.id);
  const readAt = repository.items.get(added.id)?.readAt;
  assert.ok(readAt);
  await store.markRead(added.id);
  assert.equal(repository.items.get(added.id)?.readAt, readAt);
  await store.markRead('missing');
  assert.deepEqual(await store.list(1), [{ ...added, readAt }]);
  const restarted = new NotificationStore(repository, path);
  await restarted.init();
  assert.deepEqual(await restarted.list(), [{ ...added, readAt }]);
  assert.deepEqual(await restarted.list(0), []);
  for (const source of [path, path + '.tmp']) {
    await assert.rejects(readFile(source), { code: 'ENOENT' });
  }
});

test('notification writes propagate persistence failures instead of reporting success', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'cocell-notifications-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const repository = new MemoryRepository();
  const store = new NotificationStore(repository, join(directory, 'notifications.json'));
  await store.init();
  const added = await store.add({ type: 'turn_completed', title: 'Done', body: '',
    sessionId: 'session-3', sessionTitle: 'Task' });
  const failure = new Error('MySQL write failed');
  repository.writeFailure = failure;

  await assert.rejects(store.add({ type: 'turn_completed', title: 'Done', body: '',
    sessionId: 'session-3', sessionTitle: 'Task' }), error => error === failure);
  await assert.rejects(store.markRead(added.id), error => error === failure);
  assert.deepEqual(await store.list(), [added]);
});

test('closing notifications waits for accepted writes and rejects subsequent writes', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'cocell-notifications-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const repository = new MemoryRepository();
  const originalSave = repository.save.bind(repository);
  let completeWrite!: () => void;
  const writeGate = new Promise<void>(resolve => { completeWrite = resolve; });
  repository.save = async item => { await writeGate; await originalSave(item); };
  const store = new NotificationStore(repository, join(directory, 'notifications.json'));
  await store.init();
  const options = { type: 'turn_completed' as const, title: 'Done', body: '',
    sessionId: 'session-4', sessionTitle: 'Task' };
  const adding = store.add(options);
  let closed = false;
  const closing = store.close().then(() => { closed = true; });
  await Promise.resolve();

  assert.equal(closed, false);
  assert.equal(repository.items.size, 0);
  await assert.rejects(store.add(options), /closed/i);
  await assert.rejects(store.markRead('missing'), /closed/i);
  completeWrite();
  const added = await adding;
  await closing;
  assert.equal(closed, true);
  assert.deepEqual(repository.items.get(added.id), added);
});
