import test from 'node:test';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { AppServerEventAdapter, CodexAppServerClient } from '../src/index.mjs';
const fake = fileURLToPath(new URL('./fake-server.mjs', import.meta.url));
const open = () => CodexAppServerClient.spawn({ command: process.execPath, args: [fake], requestTimeoutMs: 2000 });
test('WebSocket close waits for peer acknowledgement and concurrent callers share completion', async () => {
 const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
 const received = gate(), acknowledge = gate();
 const server = createServer();
 let peer;
 server.on('upgrade', (request, socket) => {
  peer = socket;
  const accept = createHash('sha1').update(request.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  socket.once('data', () => { received.resolve(); void acknowledge.promise.then(() => socket.end(Buffer.from([0x88, 2, 3, 232]))); });
 });
 await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
 const client = new CodexAppServerClient();
 client.socket = new WebSocket(`ws://127.0.0.1:${server.address().port}`);
 try {
  await new Promise((resolve, reject) => { client.socket.addEventListener('open', resolve, { once: true }); client.socket.addEventListener('error', reject, { once: true }); });
  let finished = false;
  const first = client.close(); first.then(() => { finished = true; });
  assert.equal(client.close(), first);
  await received.promise; assert.equal(finished, false);
  acknowledge.resolve(); await first;
  assert.equal(client.socket.readyState, WebSocket.CLOSED);
 } finally { acknowledge.resolve(); peer?.destroy(); await client.close(); await new Promise(resolve => server.close(resolve)); }
});
test('concurrent request correlation, early notifications, server request replies', async () => {
 const client = await open();
 try {
  const stream = client.events();
  assert.deepEqual(await Promise.all([client.request('echo', { v: 1 }), client.request('echo', { v: 2 })]), [{ v: 1 }, { v: 2 }]);
  await client.request('burst');
  assert.equal((await stream.next()).value.params.value, 1);
  client.on('request', message => client.respond(message.id, { accepted: true }));
  await client.request('serverRequest');
  assert.deepEqual((await stream.next()).value.params.result, { accepted: true });
  const waiting = stream.next();
  await client.close();
  assert.equal((await waiting).done, true);
 } finally { await client.close(); }
});
test('exit rejects pending requests and wakes event readers', async () => {
 const client = await open();
 const stream = client.events();
 const read = assert.rejects(stream.next(), /exited|output closed/);
 await assert.rejects(client.request('die'), /exited|output closed/);
 await read;
 await client.close();
});
test('default unhandled server request gets explicit error without hanging', async () => {
 const client = await open();
 try {
  const stream = client.events(); await client.request('serverRequest');
  assert.equal((await stream.next()).value.params.error.code, -32601);
  await stream.return();
 } finally { await client.close(); }
});
test('adapter keeps delta snapshots immutable and emits compaction events', () => {
 const adapter = new AppServerEventAdapter();
 const first = adapter.accept({ method: 'item/started', params: { item: { type: 'agentMessage', id: 'a', text: '' } } })[0];
 const delta = adapter.accept({ method: 'item/agentMessage/delta', params: { itemId: 'a', delta: 'hi' } })[0];
 assert.equal(first.item.text, ''); assert.equal(delta.item.text, 'hi');
 assert.deepEqual(adapter.accept({ method: 'item/completed', params: { item: { type: 'contextCompaction', id: 'c' } } }), [{ type: 'item.completed', item: { id: 'c', type: 'context_compaction', status: 'completed' } }]);
 assert.equal(adapter.accept({ method: 'turn/completed', params: { turn: { status: 'interrupted' } } })[0].type, 'turn.failed');
});
test('native stdio initialize smoke (installed Codex, no model request)', { skip: spawnSync('codex', ['--version']).status !== 0 }, async () => {
 const client = await CodexAppServerClient.spawn({ requestTimeoutMs: 10_000 });
 try { const result = await client.request('model/list', { limit: 1 }); assert.ok(Array.isArray(result.data)); }
 finally { await client.close(); }
});
test('facade captures events arriving before turn/start response and resumes same thread', async () => {
 const { Codex } = await import('../src/index.mjs');
 const { mkdtemp, writeFile, chmod, rm } = await import('node:fs/promises');
 const { tmpdir } = await import('node:os');
 const { join } = await import('node:path');
 const directory = await mkdtemp(join(tmpdir(), 'agentcore-'));
 const command = join(directory, 'codex');
 await writeFile(command, `#!${process.execPath}\nimport(${JSON.stringify(new URL('./fake-server.mjs', import.meta.url).href)});\n`);
 await chmod(command, 0o700);
 const codex = new Codex({ codexPathOverride: command });
 try {
  const thread = codex.startThread();
  const events = [];
  for await (const event of (await thread.runStreamed('hello')).events) events.push(event);
  assert.equal(thread.id, 'thread-1');
  assert.deepEqual(events.map(event => event.type), ['thread.started', 'turn.started', 'item.started', 'item.updated', 'item.completed', 'turn.completed']);
  const resumed = codex.resumeThread(thread.id);
  for await (const event of (await resumed.runStreamed([{ type: 'local_image', path: '/tmp/example.png' }])).events) {}
  assert.equal(resumed.id, thread.id);
 } finally { await codex.close(); await rm(directory, { recursive: true, force: true }); }
});
test('native async questions survive live events and history conversion', () => {
 const adapter = new AppServerEventAdapter();
 const native = { type: 'agentMessage', id: 'call_native', text: '继续吗？', delivery: 'async', questions: [{ title: '继续吗？', options: ['继续', '停止'] }] };
 const event = adapter.accept({ method: 'item/completed', params: { item: native } })[0];
 assert.equal(event.item.delivery, 'async');
 assert.deepEqual(event.item.questions, native.questions);
 assert.deepEqual(new AppServerEventAdapter().convert(native), event.item);
});
test('resuming an existing thread applies the current model to the next turn', async () => {
 const { Codex } = await import('../src/index.mjs');
 const { mkdtemp, writeFile, readFile, chmod, rm } = await import('node:fs/promises');
 const { tmpdir } = await import('node:os');
 const { join } = await import('node:path');
 const directory = await mkdtemp(join(tmpdir(), 'agentcore-model-'));
 const command = join(directory, 'codex'), log = join(directory, 'requests.jsonl');
 await writeFile(command, `#!${process.execPath}\nimport(${JSON.stringify(new URL('./fake-server.mjs', import.meta.url).href)});\n`);
 await chmod(command, 0o700);
 const codex = new Codex({ codexPathOverride: command, env: { ...process.env, AGENTCORE_TEST_REQUEST_LOG: log } });
 try {
  const first = codex.startThread({ model: 'first-model' });
  for await (const event of (await first.runStreamed('first')).events) {}
  const resumed = codex.resumeThread(first.id, { model: 'corrected-model' });
  for await (const event of (await resumed.runStreamed('next')).events) {}
  const calls = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(calls.filter(call => call.method === 'turn/start').map(call => call.params.model), ['first-model', 'corrected-model']);
  assert.equal(calls.find(call => call.method === 'thread/resume').params.threadId, first.id);
 } finally { await codex.close(); await rm(directory, { recursive: true, force: true }); }
});
