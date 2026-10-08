import assert from 'node:assert/strict';
import test from 'node:test';
import { AppServerRpcError, CodexAppServerClient } from '../../packages/agentcore/src/index.mjs';
import { AppServerReader } from './app-server-reader.js';
import { SandboxLifecycle } from '@co-cell/sandbox';

test('concurrent reads share a connection; idle cleanup never delays results', async t => {
  let connects = 0, endpoints = 0, closes = 0;
  let finishCleanup!: () => void;
  const cleanup = new Promise<void>(resolve => { finishCleanup = resolve; });
  t.mock.method(CodexAppServerClient.prototype, 'connect', async () => { connects++; });
  t.mock.method(CodexAppServerClient.prototype, 'close', async () => { closes++; await cleanup; });
  const reader = new AppServerReader(async () => {
    endpoints++;
    return { url: 'ws://app-server.test' };
  }, error => assert.fail(String(error)), 10);
  try {
    const values = await Promise.all([
      reader.read('box-1', async client => client), reader.read('box-1', async client => client),
    ]);
    assert.equal(values[0], values[1]);
    assert.equal(connects, 1);
    assert.equal(endpoints, 1);
    assert.equal(closes, 0);
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(closes, 1);
    await reader.read('box-1', async () => 'reconnected after idle');
    assert.equal(connects, 2);
    assert.equal(endpoints, 2);
  } finally { finishCleanup(); await reader.close(); }
  assert.equal(closes, 2);
});

test('lifecycle fences reads, drains RPCs and sockets, and releases its fence after failure', async t => {
  const gate = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
  const entered = gate(), finishRead = gate(), closing = gate(), finishClose = gate();
  let connects = 0, closes = 0, operated = false;
  t.mock.method(CodexAppServerClient.prototype, 'connect', async () => { connects++; });
  t.mock.method(CodexAppServerClient.prototype, 'close', async () => { closes++; closing.resolve(); await finishClose.promise; });
  const reader = new AppServerReader(async () => ({ url: 'ws://app-server.test' }), error => assert.fail(String(error)));
  const lifecycle = new SandboxLifecycle([reader.extension]);
  try {
    const read = reader.read('box-1', async () => { entered.resolve(); await finishRead.promise; return 'history'; });
    await entered.promise;
    const operation = lifecycle.run({ action: 'checkpoint', resourceKey: 'p', sandboxId: 'box-1' }, async () => {
      operated = true;
      await assert.rejects(reader.read('box-1', async () => {}), /maintenance/);
      throw new Error('provider failed');
    });
    const failed = assert.rejects(operation, /provider failed/);
    await assert.rejects(reader.read('box-1', async () => {}), /maintenance/);
    assert.equal(closes, 0, 'Active read must finish before closing its socket');
    finishRead.resolve(); assert.equal(await read, 'history');
    await closing.promise; assert.equal(operated, false, 'Provider must wait for the close handshake');
    finishClose.resolve(); await failed;
    await reader.read('box-1', async () => 'new connection after failure');
    assert.equal(connects, 2);
    for (const action of ['pause', 'destroy', 'upgrade'] as const) {
      await lifecycle.run({ action, resourceKey: 'p', sandboxId: 'box-1' }, async () => {
        await assert.rejects(reader.read('box-1', async () => {}), /maintenance/);
      });
      await reader.read('box-1', async () => 'new connection');
    }
  } finally { finishRead.resolve(); finishClose.resolve(); await reader.close(); }
});

test('a later pre-hook failure releases the read fence without invoking the provider', async t => {
  t.mock.method(CodexAppServerClient.prototype, 'connect', async () => {});
  t.mock.method(CodexAppServerClient.prototype, 'close', async () => {});
  const reader = new AppServerReader(async () => ({ url: 'ws://app-server.test' }), error => assert.fail(String(error)));
  const lifecycle = new SandboxLifecycle([reader.extension, { name: 'reject', pre: async () => { throw new Error('configuration failure'); } }]);
  try {
    await reader.read('box-1', async () => {});
    await assert.rejects(lifecycle.run({ action: 'destroy', resourceKey: 'p', sandboxId: 'box-1' }, async () => assert.fail('must not run')), /reject pre failed/);
    await reader.read('box-1', async () => 'fence released');
  } finally { await reader.close(); }
});

test('RPC errors retain a connection; transport failure retires it without replaying a read', async t => {
  let connects = 0, closes = 0, calls = 0;
  t.mock.method(CodexAppServerClient.prototype, 'connect', async () => { connects++; });
  t.mock.method(CodexAppServerClient.prototype, 'close', async () => { closes++; });
  const reader = new AppServerReader(async () => ({ url: 'ws://app-server.test' }),
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
  assert.equal(closes, 3);
  await assert.rejects(reader.read('box-1', async () => undefined), /closed/);
});

test('cancelled read closes its socket and observes late RPC rejection without replay', async t => {
  let closes = 0;
  t.mock.method(CodexAppServerClient.prototype, 'connect', async () => {});
  t.mock.method(CodexAppServerClient.prototype, 'close', async () => { closes++; });
  const reader = new AppServerReader(async () => ({ url: 'ws://app-server.test' }), error => assert.fail(String(error)));
  const controller = new AbortController();
  let entered!: () => void;
  let failLate!: (error: Error) => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const rpc = new Promise<string>((_, reject) => { failLate = reject; });
  try {
    const read = reader.read('box', async () => { entered(); return rpc; }, controller.signal);
    const rejected = assert.rejects(read, /maintenance/);
    await started;
    controller.abort(new Error('maintenance'));
    await rejected;
    assert.equal(closes, 1);
    failLate(new Error('old connection closed'));
    assert.equal(await reader.read('box', async () => 'new history'), 'new history');
  } finally { await reader.close(); }
});

test('cancelling an opening connection does not wait for the connect timeout', async t => {
  let connecting!: () => void;
  const entered = new Promise<void>(resolve => { connecting = resolve; });
  let closes = 0;
  t.mock.method(CodexAppServerClient.prototype, 'connect', () => { connecting(); return new Promise<void>(() => {}); });
  t.mock.method(CodexAppServerClient.prototype, 'close', async () => { closes++; });
  const reader = new AppServerReader(async () => ({ url: 'ws://app-server.test' }), error => assert.fail(String(error)));
  const controller = new AbortController();
  try {
    const read = reader.read('box', async () => assert.fail('cancelled connection must not run RPCs'), controller.signal);
    const rejected = assert.rejects(read, /maintenance/);
    await entered;
    controller.abort(new Error('maintenance'));
    await rejected;
    assert.equal(closes, 1);
  } finally { await reader.close(); }
});
