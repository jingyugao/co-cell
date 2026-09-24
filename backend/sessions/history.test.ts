import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Session, Settings, Turn } from '../../protocol/types.js';
import type { SandboxRuntime } from '../execution/container-runtime.js';
import { createArchiveReader, type ArchiveService } from '@co-cell/archives';
import { SessionManager, type CodexClient } from './manager.js';

const defaults: Settings = { executionMode: 'sandbox', workingDirectory: '/home/user/workspace', model: 'test',
  modelReasoningEffort: 'low', sandboxMode: 'danger-full-access', webSearchMode: 'disabled', networkAccessEnabled: true };
const answer = { id: 'answer', type: 'agent_message' as const, text: '2' };

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'hive-history-'));
  const runtime = {
    async close() {},
    async *run(_session: Session, _turn: Turn, _signal: AbortSignal, onSandbox: (value: Session['sandbox']) => Promise<void>) {
      await onSandbox({ id: 'test-sandbox', template: 'test', status: 'ready', workingDirectory: defaults.workingDirectory });
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
    const manager = new SessionManager({} as CodexClient, directory, defaults, runtime);
    managers.push(manager);
    await manager.init();
    return manager;
  };
  return { directory, runtime, start, async close() {
    for (const manager of managers) await manager.close();
    await rm(directory, { recursive: true, force: true });
  } };
}

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
    const path = join(f.directory, `${session.id}.json`);
    const legacy = JSON.parse(await readFile(path, 'utf8')) as Session;
    legacy.turns[0].prompt = '';
    legacy.turns[0].items = [];
    await writeFile(path, JSON.stringify(legacy));

    const second = await f.start();
    await second.read(session.id);
    assert.ok((await second.read(session.id)).historyError);
    f.runtime.history = async () => ({ turns: [{ ...complete.turns[0], id: 'native-turn' }] });
    const restored = await second.read(session.id);
    assert.equal(restored.historyError, undefined);
    assert.equal(restored.turns[0].prompt, '1+1等于几');
    const stored = JSON.parse(await readFile(path, 'utf8')) as Session;
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
    const path = join(f.directory, `${session.id}.json`);
    const stored = JSON.parse(await readFile(path, 'utf8')) as Session;
    const later: Turn = { ...stored.turns[0], id: 'later-turn', nativeTurnId: 'later-native', prompt: 'later prompt',
      startedAt: new Date(Date.parse(stored.turns[0].completedAt!) + 1000).toISOString(),
      completedAt: new Date(Date.parse(stored.turns[0].completedAt!) + 2000).toISOString() };
    stored.turns.push(later);
    await writeFile(path, JSON.stringify(stored));
    f.runtime.history = async () => ({ turns: [{ ...stored.turns[0], id: 'native-turn' }] });
    const second = await f.start();
    const page = await second.read(session.id);
    assert.equal(page.turns.length, 1);
    assert.equal(page.turns[0].id, 'native-turn');
    assert.equal((JSON.parse(await readFile(path, 'utf8')) as Session).turns.length, 2);
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
    const path = join(f.directory, 'projects', `${session.projectId}.json`);
    const project = JSON.parse(await readFile(path, 'utf8'));
    delete project.sandbox;
    project.status = 'archived';
    project.archivedAt = new Date().toISOString();
    await writeFile(path, JSON.stringify(project));
    f.runtime.history = async () => { assert.fail('must not try to wake an archived Sandbox'); };

    const second = await f.start();
    const snapshot = await second.read(session.id);
    assert.match(snapshot.historyError!, /Sandbox 尚未恢复/);
    assert.deepEqual(snapshot.turns, []);
  } finally { await f.close(); }
});

test('recovery detects a deleted container despite stale ready metadata and refuses an empty replacement without backup', async () => {
  const f = await fixture();
  try {
    const manager = await f.start();
    const session = await manager.create();
    await manager.startTurn(session.id, '1+1等于几');
    await manager.waitForIdle(session.id);
    f.runtime.inspect = async target => {
      await manager['updateSandbox'](session.projectId, session.id, { ...target.sandbox!, status: 'unavailable' });
      throw Object.assign(new Error('no such object: test-sandbox'), { code: 'not_accessible' });
    };
    f.runtime.createArchive = async () => { assert.fail('cannot back up a missing container'); };
    f.runtime.delete = async () => { assert.fail('must preserve the old reference without a backup'); };
    f.runtime.detachSandbox = async () => { assert.fail('must not detach without a backup'); };
    await assert.rejects(manager.archiveProjectNow(session.projectId!), /未找到可恢复的最新备份/);
    const project = manager.getProject(session.projectId!);
    assert.equal(project.status, 'active');
    assert.equal(project.sandbox?.id, 'test-sandbox');
    assert.equal(project.sandbox?.status, 'unavailable');
    assert.deepEqual(manager.get(session.id).turns[0].items, [answer]);
  } finally { await f.close(); }
});

test('recovery validates latest backup, preserves old binding until verified, and retries without archiving', async () => {
  const f = await fixture();
  try {
    const manager = await f.start();
    const session = await manager.create();
    await manager.startTurn(session.id, '1+1等于几');
    await manager.waitForIdle(session.id);
    const sandbox = manager.getProject(session.projectId!).sandbox!;
    await manager['updateSandbox'](session.projectId, session.id, { ...sandbox, status: 'unavailable' });
    const archivePath = join(f.directory, 'backup.tar.gz');
    await manager['projects'].saveArchiveKey(session.projectId!, 'archive-stream');
    const reader = createArchiveReader();
    manager['_archiveManager'] = {
      validate: reader.validate.bind(reader),
      restore: reader.restore.bind(reader),
      async getLatest() { return reader.artifactFromFile({ storagePath: archivePath, sizeBytes: 6,
        sha256: createHash('sha256').update('backup').digest('hex'), createdAt: new Date().toISOString() }); },
      async retain() {},
    } as unknown as ArchiveService;
    await assert.rejects(manager.rebuildProjectSandbox(session.projectId!), /最新备份不存在/);
    assert.equal(manager.getProject(session.projectId!).status, 'active');
    // The runtime stub verifies restoration; this fixture only needs a nonempty backup file.
    await writeFile(archivePath, 'backup');
    let detached = false, restored = false, creates = 0;
    f.runtime.detachSandbox = async target => { assert.equal(target.sandbox?.id, 'test-sandbox'); detached = true; };
    f.runtime.fenceSandbox = async () => {};
    f.runtime.deleteDanglingSandbox = async () => {};
    f.runtime.verifySandbox = async () => {};
    f.runtime.createReplacement = async (_target, save) => {
      creates++;
      assert.equal(detached, true);
      const candidate = { ...sandbox, id: `replacement-${creates}` };
      await save(candidate);
      return candidate;
    };
    f.runtime.restoreReplacement = async (candidate, path) => {
      assert.equal(candidate.id, `replacement-${creates}`);
      assert.equal(path, archivePath);
      assert.equal(manager.getProject(session.projectId!).status, 'active');
      assert.equal(manager.getProject(session.projectId!).sandbox?.id, 'test-sandbox');
      assert.equal(manager['projects'].isMaintaining(session.projectId!), true);
      if (!restored) { restored = true; throw new Error('copy interrupted'); }
      restored = true;
    };
    await assert.rejects(manager.rebuildProjectSandbox(session.projectId!), /copy interrupted/);
    assert.equal(manager.getProject(session.projectId!).status, 'active');
    assert.equal(manager.get(session.id).sandbox?.id, 'test-sandbox');
    assert.equal(manager['projects'].isMaintaining(session.projectId!), false);
    await manager.rebuildProjectSandbox(session.projectId!);
    assert.equal(creates, 2);
    assert.equal(restored, true);
    assert.equal(manager.getProject(session.projectId!).status, 'active');
    assert.equal(manager.getProject(session.projectId!).archivedAt, null);
    assert.equal(manager.getProject(session.projectId!).lifecycleHistory?.length ?? 0, 0);
    assert.equal(manager.getProject(session.projectId!).sandbox?.id, 'replacement-2');
    assert.equal(manager.get(session.id).threadId, 'original-thread');
  } finally { await f.close(); }
});
