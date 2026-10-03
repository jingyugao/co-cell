import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Session, Settings, Turn } from '../../protocol/types.js';
import type { SandboxRuntime } from '../execution/container-runtime.js';
import { SessionManager, type CodexClient } from './manager.js';
import { MemoryWebStateStore } from '../testing/memory-web-state.js';
import { MySqlWebStateStore } from '../infra/storage/web-state.js';

const defaults: Settings = { executionMode: 'sandbox', workingDirectory: '/home/agent/workspace', model: 'test',
  modelReasoningEffort: 'low', sandboxMode: 'danger-full-access', webSearchMode: 'disabled', networkAccessEnabled: true };
const answer = { id: 'answer', type: 'agent_message' as const, text: '2' };

async function fixture(state = new MemoryWebStateStore()) {
  const directory = await mkdtemp(join(tmpdir(), 'hive-history-'));
  const providerSandboxes = new Map<string, NonNullable<Session['sandbox']>>();
  const runtime = {
    async close() {},
    async rebuild(_target: Parameters<SandboxRuntime['rebuild']>[0], save: Parameters<SandboxRuntime['rebuild']>[1]) {
      const sandbox = { id: 'test-sandbox', template: 'test', status: 'ready' as const, workingDirectory: defaults.workingDirectory };
      providerSandboxes.set(sandbox.id, sandbox);
      await save(sandbox);
    },
    async querySandbox(sandbox: NonNullable<Session['sandbox']>) {
      const provider = providerSandboxes.get(sandbox.id);
      if (!provider) throw new Error('Sandbox provider state unavailable');
      return { ...sandbox, status: provider.status };
    },
    async verifySandbox() {},
    async *run(_session: Session, _turn: Turn, _signal: AbortSignal, onSandbox: (value: Session['sandbox']) => Promise<void>) {
      const sandbox = { id: 'test-sandbox', template: 'test', status: 'ready' as const, workingDirectory: defaults.workingDirectory };
      providerSandboxes.set(sandbox.id, sandbox);
      await onSandbox(sandbox);
      yield { type: 'thread.started' as const, thread_id: 'original-thread' };
      yield { type: 'turn.started' as const, turn_id: 'native-turn' };
      yield { type: 'item.completed' as const, item: answer };
      yield { type: 'turn.completed' as const, usage: { input_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0,
        output_tokens: 1, reasoning_output_tokens: 0 } };
    },
    async history() { throw new Error('Sandbox is unavailable'); },
  } as unknown as SandboxRuntime;
  const managers: SessionManager[] = [];
  const start = async () => {
    const manager = new SessionManager({} as CodexClient, directory, defaults, state, runtime);
    managers.push(manager);
    await manager.init();
    return manager;
  };
  return { directory, runtime, state, start, async close() {
    for (const manager of managers) await manager.close();
    await rm(directory, { recursive: true, force: true });
  } };
}

test('async answers recover from native history across reload and pagination without new MySQL state', async () => {
  let document: unknown;
  const sql = Object.create(MySqlWebStateStore.prototype) as MySqlWebStateStore;
  (sql as unknown as { pool: { query: (query: string, values?: unknown[]) => Promise<unknown> } }).pool = {
    async query(query, values) {
      if (query.startsWith('SELECT document FROM sessions')) return [document ? [{ document }] : [], []];
      document = JSON.parse(String(values?.[9]));
      return [[], []];
    },
  };
  const state = new MemoryWebStateStore();
  state.saveSession = sql.saveSession.bind(sql);
  state.listSessions = sql.listSessions.bind(sql);
  const f = await fixture(state);
  try {
    let launches = 0;
    const question = { id: 'question', type: 'agent_message' as const, delivery: 'async', text: '',
      questions: [{ title: '检查哪项？', options: ['网络', '容器'] }] };
    f.runtime.run = async function* () {
      const count = ++launches;
      yield { type: 'thread.started', thread_id: 'original-thread' };
      yield { type: 'turn.started', turn_id: `native-${count}` };
      yield { type: 'item.completed', item: count === 1 ? question : answer };
      yield { type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0,
        output_tokens: 1, reasoning_output_tokens: 0 } };
    };
    const first = await f.start();
    const session = await first.create();
    const turnId = await first.startTurn(session.id, '检查环境');
    await first.waitForIdle(session.id);
    const nativeQuestion = { ...first.get(session.id).turns[0], id: 'native-1', userInputRequests: undefined };
    f.runtime.history = async () => ({ turns: [nativeQuestion] });
    const posted = await first.answerUserInput(session.id, turnId, question.id, '网络', ['网络']);
    await first.waitForIdle(session.id);
    assert.equal(posted.turns.find(turn => turn.id === turnId)?.userInputRequests?.[0].status, 'answered');
    const nativeReply = { ...first.get(session.id).turns[0], id: 'native-2', userInputRequests: undefined };
    f.runtime.history = async () => ({ turns: [nativeReply, nativeQuestion] });
    assert.equal((await first.read(session.id)).turns.find(turn => turn.items.some(item => item.id === question.id))?.userInputRequests?.[0].status, 'answered');
    await first.close();
    assert.equal('userInputTurns' in (document as object), false);
    assert.deepEqual((await state.listSessions())[0].turns, []);

    f.runtime.history = async (_session, options) => options?.cursor
      ? { turns: [nativeQuestion], nextCursor: null }
      : { turns: [nativeReply], nextCursor: 'older' };
    const second = await f.start();
    const reloaded = await second.read(session.id);
    const older = await second.olderTurns(session.id, reloaded.historyNextCursor!);
    assert.equal(older.turns[0].userInputRequests?.[0].answer, '网络');
    assert.equal(older.turns[0].userInputRequests?.[0].status, 'answered');
    await assert.rejects(second.answerUserInput(session.id, turnId, question.id, '容器'), /问题已经回答/);
    assert.equal(launches, 2);
  } finally { await f.close(); }
});

test('Sandbox history failure shows an error without serving the saved transcript', async () => {
  const f = await fixture();
  try {
    const first = await f.start();
    const session = await first.create();
    await first.startTurn(session.id, '1+1等于几');
    await first.waitForIdle(session.id);
    await first.close();

    const second = await f.start();
    const snapshot = await second.read(session.id);
    assert.deepEqual(snapshot.turns, []);
    assert.match(snapshot.historyError!, /历史消息暂时无法/);
  } finally { await f.close(); }
});

test('session read returns App Server history before the saved transcript', async () => {
  const f = await fixture();
  try {
    const first = await f.start();
    const session = await first.create();
    await first.startTurn(session.id, '1+1等于几');
    await first.waitForIdle(session.id);
    const completed = first.get(session.id);
    await first.close();

    const remoteAnswer = { ...answer, text: '来自 App Server 的回复' };
    f.runtime.history = async () => ({ turns: [{ ...completed.turns[0], id: 'native-turn', items: [remoteAnswer] }] });
    const second = await f.start();
    const snapshot = await second.read(session.id);
    assert.deepEqual(snapshot.turns[0].items, [remoteAnswer]);
    assert.equal(snapshot.historyError, undefined);
  } finally { await f.close(); }
});

test('Sandbox detail and older turns use App Server cursors', async () => {
  const f = await fixture();
  try {
    const manager = await f.start();
    const created = await manager.create();
    await manager.startTurn(created.id, 'first');
    await manager.waitForIdle(created.id);
    assert.equal(manager.list().find(item => item.id === created.id)?.turnCount, 1);
    const original = manager.get(created.id).turns[0];
    const seen: Array<{ cursor?: string; limit?: number } | undefined> = [];
    f.runtime.history = async (_session, options) => {
      seen.push(options);
      return options?.cursor === 'older'
        ? { turns: [{ ...original, id: 'old-turn', prompt: 'older' }], nextCursor: null }
        : { turns: [{ ...original, id: 'new-turn', prompt: 'newer' }], nextCursor: 'older' };
    };
    const detail = await manager.read(created.id);
    assert.deepEqual(detail.turns.map(turn => turn.prompt), ['newer']);
    assert.equal(detail.historyNextCursor, 'older');
    const older = await manager.olderTurns(created.id, detail.historyNextCursor!);
    assert.deepEqual(older.turns.map(turn => turn.prompt), ['older']);
    assert.equal(older.nextCursor, null);
    assert.deepEqual(seen, [{ limit: 20 }, { cursor: 'older', limit: 20 }]);
  } finally { await f.close(); }
});

test('a submission rejected before Codex accepts it is not retained after restart', async () => {
  const f = await fixture();
  try {
    f.runtime.run = async function* () { throw new Error('Sandbox creation failed'); };
    const first = await f.start();
    const created = await first.create();
    await first.startTurn(created.id, 'not delivered');
    await first.waitForIdle(created.id);
    assert.equal(first.get(created.id).turns[0].codexAccepted, false);
    await first.close();
    const second = await f.start();
    assert.equal(second.list().some(session => session.id === created.id), false);
  } finally { await f.close(); }
});

test('a successful App Server retry clears the history warning', async () => {
  const f = await fixture();
  try {
    const first = await f.start();
    const session = await first.create();
    await first.startTurn(session.id, '1+1等于几');
    await first.waitForIdle(session.id);
    const complete = first.get(session.id);
    await first.close();
    const legacy = (await f.state.listSessions()).find(value => value.id === session.id)!;
    legacy.turns[0].prompt = '';
    legacy.turns[0].items = [];
    await f.state.saveSession(legacy);

    const second = await f.start();
    await second.read(session.id);
    assert.ok((await second.read(session.id)).historyError);
    f.runtime.history = async () => ({ turns: [{ ...complete.turns[0], id: 'native-turn' }] });
    const restored = await second.read(session.id);
    assert.equal(restored.historyError, undefined);
    assert.equal(restored.turns[0].prompt, '1+1等于几');
    const stored = (await f.state.listSessions()).find(value => value.id === session.id)!;
    assert.equal(stored.turns[0].prompt, '');
    await second.close();

    f.runtime.history = async () => { throw new Error('Sandbox is unavailable again'); };
    const third = await f.start();
    assert.deepEqual((await third.read(session.id)).turns, []);
  } finally { await f.close(); }
});

test('a native history page does not append saved turns outside that page', async () => {
  const f = await fixture();
  try {
    const first = await f.start();
    const session = await first.create();
    await first.startTurn(session.id, '1+1等于几');
    await first.waitForIdle(session.id);
    await first.close();
    const stored = (await f.state.listSessions()).find(value => value.id === session.id)!;
    const later: Turn = { ...stored.turns[0], id: 'later-turn', nativeTurnId: 'later-native', prompt: 'later prompt',
      startedAt: new Date(Date.parse(stored.turns[0].completedAt!) + 1000).toISOString(),
      completedAt: new Date(Date.parse(stored.turns[0].completedAt!) + 2000).toISOString() };
    stored.turns.push(later);
    await f.state.saveSession(stored);
    f.runtime.history = async () => ({ turns: [{ ...stored.turns[0], id: 'native-turn' }] });
    const second = await f.start();
    const page = await second.read(session.id);
    assert.equal(page.turns.length, 1);
    assert.equal(page.turns[0].id, stored.turns[0].id);
    assert.equal(page.turns[0].nativeTurnId, 'native-turn');
    assert.equal((await f.state.listSessions()).find(value => value.id === session.id)!.turns.length, 2);
  } finally { await f.close(); }
});

test('an archived Sandbox reports that history cannot be loaded until restoration', async () => {
  const f = await fixture();
  try {
    const first = await f.start();
    const session = await first.create();
    await first.startTurn(session.id, '1+1等于几');
    await first.waitForIdle(session.id);
    await first.close();
    const project = (await f.state.listProjects()).find(value => value.id === session.projectId)!;
    delete project.sandbox;
    project.status = 'archived';
    project.archivedAt = new Date().toISOString();
    await f.state.saveProject(project);
    f.runtime.history = async () => { assert.fail('must not try to wake an archived Sandbox'); };

    const second = await f.start();
    const snapshot = await second.read(session.id);
    assert.match(snapshot.historyError!, /Sandbox 尚未恢复/);
    assert.deepEqual(snapshot.turns, []);
  } finally { await f.close(); }
});
