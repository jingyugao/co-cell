import assert from 'node:assert/strict';
import { createServer, request, type RequestListener } from 'node:http';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { gzipSync } from 'node:zlib';
import { startHttpCapture } from '../server/http-capture.js';

async function fixture(t: TestContext, listener: RequestListener) {
  const directory = await mkdtemp(join(tmpdir(), 'codex-http-capture-test-'));
  const upstream = createServer(listener);
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const address = upstream.address();
  assert.ok(address && typeof address !== 'string');
  const proxy = await startHttpCapture({ upstreamBaseUrl: `http://127.0.0.1:${address.port}/v1`, directory });
  t.after(async () => {
    await proxy.close();
    upstream.closeAllConnections();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  const metadata = async (name: string, number = '000001') => JSON.parse(await readFile(join(directory, number, name), 'utf8'));
  const body = (name: string, number = '000001') => readFile(join(directory, number, name));
  // A complete HTTP response can reach the client just before the final disk metadata write.
  async function settled(number = '000001') {
    for (let attempt = 0; attempt < 100; attempt++) {
      const meta = await metadata('response.json', number).catch(() => null);
      if (typeof meta?.complete === 'boolean') return meta;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('Capture metadata did not settle');
  }
  return { proxy, directory, metadata, body, settled };
}

test('HTTP capture forwards authentication and exact bodies but redacts credential metadata', async t => {
  const requestBytes = Buffer.from('{"input":"汉字\\n","stream":true}\n');
  const encodedResponse = gzipSync(Buffer.from('event: response.done\ndata: {"text":"原文"}\n\n'));
  let observed: Record<string, unknown> | undefined;
  const f = await fixture(t, async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    observed = { url: req.url, auth: req.headers.authorization, cookie: req.headers.cookie, key: req.headers['x-api-key'], body: Buffer.concat(chunks) };
    res.writeHead(200, { 'content-type': 'text/event-stream', 'content-encoding': 'gzip', 'set-cookie': 'session=response-secret', 'x-request-id': 'trace-123' });
    res.end(encodedResponse);
  });
  const received = await new Promise<Buffer>((resolve, reject) => {
    const req = request(`${f.proxy.baseUrl}/responses?api_key=query-secret&visible=yes`, { method: 'POST', headers: { authorization: 'Bearer auth-secret', cookie: 'session=cookie-secret', 'x-api-key': 'key-secret', 'content-type': 'application/json' } }, res => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('error', reject); req.end(requestBytes);
  });
  assert.deepEqual(received, encodedResponse);
  await f.settled();
  assert.deepEqual(observed, { url: '/v1/responses?api_key=query-secret&visible=yes', auth: 'Bearer auth-secret', cookie: 'session=cookie-secret', key: 'key-secret', body: requestBytes });
  assert.deepEqual(await f.body('request.body'), requestBytes);
  assert.deepEqual(await f.body('response.body'), encodedResponse);
  const requestMeta = await f.metadata('request.json');
  const responseMeta = await f.metadata('response.json');
  assert.equal(requestMeta.headers.authorization, '[REDACTED]');
  assert.equal(requestMeta.headers.cookie, '[REDACTED]');
  assert.equal(requestMeta.headers['x-api-key'], '[REDACTED]');
  assert.equal(responseMeta.headers['set-cookie'], '[REDACTED]');
  assert.equal(responseMeta.headers['content-encoding'], 'gzip');
  assert.equal(responseMeta.headers['x-request-id'], 'trace-123');
  assert.doesNotMatch(JSON.stringify([requestMeta, responseMeta]), /auth-secret|cookie-secret|key-secret|query-secret|response-secret/);
  assert.equal(requestMeta.complete, true);
  assert.equal(responseMeta.bytes, encodedResponse.length);
  assert.equal(responseMeta.upstreamComplete, true);
  assert.equal(responseMeta.clientAborted, false);
  assert.equal(responseMeta.terminationReason, 'upstream-ended');
  for (const path of [f.directory, join(f.directory, '000001')]) assert.equal((await stat(path)).mode & 0o777, 0o700);
  for (const name of ['request.json', 'request.body', 'response.json', 'response.body']) assert.equal((await stat(join(f.directory, '000001', name))).mode & 0o777, 0o600);
});

test('HTTP capture streams SSE immediately and preserves all event bytes', async t => {
  let finish: (() => void) | undefined;
  const first = 'event: response.output_text.delta\ndata: {"delta":"first"}\n\n';
  const last = 'event: response.completed\ndata: {"done":true}\n\n';
  const f = await fixture(t, (req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(first);
    finish = () => res.end(last);
  });
  const response = await fetch(`${f.proxy.baseUrl}/responses`, { method: 'POST', body: '{}' });
  const reader = response.body!.getReader();
  const initial = await reader.read();
  assert.equal(Buffer.from(initial.value!).toString(), first);
  assert.equal(initial.done, false);
  assert.ok(finish, 'upstream still waits for client to observe the first chunk');
  finish();
  const chunks = [Buffer.from(initial.value!)];
  for (;;) { const part = await reader.read(); if (part.done) break; chunks.push(Buffer.from(part.value)); }
  assert.equal(Buffer.concat(chunks).toString(), first + last);
  await f.settled();
  assert.equal((await f.body('response.body')).toString(), first + last);
});

test('HTTP capture forwards non-200 status and redirect response without following it', async t => {
  let requests = 0;
  const f = await fixture(t, (req, res) => {
    requests++; req.resume();
    if (req.url?.endsWith('/redirect')) { res.writeHead(307, { location: '/elsewhere?access_token=hidden' }); res.end('redirect'); }
    else { res.writeHead(429, { 'retry-after': '7', 'content-type': 'application/json' }); res.end('{"error":"rate limited"}'); }
  });
  const failed = await fetch(`${f.proxy.baseUrl}/responses`, { method: 'POST', body: '{}' });
  assert.equal(failed.status, 429);
  assert.equal(failed.headers.get('retry-after'), '7');
  assert.equal(await failed.text(), '{"error":"rate limited"}');
  assert.equal((await f.settled()).status, 429);
  const redirected = await fetch(`${f.proxy.baseUrl}/redirect`, { redirect: 'manual' });
  assert.equal(redirected.status, 307);
  assert.equal(redirected.headers.get('location'), '/elsewhere?access_token=hidden');
  assert.equal(await redirected.text(), 'redirect');
  assert.doesNotMatch(JSON.stringify(await f.settled('000002')), /hidden/);
  assert.equal(requests, 2);
});

test('HTTP capture records upstream disconnects and shuts down without hanging', async t => {
  const f = await fixture(t, (req, res) => { req.resume(); res.destroy(); });
  const response = await fetch(`${f.proxy.baseUrl}/responses`, { method: 'POST', body: '{}' });
  assert.equal(response.status, 502);
  await response.text();
  const metadata = await f.settled();
  assert.equal(metadata.complete, false);
  assert.equal(metadata.upstreamComplete, false);
  assert.equal(metadata.clientAborted, false);
  assert.equal(metadata.terminationReason, 'upstream-error');
});

test('HTTP capture aborts upstream response when its client cancels', async t => {
  let disconnected!: () => void;
  const disconnect = new Promise<void>(resolve => { disconnected = resolve; });
  const f = await fixture(t, (req, res) => {
    req.resume(); res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: start\n\n');
    res.on('close', disconnected);
  });
  const response = await fetch(`${f.proxy.baseUrl}/responses`);
  const reader = response.body!.getReader();
  await reader.read();
  await reader.cancel();
  await disconnect;
  const metadata = await f.settled();
  assert.equal(metadata.complete, false);
  assert.equal(metadata.clientAborted, true);
  assert.equal(metadata.terminationReason, 'client-disconnected');
});
