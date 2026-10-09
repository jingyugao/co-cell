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

test('running Sandbox submission metadata is persisted before Codex accepts the turn', async () => {
  let document: Record<string, any> | undefined;
  const store = Object.create(MySqlWebStateStore.prototype) as MySqlWebStateStore;
  (store as unknown as { pool: { query: (sql: string, values?: unknown[]) => Promise<unknown> } }).pool = {
    async query(sql, values) {
      if (sql.startsWith('SELECT document FROM sessions')) return [[{ document }], []];
      document = JSON.parse(String(values?.[9]));
      return [[], []];
    },
  };
  const preparing: Session = { ...session, turns: [{ ...session.turns[0], codexAccepted: false, nativeTurnId: undefined,
    prompt: 'secret prompt', status: 'running', items: [{ id: 'partial', type: 'agent_message', text: 'must not persist' }] }] };
  await store.saveSession(preparing);
  assert.equal(document?.pendingTurns[0].status, 'running');
  assert.equal(document?.pendingTurns[0].codexAccepted, false);
  assert.equal('items' in document!.pendingTurns[0] && document!.pendingTurns[0].items.length, 0);
  const [restored] = await store.listSessions();
  assert.equal(restored.turns[0].codexAccepted, false);
  assert.equal(restored.turns[0].status, 'running');
});

test('shared storage round-trips live running items and clears them at terminal compaction', async () => {
  let document: Record<string, any> | undefined;
  const store = Object.create(MySqlWebStateStore.prototype) as MySqlWebStateStore;
  (store as unknown as { preserveLiveItems: boolean }).preserveLiveItems = true;
  (store as unknown as { pool: { query: (sql: string, values?: unknown[]) => Promise<unknown> } }).pool = {
    async query(sql, values) {
      if (sql.startsWith('SELECT document FROM sessions')) return [[{ document }], []];
      document = JSON.parse(String(values?.[9]));
      return [[], []];
    },
  };
  const liveItem = { id: 'live-item', type: 'agent_message' as const, text: 'command is in progress' };
  const running: Session = { ...session, turns: [{ ...session.turns[0], status: 'running', codexAccepted: true,
    items: [liveItem], itemTimestamps: { 'live-item': now } }] };
  await store.saveSession(running);
  assert.deepEqual(document?.pendingTurns[0].items, [liveItem]);
  assert.equal(document?.pendingTurns[0].itemTimestamps['live-item'], now);
  assert.deepEqual((await store.getSession(session.id))?.turns[0].items, [liveItem]);

  const terminal: Session = { ...running, status: 'completed', turns: [{ ...running.turns[0], status: 'completed',
    completedAt: '2026-09-24T00:01:00.000Z' }] };
  await store.saveSession(terminal);
  assert.deepEqual(document?.pendingTurns[0].items, []);
  assert.deepEqual(document?.pendingTurns[0].itemTimestamps, {});
  assert.deepEqual((await store.getSession(session.id))?.turns[0].items, []);
});

test('Sandbox storage keeps only the latest accepted terminal turn control metadata', async () => {
  let document: Record<string, any> | undefined;
  const store = Object.create(MySqlWebStateStore.prototype) as MySqlWebStateStore;
  (store as unknown as { pool: { query: (sql: string, values?: unknown[]) => Promise<unknown> } }).pool = {
    async query(sql, values) {
      document = JSON.parse(String(values?.[9]));
      return [[], []];
    },
  };
  const earlier = { ...session.turns[0], id: 'old-web-id', nativeTurnId: 'old-native-id', status: 'completed' as const,
    prompt: 'old private prompt', completedAt: now, items: [{ id: 'old-item', type: 'agent_message' as const, text: 'old private body' }] };
  const latest = { ...earlier, id: 'latest-web-id', nativeTurnId: 'latest-native-id', prompt: 'latest private prompt',
    completedAt: '2026-09-24T00:01:00.000Z', items: [{ id: 'latest-item', type: 'agent_message' as const, text: 'latest private body' }] };
  await store.saveSession({ ...session, status: 'completed', turns: [earlier, latest] });
  assert.deepEqual(document?.pendingTurns.map((turn: any) => ({ id: turn.id, nativeTurnId: turn.nativeTurnId, status: turn.status })), [
    { id: 'latest-web-id', nativeTurnId: 'latest-native-id', status: 'completed' },
  ]);
  assert.equal(document?.pendingTurns[0].completedAt, latest.completedAt);
  assert.equal(document?.pendingTurns[0].prompt, '');
  assert.deepEqual(document?.pendingTurns[0].items, []);
  assert.equal(JSON.stringify(document).includes('private'), false);
});

test('terminal compaction preserves a concurrent native answer only for the same pending turn IDs', async () => {
  const request = { id: 'question-1', questions: [{ title: 'Choose' }], status: 'pending' as const, createdAt: now };
  const baseline: Session = { ...session, turns: [{ ...session.turns[0], userInputRequests: [request] }] };
  const latest: Session = { ...baseline, turns: [{ ...baseline.turns[0], userInputRequests: [{ ...request,
    status: 'answered', answer: 'yes', answers: ['yes'], answeredAt: now, answerTurnId: 'reply-turn' }] }] };
  const terminal: Session = { ...session, status: 'completed', updatedAt: '2026-09-24T00:01:00.000Z',
    turns: [{ ...session.turns[0], status: 'completed', completedAt: '2026-09-24T00:01:00.000Z', userInputRequests: [request] }] };
  let stored = JSON.parse(JSON.stringify({ ...latest, turns: undefined,
    pendingTurns: latest.turns.map(turn => ({ ...turn, images: [], items: [], itemTimestamps: {} })) }));
  const connection = {
    async beginTransaction() {}, async commit() {}, async rollback() {}, release() {},
    async query(sql: string, values?: unknown[]) {
      if (sql.includes('FOR UPDATE')) return [[{ document: stored }], []];
      stored = JSON.parse(String(values?.[9]));
      return [[], []];
    },
  };
  const store = Object.create(MySqlWebStateStore.prototype) as MySqlWebStateStore;
  (store as unknown as { pool: unknown }).pool = { getConnection: async () => connection };
  await store.saveSession(terminal, baseline);
  const savedTurn = stored.pendingTurns[0];
  assert.equal(savedTurn.status, 'completed');
  assert.equal(savedTurn.userInputRequests[0].status, 'answered');
  assert.deepEqual(savedTurn.userInputRequests[0].answers, ['yes']);
  assert.equal(JSON.stringify(savedTurn).includes('private answer'), false);
});

test('terminal compaction keeps a queued reply until it can be delivered', async () => {
  const request = { id: 'question-queued', questions: [{ title: 'Choose' }], status: 'pending' as const, createdAt: now };
  const baseline: Session = { ...session, turns: [{ ...session.turns[0], userInputRequests: [request] }] };
  const terminal: Session = { ...session, status: 'completed', turns: [{ ...session.turns[0], status: 'completed',
    userInputRequests: [{ ...request, status: 'queued', answer: 'yes', answers: ['yes'], answeredAt: now }] }] };
  const compact = (value: Session) => JSON.parse(JSON.stringify({ ...value, turns: undefined,
    pendingTurns: value.turns.filter(turn => turn.status === 'running' || !!turn.userInputRequests?.length)
      .map(turn => ({ ...turn, images: [], items: [], itemTimestamps: {} })) }));
  let stored = compact(baseline);
  const connection = {
    async beginTransaction() {}, async commit() {}, async rollback() {}, release() {},
    async query(sql: string, values?: unknown[]) {
      if (sql.includes('FOR UPDATE')) return [[{ document: stored }], []];
      stored = JSON.parse(String(values?.[9]));
      return [[], []];
    },
  };
  const store = Object.create(MySqlWebStateStore.prototype) as MySqlWebStateStore;
  (store as unknown as { pool: { getConnection: () => Promise<unknown>; query: (sql: string, values?: unknown[]) => Promise<unknown> } }).pool = {
    getConnection: async () => connection,
    async query(sql) {
      if (sql.includes('WHERE id = ?')) return [[{ document: stored }], []];
      return [[{ document: stored }], []];
    },
  };
  await store.saveSession(terminal, baseline);
  assert.equal(stored.pendingTurns[0].status, 'completed');
  assert.equal(stored.pendingTurns[0].userInputRequests[0].status, 'queued');
  assert.deepEqual(stored.pendingTurns[0].userInputRequests[0].answers, ['yes']);
  assert.equal(stored.pendingTurns[0].items.length, 0);

  const previous = await store.getSession(session.id);
  assert.ok(previous);
  const nextTurn = { ...session.turns[0], id: 'next-turn', nativeTurnId: undefined, codexAccepted: false,
    status: 'running' as const, userInputRequests: undefined };
  const delivering: Session = { ...previous, status: 'running', updatedAt: '2026-09-24T00:02:00.000Z', turns: [
    { ...previous.turns[0], userInputRequests: [{ ...request, status: 'answered', answer: 'yes', answers: ['yes'], answeredAt: now }] },
    nextTurn,
  ] };
  await store.saveSession(delivering, previous);
  assert.equal(stored.pendingTurns.length, 2);
  assert.equal(stored.pendingTurns[0].userInputRequests[0].status, 'answered');
  assert.equal(stored.pendingTurns[1].id, 'next-turn');
});

test('legacy Sandbox session rows are compacted in memory without writes during read', async () => {
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
  assert.equal(writes.length, 0);
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

test('baseline project writes lock and merge the latest stored document before updating it', async () => {
  const baseline = { id: 'merge-project', name: 'before', requirementUrl: null, executionMode: 'sandbox',
    workingDirectory: '/workspace', createdAt: now, updatedAt: now } as Project;
  let stored: Record<string, unknown> = { ...baseline, description: 'written by another instance' };
  const connection = {
    async beginTransaction() {}, async commit() {}, async rollback() {}, release() {},
    async query(sql: string, values?: unknown[]) {
      if (sql.includes('FOR UPDATE')) return [[{ document: stored }], []];
      stored = JSON.parse(String(values?.[8])) as Record<string, unknown>;
      return [[], []];
    },
  };
  const store = Object.create(MySqlWebStateStore.prototype) as MySqlWebStateStore;
  (store as unknown as { pool: unknown }).pool = {
    getConnection: async () => connection,
  };
  await store.saveProject({ ...baseline, name: 'after' }, baseline);
  assert.equal(stored.name, 'after');
  assert.equal(stored.description, 'written by another instance');
});

test('legacy submissions without an accepted Codex turn are hidden without writes', async () => {
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
  assert.equal(writes.length, 0);
});
