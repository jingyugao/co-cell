import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, open, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import type { Thread, ThreadEvent } from '@openai/codex-sdk';
import { RuntimeLog } from '../server/runtime-log.js';
import { SessionManager, type CodexClient } from '../server/manager.js';
import type { Settings } from '../shared/types.js';

async function directory(t: TestContext) {
  const path = await mkdtemp(join(tmpdir(), 'codex-runtime-log-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}
const filename = (daysAgo = 0) => `runtime-${new Date(Date.now() - daysAgo * 86400000).toISOString().slice(0, 10)}.jsonl`;
async function records(path: string) {
  return (await readFile(join(path, filename()), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
}

test('concurrent logging appends valid ordered JSONL with bounded metadata and redacted credentials', async t => {
  const path = await directory(t);
  await chmod(path, 0o777);
  const logger = new RuntimeLog({ directory: path, secrets: ['known-private-key'] });
  const circular: Record<string, unknown> = { item: 'first' };
  circular.self = circular;
  const operations = Array.from({ length: 25 }, (_, index) => logger.write({
    event: 'probe', index, error: 'line 1\nline 2\u2028Bearer bearer-private token=token-private password=password-private known-private-key',
    nested: { api_key: 'private-api', accessToken: 'private-access', password: 'private-password', token: 'private-token', prompt: 'business-prompt', arguments: { source: 'private-tool-args' } },
    content: 'business-answer', long: 'a'.repeat(10000), circular, huge: 42n,
    deep: { a: { b: { c: { d: { e: { privateValue: 'too-deep' } } } } } },
  }));
  await Promise.all(operations);
  await logger.flush();
  const text = await readFile(join(path, filename()), 'utf8');
  const lines = await records(path);
  assert.equal(lines.length, 25);
  assert.deepEqual(lines.map(row => row.index), Array.from({ length: 25 }, (_, index) => index));
  assert.doesNotMatch(text, /known-private-key|bearer-private|token-private|password-private|private-api|private-access|private-password|private-token|business-prompt|private-tool-args|business-answer|too-deep/);
  assert.match(text, /REDACTED/);
  assert.match(text, /OMITTED/);
  assert.match(text, /CIRCULAR/);
  assert.match(text, /TRUNCATED/);
  assert.ok(lines[0].long.length < 4200);
  assert.equal((await stat(path)).mode & 0o777, 0o700);
  assert.equal((await stat(join(path, filename()))).mode & 0o777, 0o600);
  assert.ok(Date.parse(lines[0].timestamp));
});

test('20 MiB rotation keeps one archive and seven-day retention removes only owned log names', async t => {
  const path = await directory(t);
  const current = join(path, filename());
  const max = 20 * 1024 * 1024;
  const fill = async () => { const file = await open(current, 'a'); try { await file.truncate(max); } finally { await file.close(); } };
  await writeFile(current, 'original-generation\n', { mode: 0o666 });
  await fill();
  const old = filename(10), boundary = filename(7), retained = filename(6);
  await Promise.all([old, `${old}.1`, boundary, retained, 'application.jsonl', 'runtime-not-a-date.jsonl'].map(name => writeFile(join(path, name), 'keep-or-expire')));
  const logger = new RuntimeLog({ directory: path });
  await logger.write({ event: 'first' });
  assert.equal((await stat(`${current}.1`)).size, max);
  assert.equal((await stat(`${current}.1`)).mode & 0o777, 0o600);
  assert.equal((await records(path))[0].event, 'first');
  await fill();
  await logger.write({ event: 'second' });
  const archive = await open(`${current}.1`, 'r');
  try {
    const buffer = Buffer.alloc(256);
    await archive.read(buffer, 0, buffer.length, 0);
    assert.match(buffer.toString(), /"event":"first"/);
  } finally { await archive.close(); }
  assert.equal((await records(path))[0].event, 'second');
  const names = await readdir(path);
  assert.ok(!names.includes(old) && !names.includes(`${old}.1`) && !names.includes(boundary));
  assert.ok(names.includes(retained) && names.includes('application.jsonl') && names.includes('runtime-not-a-date.jsonl'));
  assert.equal(names.filter(name => name.startsWith(filename())).length, 2);
});

test('write failure warns once without rejecting and subsequent writes recover', async t => {
  const root = await directory(t), path = join(root, 'not-directory');
  await writeFile(path, 'blocking-file');
  const warnings: unknown[][] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { warnings.push(args); });
  const logger = new RuntimeLog({ directory: path, secrets: ['private-secret'] });
  await Promise.all([logger.write({ error: 'private-secret' }), logger.write({ error: 'again' })]);
  const malformed = Object.defineProperty({}, 'error', { enumerable: true, get() { throw new Error('private-secret'); } });
  await logger.write(malformed);
  await logger.flush();
  assert.equal(warnings.length, 1);
  assert.doesNotMatch(JSON.stringify(warnings), /private-secret|blocking-file|not-directory/);
  await rm(path);
  await logger.write({ event: 'recovered' });
  assert.equal((await records(path))[0].event, 'recovered');
});

const completed: ThreadEvent = { type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, cache_write_input_tokens: 0, reasoning_output_tokens: 0 } };
async function managerFixture(t: TestContext, logger: RuntimeLog, events: () => AsyncGenerator<ThreadEvent>) {
  const root = await directory(t);
  const settings: Settings = { executionMode: 'local', workingDirectory: root, model: 'test-model', modelReasoningEffort: 'medium', sandboxMode: 'workspace-write', webSearchMode: 'disabled', networkAccessEnabled: false };
  const thread = { runStreamed: async () => ({ events: events() }) } as unknown as Thread;
  const client: CodexClient = { startThread: () => thread, resumeThread: () => thread };
  const manager = new SessionManager(client, join(root, 'sessions'), settings, undefined, undefined, logger);
  await manager.init();
  t.after(() => manager.close());
  return manager;
}

test('manager logs lifecycle, concrete SDK errors and tool metadata without prompts or model/tool bodies', async t => {
  const path = await directory(t);
  const logger = new RuntimeLog({ directory: path, secrets: ['private-api-key'] });
  const detail = 'Selected model is at capacity. Please try a different model.';
  const manager = await managerFixture(t, logger, async function* () {
    yield { type: 'thread.started', thread_id: 'thread-id' };
    yield { type: 'error', message: 'Retry request with Bearer private-api-key' };
    yield { type: 'item.completed', item: { type: 'command_execution', id: 'tool-id', status: 'completed', command: 'private-command', aggregated_output: 'private-tool-output', exit_code: 0 } };
    yield { type: 'item.completed', item: { type: 'agent_message', id: 'answer', text: 'private-model-answer' } };
    yield { type: 'turn.failed', error: { message: detail } };
    throw new Error('Codex exec exited with code 1');
  });
  const session = await manager.create();
  const turnId = await manager.startTurn(session.id, 'private-user-prompt');
  await manager.waitForIdle(session.id);
  await manager.close();
  const rows = await records(path);
  assert.deepEqual(rows.map(row => row.event), ['turn.started', 'sdk.error', 'tool.completed', 'turn.failed', 'turn.finished']);
  assert.ok(rows.every(row => row.sessionId === session.id && row.turnId === turnId && row.runtime === 'local' && row.model === 'test-model'));
  assert.equal(rows[2].toolType, 'command_execution');
  assert.equal(rows[2].toolId, 'tool-id');
  assert.equal(rows[2].exitCode, 0);
  assert.equal(rows.at(-1).threadId, 'thread-id');
  assert.equal(rows.at(-1).status, 'failed');
  assert.equal(rows.at(-1).error, detail);
  assert.ok(rows.at(-1).durationMs >= 0);
  assert.doesNotMatch(JSON.stringify(rows), /private-user-prompt|private-model-answer|private-command|private-tool-output|private-api-key/);
});

test('logger filesystem failure does not change successful manager turn status or prevent shutdown', async t => {
  const root = await directory(t), path = join(root, 'blocking-file');
  await writeFile(path, 'unwritable-directory');
  t.mock.method(console, 'error', () => {});
  const logger = new RuntimeLog({ directory: path });
  const manager = await managerFixture(t, logger, async function* () { yield completed; });
  const session = await manager.create();
  await manager.startTurn(session.id, 'Complete normally');
  await manager.waitForIdle(session.id);
  await manager.close();
  assert.equal(manager.get(session.id).status, 'completed');
  assert.equal(manager.get(session.id).turns[0].error, undefined);
});
