import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Session } from '../../../protocol/types.js';
import { MySqlWebStateStore } from './web-state.js';

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
  await store.saveSession(session);
  assert.ok(document);
  assert.equal('turns' in document, false);
  assert.equal(JSON.stringify(document).includes('private answer'), false);
  const restored = await store.listSessions();
  assert.equal(restored.length, 1);
  assert.equal(restored[0].turns[0].nativeTurnId, 'native-turn');
  assert.equal(restored[0].turns[0].prompt, 'private prompt');
  assert.equal(writes.length, 1);
});

test('legacy Sandbox session rows are compacted when read', async () => {
  const writes: unknown[][] = [];
  const store = Object.create(MySqlWebStateStore.prototype) as MySqlWebStateStore;
  (store as unknown as { pool: { query: (sql: string, values?: unknown[]) => Promise<unknown> } }).pool = {
    async query(sql, values) {
      if (sql.startsWith('SELECT document FROM sessions')) return [[{ document: session }], []];
      writes.push(values ?? []);
      return [[], []];
    },
  };
  const restored = await store.listSessions();
  assert.equal(restored[0].turnCount, 1);
  assert.equal(writes.length, 1);
  assert.equal('turns' in JSON.parse(String(writes[0][9])), false);
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
