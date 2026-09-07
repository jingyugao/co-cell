import assert from 'node:assert/strict';
import { test } from 'node:test';
// @ts-expect-error The worker must remain an importable standalone JavaScript module for sandbox uploads.
import { createSameChannelResolver } from '../server/e2b-worker.mjs';

type Diagnostic = Record<string, unknown>;
const requestId = '20260907123456789012345-example';
const requestHeaders = { Authorization: 'bEaReR\tsk-PRIVATE_TOKEN', 'content-type': 'application/json', 'x-session-id': 'session-original' };
const responseHeaders = { 'X-Oneapi-Request-Id': requestId };
const logResponse = (data: unknown) => Response.json({ success: true, data });
function fixture(fetchImpl: typeof fetch, options: Record<string, unknown> = {}) {
  const diagnostics: Diagnostic[] = [];
  const resolve = createSameChannelResolver({ upstreamBaseUrl: 'https://proxy.example/v1/', fetchImpl, pollDelaysMs: [0, 0, 0], onDiagnostic: (event: Diagnostic) => diagnostics.push(event), ...options });
  return { resolve, diagnostics };
}

test('uses only an exact request ID, keeps complete headers, and looks up using the unchanged credential', async () => {
  const f = fixture(async (url, init) => {
    assert.equal(String(url), 'https://proxy.example/api/log/token');
    assert.equal(init?.method, 'GET');
    assert.equal(init?.redirect, 'error');
    assert.deepEqual(init?.headers, { authorization: requestHeaders.Authorization });
    assert.ok(init?.signal instanceof AbortSignal);
    return logResponse([
      { request_id: `${requestId}-other`, channel: 99 },
      { request_id: requestId.slice(0, -1), channel: 88 },
      { request_id: requestId, channel: 3, content: 'PRIVATE BUSINESS CONTENT' },
      { request_id: requestId, channel: 3 },
    ]);
  });
  const result = await f.resolve({ requestHeaders, responseHeaders });
  assert.deepEqual(result, { ...requestHeaders, Authorization: `${requestHeaders.Authorization}-3` });
  assert.equal(requestHeaders.Authorization, 'bEaReR\tsk-PRIVATE_TOKEN');
  assert.equal(f.diagnostics[0]?.channelId, 3);
  assert.equal(f.diagnostics[0]?.upstreamRequestId, requestId);
  assert.equal(f.diagnostics[0]?.scope, 'capacity-retry-initial-route');
  assert.ok(!JSON.stringify(f.diagnostics).includes('PRIVATE'));
});

test('supports Headers inputs and leaves an already pinned token unchanged', async () => {
  for (const token of ['sk-PRIVATE_TOKEN-4', 'PRIVATE_TOKEN-4']) {
    const headers = new Headers({ authorization: `Bearer ${token}`, 'x-test': 'preserved' });
    const f = fixture(async () => logResponse([{ request_id: requestId, channel: 4 }]));
    assert.deepEqual(await f.resolve({ requestHeaders: headers, responseHeaders: new Headers(responseHeaders) }), Object.fromEntries(headers));
  }
  const bare = fixture(async () => logResponse([{ request_id: requestId, channel: 3 }]));
  assert.equal((await bare.resolve({ requestHeaders: { authorization: 'Bearer sk-4' }, responseHeaders })).authorization, 'Bearer sk-4-3');
});

test('conflicting or invalid channel mappings fail closed without guessing', async () => {
  for (const channels of [[3, 4], [0], [-1], ['4'], [1.5], [Number.MAX_SAFE_INTEGER + 1], [null]]) {
    let calls = 0;
    const f = fixture(async () => { calls++; return logResponse(channels.map(channel => ({ request_id: requestId, channel }))); });
    assert.equal(await f.resolve({ requestHeaders, responseHeaders }), null);
    assert.equal(calls, 1);
    assert.match(String(f.diagnostics[0]?.reason), /retry_channel_(conflicting|invalid)_log_mapping/);
  }
});

test('an existing pin that differs from the recorded channel is never rewritten', async () => {
  const f = fixture(async () => logResponse([{ request_id: requestId, channel: 3 }]));
  assert.equal(await f.resolve({ requestHeaders: { authorization: 'Bearer sk-PRIVATE_TOKEN-4' }, responseHeaders }), null);
  assert.equal(f.diagnostics[0]?.reason, 'retry_channel_pin_mismatch');
});

test('missing or ambiguous headers and unsupported opaque token suffixes cause no lookup or retry', async () => {
  let calls = 0;
  const f = fixture(async () => { calls++; throw Error('must not fetch'); });
  const cases = [
    { requestHeaders, responseHeaders: {} },
    { requestHeaders, responseHeaders: { 'x-oneapi-request-id': `${requestId}, another-id` } },
    { requestHeaders, responseHeaders: { ...responseHeaders, 'x-oneapi-request-id': requestId } },
    { requestHeaders: {}, responseHeaders },
    { requestHeaders: { authorization: ['Bearer PRIVATE_TOKEN'] }, responseHeaders },
    { requestHeaders: { ...requestHeaders, authorization: 'Bearer OTHER_TOKEN' }, responseHeaders },
    { requestHeaders: { authorization: 'Basic PRIVATE_TOKEN' }, responseHeaders },
    ...['sk-opaque-token', 'sk-opaque-token-4', 'sk-token-0', 'sk-token-9007199254740992'].map(token => ({ requestHeaders: { authorization: `Bearer ${token}` }, responseHeaders })),
  ];
  for (const input of cases) assert.equal(await f.resolve(input), null);
  assert.equal(calls, 0);
  assert.ok(!JSON.stringify(f.diagnostics).includes('PRIVATE'));
});

test('polls only the configured number of times for delayed log persistence', async () => {
  let calls = 0;
  const f = fixture(async () => logResponse(++calls === 3 ? [{ request_id: requestId, channel: 4 }] : []));
  assert.equal((await f.resolve({ requestHeaders, responseHeaders })).Authorization, `${requestHeaders.Authorization}-4`);
  assert.equal(calls, 3);
  const absent = fixture(async () => { calls++; return logResponse([{ request_id: 'different', channel: 4 }]); });
  assert.equal(await absent.resolve({ requestHeaders, responseHeaders }), null);
  assert.equal(calls, 6);
  assert.equal(absent.diagnostics.at(-1)?.reason, 'retry_channel_log_not_found');
});

test('lookup permission failures stop immediately; transient and malformed responses remain bounded', async () => {
  for (const status of [401, 403, 404]) {
    let calls = 0;
    const f = fixture(async () => { calls++; return new Response('PRIVATE ERROR BODY', { status }); });
    assert.equal(await f.resolve({ requestHeaders, responseHeaders }), null);
    assert.equal(calls, 1);
    assert.equal(f.diagnostics[0]?.reason, 'retry_channel_lookup_unavailable');
  }
  let calls = 0;
  const f = fixture(async () => {
    calls++;
    if (calls === 1) throw Error('PRIVATE NETWORK ERROR');
    if (calls === 2) return new Response('PRIVATE INVALID JSON');
    return new Response('PRIVATE ERROR BODY', { status: 500 });
  });
  assert.equal(await f.resolve({ requestHeaders, responseHeaders }), null);
  assert.equal(calls, 3);
  assert.ok(!JSON.stringify(f.diagnostics).includes('PRIVATE'));
});

test('cancellation aborts lookup and prevents later polls', async () => {
  const controller = new AbortController();
  let calls = 0;
  const f = fixture(async (_url, init) => {
    calls++;
    return new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true });
      controller.abort(new Error('cancelled by client'));
    });
  });
  await assert.rejects(f.resolve({ requestHeaders, responseHeaders, signal: controller.signal }), /cancelled by client/);
  assert.equal(calls, 1);
  await assert.rejects(f.resolve({ requestHeaders, responseHeaders, signal: controller.signal }), /cancelled by client/);
  assert.equal(calls, 1);
});

test('cancellation interrupts the polling delay', async () => {
  const controller = new AbortController();
  let calls = 0;
  const f = fixture(async () => { calls++; setTimeout(() => controller.abort(new Error('cancel delay')), 10); return logResponse([]); }, { pollDelaysMs: [0, 1000] });
  await assert.rejects(f.resolve({ requestHeaders, responseHeaders, signal: controller.signal }), /cancel delay/);
  assert.equal(calls, 1);
});

test('lookup timeout and diagnostic callback failures do not throw into the agent turn', async () => {
  const f = fixture(async (_url, init) => new Promise<Response>((_resolve, reject) => {
    init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true });
  }), { requestTimeoutMs: 5, pollDelaysMs: [0] });
  const keepAlive = setTimeout(() => {}, 1000);
  try { assert.equal(await f.resolve({ requestHeaders, responseHeaders }), null); }
  finally { clearTimeout(keepAlive); }
  const good = fixture(async () => logResponse([{ request_id: requestId, channel: 4 }]), { onDiagnostic: () => { throw Error('logging broken'); } });
  assert.ok(await good.resolve({ requestHeaders, responseHeaders }));
});
