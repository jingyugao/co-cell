import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { RawToolReader } from '../server/raw-tools.js';

const threadId = '01991111-2222-7333-8444-555555555555';
const otherThreadId = '01992222-2222-7333-8444-555555555555';
const line = (record: unknown) => `${JSON.stringify(record)}\n`;
const header = (id = threadId) => line({ type: 'session_meta', payload: { id } });
const tool = (payload: Record<string, unknown>) => ({
  timestamp: '2026-09-06T08:00:00.000Z', type: 'response_item', payload,
});
const call = (id: string) => tool({ type: 'function_call', name: 'exec_command', call_id: id, arguments: '{"cmd":"pwd"}' });

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'codex-raw-tools-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const home = join(directory, 'codex-home');
  const active = join(home, 'sessions', '2026', '09', '06');
  await mkdir(active, { recursive: true });
  const filename = `rollout-2026-09-06T08-00-00-${threadId}.jsonl`;
  const path = join(active, filename);
  return { directory, home, active, filename, path, reader: new RawToolReader(home) };
}

test('raw tool calls preserve original escaped input, JSON argument strings, and structured outputs', async t => {
  const { reader, path } = await fixture(t);
  const input = 'const r = await tools.apply_patch("*** Begin Patch\\n+你好 🌍\\n*** End Patch");\ntext(r);';
  const args = '{  "cmd" : "printf \\\"你好\\\\n\\\"", "metadata": [1, true] }';
  const output = [{ type: 'input_text', text: 'line one\n第二行\\literal' }, { type: 'image', image_url: 'data:image/png;base64,AAAA' }];
  const payloads = [
    { type: 'custom_tool_call', id: 'tool-id', call_id: 'a', name: 'exec', input, status: 'completed' },
    { type: 'custom_tool_call_output', call_id: 'a', output },
    { type: 'function_call', call_id: 'b', name: 'exec_command', arguments: args },
    { type: 'function_call_output', call_id: 'b', output: '{"exit_code":0,"output":"你好"}' },
  ];
  await writeFile(path, header() + payloads.map(payload => line(tool(payload))).join(''));
  const page = await reader.read(threadId);
  assert.equal(page.availability, 'available');
  assert.deepEqual(page.messages.map(message => message.payload), payloads);
  assert.equal(page.messages[0].timestamp, '2026-09-06T08:00:00.000Z');
  assert.equal(page.hasMore, false);
});

test('raw tool responses exclude chat, reasoning, context and internal metadata fields', async t => {
  const { reader, path } = await fixture(t);
  const forbidden = 'PRIVATE_NON_TOOL_CONTENT';
  const records = [
    tool({ type: 'message', role: 'user', content: [{ text: forbidden }] }),
    tool({ type: 'message', role: 'assistant', content: [{ text: forbidden }] }),
    tool({ type: 'reasoning', summary: [{ text: forbidden }] }),
    { type: 'turn_context', payload: { instructions: forbidden } },
    { type: 'event_msg', payload: { type: 'function_call', input: forbidden } },
    tool({ type: 'internal_chat_message_metadata_passthrough', content: forbidden }),
    tool({ type: 'function_call', call_id: 'a', name: 'exec_command', arguments: '{}', internal_chat_message_metadata_passthrough: forbidden, instructions: forbidden }),
  ];
  await writeFile(path, header() + records.map(line).join(''));
  const page = await reader.read(threadId);
  assert.deepEqual(page.messages.map(message => message.payload), [{ type: 'function_call', call_id: 'a', name: 'exec_command', arguments: '{}' }]);
  assert.equal(JSON.stringify(page).includes(forbidden), false);
  assert.equal(page.skippedLines, 0);
});

test('null threads are pending and unknown or not-yet-complete sessions remain readable on later polls', async t => {
  const { reader, path } = await fixture(t);
  const pending = await reader.read(null);
  assert.equal(pending.availability, 'pending');
  assert.deepEqual(pending.messages, []);
  assert.equal((await reader.read(threadId)).availability, 'missing');
  await writeFile(path, header().trimEnd());
  assert.equal((await reader.read(threadId)).availability, 'pending');
  await appendFile(path, '\n' + line(call('ready')));
  assert.equal((await reader.read(threadId)).messages[0].payload.call_id, 'ready');
});

test('polling waits for an entire final JSONL line, including when a Unicode character spans writes', async t => {
  const { reader, path } = await fixture(t);
  const prefix = header() + line(call('first'));
  const tail = Buffer.from(line(tool({ type: 'custom_tool_call_output', call_id: 'first', output: '结果 🌍' })));
  const split = tail.indexOf(Buffer.from('🌍')) + 2;
  await writeFile(path, Buffer.concat([Buffer.from(prefix), tail.subarray(0, split)]));
  const first = await reader.read(threadId);
  assert.equal(first.messages.length, 1);
  assert.equal(first.nextCursor, Buffer.byteLength(prefix));
  assert.equal(first.hasMore, false);
  const waiting = await reader.read(threadId, first.nextCursor);
  assert.equal(waiting.messages.length, 0);
  assert.equal(waiting.nextCursor, first.nextCursor);
  await appendFile(path, tail.subarray(split));
  const complete = await reader.read(threadId, waiting.nextCursor);
  assert.equal(complete.messages.length, 1);
  assert.equal(complete.messages[0].payload.output, '结果 🌍');
  assert.equal(complete.messages[0].id, String(Buffer.byteLength(prefix)));
  assert.equal(complete.nextCursor, Buffer.byteLength(prefix) + tail.length);
  assert.equal((await reader.read(threadId, complete.nextCursor)).messages.length, 0);
});

test('pagination delivers more than 100 messages once each using byte offsets and rejects invalid boundaries', async t => {
  const { reader, path } = await fixture(t);
  const records = Array.from({ length: 205 }, (_, index) => line(tool({ type: 'function_call_output', call_id: String(index), output: `结果 ${index} 🌍` })));
  const content = header() + records.join('');
  await writeFile(path, content);
  const first = await reader.read(threadId);
  assert.equal(first.messages.length, 100);
  assert.equal(first.hasMore, true);
  assert.equal(first.nextCursor, Buffer.byteLength(header() + records.slice(0, 100).join('')));
  const second = await reader.read(threadId, first.nextCursor);
  assert.equal(second.messages.length, 100);
  assert.equal(second.hasMore, true);
  const third = await reader.read(threadId, second.nextCursor);
  assert.equal(third.messages.length, 5);
  assert.equal(third.hasMore, false);
  assert.equal(third.nextCursor, Buffer.byteLength(content));
  const messages = [...first.messages, ...second.messages, ...third.messages];
  assert.deepEqual(messages.map(message => message.payload.call_id), records.map((_, index) => String(index)));
  let offset = Buffer.byteLength(header());
  for (let index = 0; index < messages.length; index++) {
    assert.equal(messages[index].id, String(offset));
    offset += Buffer.byteLength(records[index]);
  }
  for (const cursor of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1, first.nextCursor - 1]) {
    await assert.rejects(reader.read(threadId, cursor), { status: 400 });
  }
  await assert.rejects(reader.read(threadId, third.nextCursor + 1), { status: 409 });
});

test('thread validation and session lookup reject mismatches and do not follow symlinks or unrelated trees', async t => {
  const { reader, path, directory, home, active, filename } = await fixture(t);
  for (const id of ['../sessions/secret', '/tmp/secret.jsonl', 'not-a-uuid', `${threadId}/extra`]) {
    await assert.rejects(reader.read(id), { status: 400 });
  }
  await writeFile(path, header(otherThreadId) + line(call('wrong-thread')));
  await assert.rejects(reader.read(threadId), { status: 409 });
  await rm(path);
  const outside = join(directory, 'outside');
  await mkdir(outside);
  const outsidePath = join(outside, filename);
  await writeFile(outsidePath, header() + line(call('outside')));
  await symlink(outsidePath, path);
  assert.equal((await new RawToolReader(home).read(threadId)).availability, 'missing');
  await rm(path);
  await symlink(outside, join(active, 'linked-directory'));
  assert.equal((await new RawToolReader(home).read(threadId)).availability, 'missing');
  await rm(join(home, 'sessions'), { recursive: true });
  await symlink(outside, join(home, 'sessions'));
  assert.equal((await new RawToolReader(home).read(threadId)).availability, 'missing');
  await rm(join(home, 'sessions'));
  await mkdir(join(home, 'unrelated'), { recursive: true });
  await writeFile(join(home, 'unrelated', filename), header() + line(call('unrelated')));
  assert.equal((await new RawToolReader(home).read(threadId)).availability, 'missing');
});

test('archived sessions and a cached active session moved to archive retain tools around malformed lines', async t => {
  const { reader, path, home, filename } = await fixture(t);
  const initial = header() + line(call('before'));
  await writeFile(path, initial);
  const active = await reader.read(threadId);
  const archive = join(home, 'archived_sessions');
  await mkdir(archive);
  const archivedPath = join(archive, filename);
  await rename(path, archivedPath);
  await appendFile(archivedPath, '{malformed json}\n\n' + line(call('after')));
  const moved = await reader.read(threadId, active.nextCursor);
  assert.equal(moved.availability, 'available');
  assert.equal(moved.skippedLines, 1);
  assert.deepEqual(moved.messages.map(message => message.payload.call_id), ['after']);
  const fresh = await new RawToolReader(home).read(threadId);
  assert.deepEqual(fresh.messages.map(message => message.payload.call_id), ['before', 'after']);
  assert.equal(fresh.skippedLines, 1);
  assert.equal(fresh.nextCursor, moved.nextCursor);
});
