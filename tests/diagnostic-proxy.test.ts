import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
// @ts-expect-error The sandbox worker imports this standalone JavaScript module directly.
import { startDiagnosticProxy } from '../server/diagnostic-proxy.mjs';

type Event = Record<string, any>;
async function fixture(handler: http.RequestListener, secrets: string[] = [], overloadRetries?: Record<string, unknown>) {
  const events: Event[] = [];
  const server = http.createServer(handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  const proxy = await startDiagnosticProxy({ upstreamBaseUrl: `http://127.0.0.1:${address.port}/v1/`, secrets, overloadRetries, onEvent: (event: Event) => events.push(event) }) as { baseUrl: string; close(): Promise<void> };
  return { ...proxy, events, async dispose() { await proxy.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
const body = JSON.stringify({ model: 'test-model', input: [{ content: 'PRIVATE USER BODY' }], tools: [{ description: 'PRIVATE TOOL DEFINITION' }] });
const post = (baseUrl: string) => fetch(`${baseUrl}/responses`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer PRIVATE_AUTH' }, body });
const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test('streams bytes immediately and records completion without request, model, tool, or auth content', async () => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let observedBody = '', observedPath = '', encoding = '', authorization = '';
  const first = frame({ type: 'response.output_text.delta', delta: 'PRIVATE MODEL OUTPUT' });
  const last = frame({ type: 'response.completed', response: { output: [{ arguments: 'PRIVATE TOOL ARGUMENTS' }] } });
  const f = await fixture(async (req, res) => {
    observedPath = req.url!; encoding = req.headers['accept-encoding']!; authorization = req.headers.authorization!;
    for await (const chunk of req) observedBody += chunk;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'x-request-id': 'req-safe-123', 'x-private-header': 'PRIVATE HEADER' });
    res.write(first); await pending; res.end(last);
  });
  try {
    const response = await post(f.baseUrl);
    const reader = response.body!.getReader();
    const chunk = await reader.read();
    assert.equal(new TextDecoder().decode(chunk.value), first);
    assert.equal(f.events.some(e => e.event === 'api.end'), false);
    release();
    let rest = ''; for (;;) { const chunk = await reader.read(); if (chunk.done) break; rest += new TextDecoder().decode(chunk.value); }
    assert.equal(rest, last); assert.equal(observedBody, body); assert.equal(observedPath, '/v1/responses');
    assert.equal(encoding, 'identity'); assert.equal(authorization, 'Bearer PRIVATE_AUTH');
    assert.equal(f.events.filter(e => e.event === 'api.completed').length, 1);
    assert.equal(f.events.at(-1)!.reason, 'response.completed');
    assert.equal(f.events.at(-1)!.requestBytes, Buffer.byteLength(body));
    assert.equal(f.events.at(-1)!.responseBytes, Buffer.byteLength(first + last));
    assert.equal(f.events.find(e => e.event === 'api.response')!.requestIds['x-request-id'], 'req-safe-123');
    assert.ok(!JSON.stringify(f.events).includes('PRIVATE'));
  } finally { release(); await f.dispose(); }
});

test('fragmented CRLF SSE response.failed is diagnosed inside HTTP 200 with bounded redacted error fields', async () => {
  const payload = `event: response.failed\r\ndata: ${JSON.stringify({ type: 'response.failed', response: { error: { type: 'server_error', code: 'capacity', message: '繁忙 secret-value Bearer abc123 token=foo password="bar" api_key=baz ' + 'x'.repeat(500), extra: 'PRIVATE ERROR DETAIL' }, output: ['PRIVATE RESPONSE'] } })}\r\n\r\n`;
  const f = await fixture(async (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const byte of Buffer.from(payload)) res.write(Buffer.from([byte])); res.end();
  }, ['secret-value']);
  try {
    assert.equal(await (await post(f.baseUrl)).text(), payload);
    const error = f.events.find(e => e.event === 'api.error')!.error;
    assert.equal(error.code, 'capacity'); assert.equal(error.type, 'server_error'); assert.ok(error.message.startsWith('繁忙'));
    assert.ok(error.message.length <= 400);
    for (const value of ['secret-value', 'abc123', 'foo', 'bar', 'baz', 'PRIVATE']) assert.ok(!JSON.stringify(f.events).includes(value), value);
    assert.equal(f.events.at(-1)!.reason, 'response.failed');
  } finally { await f.dispose(); }
});

test('401 JSON errors expose only sanitized error fields and preserve transport response', async () => {
  const payload = JSON.stringify({ error: { message: 'Incorrect API key: sk-private123', type: 'invalid_request_error', code: 'invalid_api_key', request: body }, extra: 'PRIVATE DATA' });
  const f = await fixture((_req, res) => res.writeHead(401, { 'content-type': 'application/json' }).end(payload));
  try {
    const response = await post(f.baseUrl); assert.equal(response.status, 401); assert.equal(await response.text(), payload);
    const error = f.events.find(e => e.event === 'api.error')!; assert.equal(error.status, 401); assert.equal(error.error.code, 'invalid_api_key');
    assert.ok(!JSON.stringify(f.events).includes('sk-private123')); assert.ok(!JSON.stringify(f.events).includes('PRIVATE'));
  } finally { await f.dispose(); }
});

test('SSE incomplete and bare error events are terminal failures', async () => {
  for (const object of [
    { type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' } } },
    { type: 'error', code: 'upstream_capacity', message: 'Selected model is at capacity' },
  ]) {
    const f = await fixture((_req, res) => res.writeHead(200, { 'content-type': 'text/event-stream' }).end(frame(object)));
    try { await (await post(f.baseUrl)).text(); assert.equal(f.events.at(-1)!.reason, object.type); assert.equal(f.events.filter(e => e.event === 'api.error').length, 1); }
    finally { await f.dispose(); }
  }
});

test('clean EOF without Responses terminal event is distinct from a broken upstream connection', async () => {
  const clean = await fixture((_req, res) => res.writeHead(200, { 'content-type': 'text/event-stream' }).end(frame({ type: 'response.created' }) + 'data: [DONE]\n\n'));
  try { await (await post(clean.baseUrl)).text(); assert.equal(clean.events.at(-1)!.reason, 'eof_before_terminal'); }
  finally { await clean.dispose(); }
  const broken = await fixture(async (_req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(frame({ type: 'response.created' })); await wait(20); res.destroy(); });
  try {
    await assert.rejects(async () => { await (await post(broken.baseUrl)).text(); });
    assert.equal(broken.events.at(-1)!.reason, 'transport_error');
    assert.equal(broken.events.find(e => e.event === 'api.error')!.error.code, 'upstream_disconnected');
  } finally { await broken.dispose(); }
});

test('compressed upstream response is forwarded but explicitly unobserved without false EOF error', async () => {
  const payload = frame({ type: 'response.completed' });
  const f = await fixture((_req, res) => res.writeHead(200, { 'content-type': 'text/event-stream', 'content-encoding': 'gzip' }).end(gzipSync(payload)));
  try {
    assert.equal(await (await post(f.baseUrl)).text(), payload);
    assert.ok(f.events.some(e => e.reason === 'unsupported_content_encoding'));
    assert.equal(f.events.at(-1)!.reason, 'unobserved'); assert.equal(f.events.some(e => e.event === 'api.error'), false);
  } finally { await f.dispose(); }
});

test('client cancellation and close abort active upstream requests and close remains repeatable', async () => {
  const f = await fixture((_req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': keepalive\n\n'); });
  try {
    const aborter = new AbortController();
    const response = await fetch(`${f.baseUrl}/responses`, { method: 'POST', body, signal: aborter.signal });
    aborter.abort(); await assert.rejects(() => response.text());
    await wait(30); assert.ok(f.events.some(e => e.error?.code === 'client_cancelled'));
    const second = await post(f.baseUrl); await f.close(); await assert.rejects(() => second.text());
    assert.ok(f.events.some(e => e.error?.code === 'proxy_closed'));
    await f.close();
  } finally { await f.dispose(); }
});

test('rejects other paths, queries, and methods before contacting upstream', async () => {
  let calls = 0;
  const f = await fixture((_req, res) => { calls++; res.end(); });
  try {
    for (const [path, method] of [['/responses?secret=PRIVATE', 'POST'], ['/v1/responses', 'POST'], ['/responses', 'GET'], ['/other', 'POST']]) assert.equal((await fetch(f.baseUrl + path, { method })).status, 404);
    assert.equal(calls, 0); assert.deepEqual(f.events, []);
  } finally { await f.dispose(); }
});

test('client close after response.completed preserves success and upstream response identity', async () => {
  const f = await fixture((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(frame({ type: 'response.created', response: { id: 'resp_safe_123' } }));
    res.write(frame({ type: 'response.completed', response: { id: 'resp_safe_123' } }));
    // Codex may close here instead of waiting for HTTP EOF.
  });
  try {
    const aborter = new AbortController();
    const response = await fetch(`${f.baseUrl}/responses`, { method: 'POST', body, signal: aborter.signal });
    const reader = response.body!.getReader(); await reader.read();
    aborter.abort(); await wait(30);
    assert.equal(f.events.some(e => e.event === 'api.error'), false);
    assert.equal(f.events.at(-1)!.reason, 'response.completed');
    assert.equal(f.events.at(-1)!.transportComplete, false);
    assert.equal(f.events.at(-1)!.clientAborted, true);
    assert.equal(f.events.at(-1)!.responseId, 'resp_safe_123');
  } finally { await f.dispose(); }
});

test('forwards response headers before upstream sends its first body byte', async () => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(async (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.flushHeaders();
    await pending; res.end(frame({ type: 'response.completed' }));
  });
  try {
    const response = await Promise.race([post(f.baseUrl), wait(500).then(() => { throw new Error('Headers were buffered'); })]);
    assert.equal(response.status, 200); assert.equal(f.events.some(e => e.event === 'api.end'), false);
    release(); await response.text();
  } finally { release(); await f.dispose(); }
});

const overloaded = (code = 'server_is_overloaded') => ({ type: 'response.failed', response: { error: { type: 'server_error', code, message: 'Selected model is at capacity' } } });
const streamBody = JSON.stringify({ ...JSON.parse(body), stream: true, prompt_cache_key: 'same-thread' });
const streamPost = (baseUrl: string, signal?: AbortSignal) => fetch(`${baseUrl}/responses`, {
  method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer SYNTHETIC', 'session-id': 'same-thread' }, body: streamBody, signal,
});

test('capacity retry uses the exact schedule and request bytes, delivering only the final successful tool result', async () => {
  const attempts: Array<{ body: string; headers: http.IncomingHttpHeaders; path: string | undefined }> = [];
  const waits: number[] = [];
  const f = await fixture(async (req, res) => {
    let requestBody = ''; for await (const chunk of req) requestBody += chunk;
    attempts.push({ body: requestBody, headers: req.headers, path: req.url });
    res.writeHead(200, { 'content-type': 'text/event-stream', 'x-oneapi-request-id': `req-${attempts.length}` });
    if (attempts.length < 5) {
      res.write(frame({ type: 'response.output_item.done', item: { type: 'function_call', arguments: 'FAILED TOOL MUST NOT LEAK' } }));
      const failure = frame(overloaded()); res.write(failure.slice(0, 35)); res.end(failure.slice(35));
    } else res.end(frame({ type: 'response.output_item.done', item: { type: 'function_call', arguments: 'SUCCESS TOOL' } }) + frame({ type: 'response.completed' }));
  }, [], { wait: async (ms: number) => { waits.push(ms); } });
  try {
    const result = await (await streamPost(f.baseUrl)).text();
    assert.deepEqual(waits, [10000, 30000, 60000, 180000]); assert.equal(attempts.length, 5);
    for (const attempt of attempts) assert.deepEqual(attempt, attempts[0]);
    assert.equal(attempts[0].body, streamBody);
    assert.ok(!result.includes('FAILED TOOL')); assert.ok(!result.includes('server_is_overloaded'));
    assert.equal(result.split('SUCCESS TOOL').length - 1, 1);
    assert.equal(result.split('response.completed').length - 1, 1);
    assert.ok(result.includes(': waiting for upstream'));
    assert.deepEqual(f.events.filter(e => e.event === 'api.retry').map(e => [e.attempt, e.maxRetries, e.delayMs]), [[1,4,10000],[2,4,30000],[3,4,60000],[4,4,180000]]);
    assert.equal(f.events.filter(e => e.event === 'api.retrying').length, 4);
    assert.equal(f.events.filter(e => e.event === 'api.end').length, 1);
    assert.equal(f.events.at(-1)!.reason, 'response.completed');
    assert.equal(f.events.filter(e => e.event === 'api.response')[0].requestIds['x-oneapi-request-id'], 'req-1');
    assert.ok(!JSON.stringify(f.events).includes('TOOL'));
  } finally { await f.dispose(); }
});

test('five exhausted attempts deliver the last real capacity error exactly once', async () => {
  let calls = 0;
  const f = await fixture((_req, res) => { calls++; res.writeHead(200, { 'content-type': 'text/event-stream' }).end(frame({ type: 'response.output_item.done', item: { type: 'function_call', arguments: 'NEVER EXECUTE FAILED TOOL' } }) + frame({ ...overloaded('model_at_capacity'), response: { error: { code: 'model_at_capacity', message: `attempt-${calls}` } } })); }, [], { wait: async () => {} });
  try {
    const result = await (await streamPost(f.baseUrl)).text();
    assert.equal(calls, 5); assert.ok(result.includes('attempt-5'));
    for (let i = 1; i < 5; i++) assert.ok(!result.includes(`attempt-${i}`));
    assert.equal(result.split('data: {"type":"response.failed"').length - 1, 1);
    assert.ok(!result.includes('NEVER EXECUTE FAILED TOOL'));
    assert.equal(f.events.at(-1)!.reason, 'response.failed');
  } finally { await f.dispose(); }
});

test('503 JSON overload retries preserve final error fields in SSE, while nonstream retains actual HTTP status', async () => {
  for (const streaming of [true, false]) {
    let calls = 0;
    const f = await fixture((_req, res) => { calls++; res.writeHead(503, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { code: 'model_capacity', message: 'last real error', detail: 'original field' } })); }, [], { wait: async () => {} });
    try {
      const response = await (streaming ? streamPost(f.baseUrl) : post(f.baseUrl)); const result = await response.text();
      assert.equal(calls, 5); assert.equal(response.status, streaming ? 200 : 503);
      assert.ok(result.includes('last real error')); assert.ok(result.includes('original field'));
      if (streaming) assert.ok(result.includes('event: error'));
      assert.equal(f.events.at(-1)!.status, 503);
    } finally { await f.dispose(); }
  }
});

test('non-overload failures, ordinary HTTP errors, incomplete responses and unconfirmed EOF never retry', async () => {
  for (const candidate of [
    { status: 200, type: 'text/event-stream', payload: frame(overloaded('rate_limit_exceeded')) },
    { status: 200, type: 'text/event-stream', payload: frame({ type: 'response.incomplete', response: { error: { code: 'server_is_overloaded' } } }) },
    { status: 200, type: 'text/event-stream', payload: frame({ type: 'response.created' }) },
    { status: 401, type: 'application/json', payload: JSON.stringify({ error: { code: 'server_is_overloaded' } }) },
    { status: 503, type: 'application/json', payload: JSON.stringify({ error: { code: 'unrelated_error' } }) },
  ]) {
    let calls = 0;
    const f = await fixture((_req, res) => { calls++; res.writeHead(candidate.status, { 'content-type': candidate.type }).end(candidate.payload); }, [], { wait: async () => { throw Error('Must not wait'); } });
    try { const response = await streamPost(f.baseUrl); const result = await response.text(); assert.equal(calls, 1); assert.ok(result.endsWith(candidate.payload)); assert.equal(f.events.some(e => e.event === 'api.retry'), false); }
    finally { await f.dispose(); }
  }
});

test('cancel and proxy close abort backoff without launching another upstream request', async () => {
  for (const closeProxy of [false, true]) {
    let calls = 0, signalAborted = false;
    const f = await fixture((_req, res) => { calls++; res.writeHead(200, { 'content-type': 'text/event-stream' }).end(frame(overloaded())); }, [], {
      wait: (_ms: number, signal: AbortSignal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => { signalAborted = true; reject(Error('cancelled')); }, { once: true })), keepAliveMs: 5,
    });
    try {
      const controller = new AbortController(); const response = await streamPost(f.baseUrl, controller.signal);
      for (let i = 0; i < 20 && !f.events.some(e => e.event === 'api.retry'); i++) await wait(5);
      if (closeProxy) await f.close(); else controller.abort();
      await assert.rejects(() => response.text()); await wait(20);
      assert.equal(signalAborted, true); assert.equal(calls, 1); assert.equal(f.events.at(-1)!.reason, 'cancelled');
    } finally { await f.dispose(); }
  }
});

test('request or response memory limits fall back to pass-through and prohibit retry', async () => {
  for (const limit of [{ maxRequestBytes: 16 }, { maxResponseBytes: 16 }]) {
    let calls = 0, observed = '';
    const payload = frame(overloaded());
    const f = await fixture(async (req, res) => { for await (const chunk of req) observed += chunk; calls++; res.writeHead(200, { 'content-type': 'text/event-stream' }).end(payload); }, [], { ...limit, wait: async () => { throw Error('must not retry'); } });
    try {
      const result = await (await streamPost(f.baseUrl)).text();
      assert.equal(calls, 1); assert.equal(observed, streamBody); assert.ok(result.endsWith(payload));
      assert.equal(f.events.some(e => e.event === 'api.retry'), false);
      assert.ok(f.events.some(e => ['retry_request_buffer_limit','retry_response_buffer_limit'].includes(e.reason)));
    } finally { await f.dispose(); }
  }
});

test('same-channel resolver runs once during the wait and pins every subsequent attempt', async () => {
  const authorizations: Array<string | undefined> = []; let resolved = 0, waitStarted = false;
  const f = await fixture((_req, res) => { authorizations.push(_req.headers.authorization); res.writeHead(200, { 'content-type': 'text/event-stream', 'x-oneapi-request-id': 'original-request' }); res.end(frame(authorizations.length < 3 ? overloaded() : { type: 'response.completed' })); }, [], {
    wait: async () => { waitStarted = true; },
    resolveRetryHeaders: async ({ requestHeaders, responseHeaders, signal }: { requestHeaders: Record<string,string>; responseHeaders: Record<string,string>; signal: AbortSignal }) => {
      resolved++; assert.equal(waitStarted, true); assert.equal(signal.aborted, false); assert.equal(responseHeaders['x-oneapi-request-id'], 'original-request');
      return { ...requestHeaders, authorization: 'Bearer SYNTHETIC-4' };
    },
  });
  try {
    await (await streamPost(f.baseUrl)).text();
    assert.equal(resolved, 1); assert.deepEqual(authorizations, ['Bearer SYNTHETIC', 'Bearer SYNTHETIC-4', 'Bearer SYNTHETIC-4']);
  } finally { await f.dispose(); }
});

test('unknown original channel or resolver failure fails closed with the original response', async () => {
  for (const throwing of [false, true]) {
    let calls = 0;
    const f = await fixture((_req, res) => { calls++; res.writeHead(200, { 'content-type': 'text/event-stream' }).end(frame(overloaded())); }, [], {
      wait: async () => {}, resolveRetryHeaders: async () => { if (throwing) throw Error('PRIVATE SECRET'); return null; },
    });
    try {
      const result = await (await streamPost(f.baseUrl)).text(); assert.equal(calls, 1); assert.ok(result.includes('server_is_overloaded'));
      assert.ok(f.events.some(e => e.reason === 'retry_channel_unresolved')); assert.ok(!JSON.stringify(f.events).includes('PRIVATE'));
    } finally { await f.dispose(); }
  }
});

test('close cancels a resolver that ignores its signal and does not wait for its unknown promise', async () => {
  let calls = 0, resolverStarted = false, resolverAborted = false;
  const f = await fixture((_req, res) => { calls++; res.writeHead(200, { 'content-type': 'text/event-stream' }).end(frame(overloaded())); }, [], {
    wait: async () => {},
    resolveRetryHeaders: ({ signal }: { signal: AbortSignal }) => {
      resolverStarted = true; signal.addEventListener('abort', () => { resolverAborted = true; });
      return new Promise(() => {});
    },
  });
  try {
    const response = await streamPost(f.baseUrl);
    for (let i = 0; i < 20 && !resolverStarted; i++) await wait(5);
    assert.equal(resolverStarted, true);
    await f.close(); await assert.rejects(() => response.text());
    assert.equal(resolverAborted, true); assert.equal(calls, 1);
    assert.equal(f.events.at(-1)!.reason, 'cancelled');
    assert.equal(f.events.some(e => e.event === 'api.retrying'), false);
  } finally { await f.dispose(); }
});

test('cancelling the native ten-second backoff clears its timer immediately', async () => {
  let calls = 0;
  const f = await fixture((_req, res) => { calls++; res.writeHead(200, { 'content-type': 'text/event-stream' }).end(frame(overloaded())); }, [], {});
  try {
    const response = await streamPost(f.baseUrl);
    for (let i = 0; i < 20 && !f.events.some(e => e.event === 'api.retry'); i++) await wait(5);
    assert.equal(f.events.find(e => e.event === 'api.retry')!.delayMs, 10000);
    const started = Date.now(); await f.close();
    await assert.rejects(() => response.text());
    assert.ok(Date.now() - started < 1000); assert.equal(calls, 1);
    assert.equal(f.events.at(-1)!.reason, 'cancelled');
  } finally { await f.dispose(); }
});
