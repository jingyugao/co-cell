import test from 'node:test';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { AppServerEventAdapter, CodexAppServerClient } from '../src/index.mjs';
const fake = fileURLToPath(new URL('./fake-server.mjs', import.meta.url));
const open = () => CodexAppServerClient.spawn({ command: process.execPath, args: [fake], requestTimeoutMs: 2000 });
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
