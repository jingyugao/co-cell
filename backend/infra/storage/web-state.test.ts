import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Project, Session } from '../../../protocol/types.js';
import { createWebStateStore, MySqlWebStateStore } from './web-state.js';

test('metadata storage requires MYSQL_URL and rejects invalid URLs without exposing credentials', () => {
  for (const value of [undefined, '', ' \t\n']) {
    assert.throws(() => createWebStateStore(value), /MYSQL_URL is required/);
  }
  for (const value of ['file:///tmp/state', 'postgres://user:secret@localhost/db', 'mysql://localhost', 'mysql://user:secret@host:invalid/db']) {
    assert.throws(() => createWebStateStore(value), error => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /MYSQL_URL must be a valid mysql:\/\/ URL/);
      assert.equal(error.message.includes('secret'), false);
      return true;
    });
  }
});

test('configured metadata storage is MySQL without connecting until initialization', async () => {
  const store = createWebStateStore('mysql://user:unused@database.invalid/cocell');
  assert.ok(store instanceof MySqlWebStateStore);
  await store.close();
});

test('database initialization failure propagates instead of falling back to local files', async () => {
  const store = Object.create(MySqlWebStateStore.prototype) as MySqlWebStateStore;
  const failure = new Error('Database unavailable');
  (store as unknown as { pool: { query: () => Promise<unknown> } }).pool = {
    async query() { throw failure; },
  };
  await assert.rejects(store.init(), error => error === failure);
});

const now = '2026-09-24T00:00:00.000Z';
const session: Session = {
  id: '00000000-0000-4000-8000-000000000001', projectId: '00000000-0000-4000-8000-000000000002',
  threadId: '00000000-0000-4000-8000-000000000003', title: 'task', status: 'running',
  startedAt: now, createdAt: now, updatedAt: now, archivedAt: null,
  settings: { executionMode: 'sandbox', workingDirectory: '/workspace', model: 'test', modelReasoningEffort: 'low',
    sandboxMode: 'danger-full-access', webSearchMode: 'disabled', networkAccessEnabled: true },
  turns: [{ id: 'web-turn', nativeTurnId: 'native-turn', codexAccepted: true, status: 'running', prompt: 'private prompt',
    images: [], items: [{ id: 'answer', type: 'agent_message', text: 'private answer' }], startedAt: now }],
};

test('MySQL session document keeps pending recovery data without completed conversation items', async () => {
  const writes: unknown[][] = [];
  let document: object | undefined;
  const store = Object.create(MySqlWebStateStore.prototype) as MySqlWebStateStore;
  (store as unknown as { pool: { query: (sql: string, values?: unknown[]) => Promise<unknown> } }).pool = {
    async query(sql, values) {
      if (sql.startsWith('SELECT document FROM sessions')) return [[{ document }], []];
      writes.push(values ?? []);
      document = JSON.parse(String(values?.[9]));
      return [[], []];
    },
  };
  const sandboxed: Session = { ...session, sandbox: { id: 'session-box', status: 'ready', statusError: 'transient',
    template: 'default', workingDirectory: '/workspace', lastActiveAt: now, pausedAt: now } as Session['sandbox'] };
  await store.saveSession(sandboxed);
  assert.ok(document);
  assert.equal('turns' in document, false);
  assert.equal(JSON.stringify(document).includes('private answer'), false);
  const persisted = document as Record<string, any>;
  assert.equal('status' in persisted.sandbox, false);
  assert.equal('statusError' in persisted.sandbox, false);
  assert.equal(sandboxed.sandbox?.status, 'ready');
  persisted.sandbox.status = 'unavailable';
  persisted.sandbox.statusError = 'old stored error';
  const restored = await store.listSessions();
  assert.equal(restored.length, 1);
  assert.equal(restored[0].turns[0].nativeTurnId, 'native-turn');
  assert.equal(restored[0].turns[0].prompt, 'private prompt');
  assert.equal(restored[0].sandbox?.status, 'unknown');
  assert.equal('statusError' in (restored[0].sandbox ?? {}), false);
  assert.equal(restored[0].sandbox?.lastActiveAt, now);
  assert.equal(writes.length, 1);
});

test('legacy Sandbox session rows are compacted when read', async () => {
  const writes: unknown[][] = [];
  const store = Object.create(MySqlWebStateStore.prototype) as MySqlWebStateStore;
  (store as unknown as { pool: { query: (sql: string, values?: unknown[]) => Promise<unknown> } }).pool = {
    async query(sql, values) {
      if (sql.startsWith('SELECT document FROM sessions')) return [[{ document: { ...session,
        sandbox: { id: 'legacy-box', status: 'paused', statusError: 'stale', template: 'default', workingDirectory: '/workspace' } } }], []];
      writes.push(values ?? []);
      return [[], []];
    },
  };
  const restored = await store.listSessions();
  assert.equal(restored[0].turnCount, 1);
  assert.equal(restored[0].sandbox?.status, 'unknown');
  assert.equal(writes.length, 1);
  assert.equal('turns' in JSON.parse(String(writes[0][9])), false);
  const compacted = JSON.parse(String(writes[0][9]));
  assert.equal('status' in compacted.sandbox, false);
  assert.equal('statusError' in compacted.sandbox, false);
});

test('project and pending cleanup sandbox payloads omit transient status without mutating inputs', async () => {
  const now = '2026-09-24T00:00:00.000Z';
  const project: Project = {
    id: '00000000-0000-4000-8000-000000000002', name: 'project', requirementUrl: null,
    executionMode: 'sandbox', workingDirectory: '/workspace', createdAt: now, updatedAt: now,
    sandbox: { id: 'project-box', status: 'ready', statusError: 'transient', template: 'default',
      workingDirectory: '/workspace', lastActiveAt: now } as Project['sandbox'],
    pendingSandboxCleanup: [{ id: 'cleanup-box', status: 'unavailable', statusError: 'transient', template: 'default',
      workingDirectory: '/workspace', pausedAt: now } as NonNullable<Project['sandbox']>],
  };
  let document: Record<string, any> | undefined;
  const store = Object.create(MySqlWebStateStore.prototype) as MySqlWebStateStore;
  (store as unknown as { pool: { query: (sql: string, values?: unknown[]) => Promise<unknown> } }).pool = {
    async query(sql, values) {
      if (sql.startsWith('SELECT document FROM projects')) return [[{ document }], []];
      document = JSON.parse(String(values?.[8]));
      return [[], []];
    },
  };
  await store.saveProject(project);
  assert.ok(document);
  assert.equal('status' in document.sandbox, false);
  assert.equal('statusError' in document.sandbox, false);
  assert.equal('status' in document.pendingSandboxCleanup[0], false);
  assert.equal('statusError' in document.pendingSandboxCleanup[0], false);
  assert.equal(project.sandbox?.status, 'ready');
  assert.equal(project.pendingSandboxCleanup?.[0].status, 'unavailable');

  document.sandbox.status = 'paused';
  document.sandbox.statusError = 'old status';
  document.pendingSandboxCleanup[0].status = 'ready';
  document.pendingSandboxCleanup[0].statusError = 'old cleanup status';
  const [restored] = await store.listProjects();
  assert.equal(restored.sandbox?.status, 'unknown');
  assert.equal(restored.pendingSandboxCleanup?.[0].status, 'unknown');
  assert.equal('statusError' in (restored.sandbox ?? {}), false);
  assert.equal('statusError' in (restored.pendingSandboxCleanup?.[0] ?? {}), false);
  assert.equal(restored.sandbox?.lastActiveAt, now);
  assert.equal(restored.pendingSandboxCleanup?.[0].pausedAt, now);

  const noSandbox: Project = { ...project, id: '00000000-0000-4000-8000-000000000004', sandbox: undefined, pendingSandboxCleanup: undefined };
  await store.saveProject(noSandbox);
  assert.ok(document);
  assert.equal('sandbox' in document, false);
  assert.equal('pendingSandboxCleanup' in document, false);
  const [restoredNoSandbox] = await store.listProjects();
  assert.equal(restoredNoSandbox.sandbox, undefined);
  assert.equal(restoredNoSandbox.pendingSandboxCleanup, undefined);
});

test('legacy submissions without an accepted Codex turn are hidden and compacted', async () => {
  const failed: Session = { ...session, threadId: null, status: 'failed', turns: [{ ...session.turns[0],
    codexAccepted: false, nativeTurnId: undefined, status: 'failed', items: [] }] };
  const writes: unknown[][] = [];
  const store = Object.create(MySqlWebStateStore.prototype) as MySqlWebStateStore;
  (store as unknown as { pool: { query: (sql: string, values?: unknown[]) => Promise<unknown> } }).pool = {
    async query(sql, values) {
      if (sql.startsWith('SELECT document FROM sessions')) return [[{ document: failed }], []];
      writes.push(values ?? []);
      return [[], []];
    },
  };
  assert.deepEqual(await store.listSessions(), []);
  assert.equal(writes.length, 1);
  assert.equal('turns' in JSON.parse(String(writes[0][9])), false);
});
