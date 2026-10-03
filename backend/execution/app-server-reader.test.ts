import assert from 'node:assert/strict';
import test from 'node:test';
import { AppServerRpcError, CodexAppServerClient } from '../../packages/agentcore/src/index.mjs';
import { AppServerReader } from './app-server-reader.js';

test('concurrent reads share a connection and grant; idle cleanup never delays results', async t => {
  let connects = 0, grants = 0, releases = 0;
  let finishCleanup!: () => void;
  const cleanup = new Promise<void>(resolve => { finishCleanup = resolve; });
  t.mock.method(CodexAppServerClient.prototype, 'connect', async () => { connects++; });
  const reader = new AppServerReader(async () => {
    grants++;
    return { url: 'ws://app-server.test', release: async () => { releases++; await cleanup; } };
  }, error => assert.fail(String(error)), 10);
  try {
    const values = await Promise.all([
      reader.read('box-1', async client => client), reader.read('box-1', async client => client),
    ]);
    assert.equal(values[0], values[1]);
    assert.equal(connects, 1);
    assert.equal(grants, 1);
    assert.equal(releases, 0);
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(releases, 1);
    await reader.read('box-1', async () => 'reconnected after idle');
    assert.equal(connects, 2);
    assert.equal(grants, 2);
  } finally { finishCleanup(); await reader.close(); }
  assert.equal(releases, 2);
});

test('RPC errors retain a connection; transport failure retires it without replaying a read', async t => {
  let connects = 0, releases = 0, calls = 0;
  t.mock.method(CodexAppServerClient.prototype, 'connect', async () => { connects++; });
  const reader = new AppServerReader(async () => ({ url: 'ws://app-server.test', release: async () => { releases++; } }),
    error => assert.fail(String(error)));
  try {
    await assert.rejects(reader.read('box-1', async () => {
      throw new AppServerRpcError({ code: -32602, message: 'missing thread' }, 'thread/read');
    }), /missing thread/);
    await reader.read('box-1', async () => 'same connection');
    assert.equal(connects, 1);
    await assert.rejects(reader.read('box-1', async () => {
      calls++;
      throw new Error('transport closed');
    }), /transport closed/);
    assert.equal(calls, 1);
    const client = await reader.read('box-1', async client => client);
    assert.equal(connects, 2);
    client.emit('closed', new Error('remote socket closed while idle'));
    await reader.read('box-1', async () => 'new connection after remote close');
    assert.equal(connects, 3);
  } finally { await reader.close(); }
  assert.equal(releases, 3);
  await assert.rejects(reader.read('box-1', async () => undefined), /closed/);
});
