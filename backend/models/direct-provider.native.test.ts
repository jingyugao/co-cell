import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Codex, CodexAppServerClient, type Thread } from '../../packages/agentcore/src/index.mjs';
import { DirectModelProvider } from './direct-provider.js';
import type { ModelService } from './service.js';
import type { Session } from '../../protocol/types.js';

// Exercise the pinned App Server's real resume/fork behavior. Only the remote
// model is replaced with a loopback Responses peer using synthetic credentials.
test('native threads use channels directly and preserve history across endpoint and key changes', { timeout: 30_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'cocell-direct-native-'));
  const requests: Array<{ path: string; key?: string; input: string }> = [];
  const upstream = createServer(async (req, res) => {
    let input = ''; for await (const chunk of req) input += chunk;
    requests.push({ path: req.url!, key: req.headers.authorization, input });
    const text = req.url?.startsWith('/b/') ? 'channel B answer' : 'channel A answer';
    const item = { id: `msg_${requests.length}`, type: 'message', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', annotations: [], text }] };
    const response = { id: `resp_${requests.length}`, object: 'response', created_at: 1, status: 'completed', model: 'gpt-6-sol',
      output: [item], usage: { input_tokens: 1, input_tokens_details: { cached_tokens: 0 }, output_tokens: 1,
        output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 2 } };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const event of [{ type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
      { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
      { type: 'response.output_item.done', output_index: 0, item }, { type: 'response.completed', response }]) {
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    }
    res.end();
  });
  await new Promise<void>(done => upstream.listen(0, '127.0.0.1', done));
  const upstreamUrl = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
  let channel = 'a';
  let key = 'key-a';
  const service = { selection: async () => ({ model: 'gpt-6-sol', modelEntryId: channel, channelId: channel,
    endpoint: `${upstreamUrl}/${channel}/v1`, apiKey: key }) } as unknown as ModelService;
  const provider = new DirectModelProvider(service);
  let client: CodexAppServerClient | undefined;
  let codex: Codex | undefined;
  try {
    client = await CodexAppServerClient.spawn({ command: resolve('node_modules/.bin/codex'), args: ['app-server'], cwd: home,
      env: { PATH: process.env.PATH, HOME: home, CODEX_HOME: home, NO_PROXY: '127.0.0.1,localhost' } });
    codex = new Codex({ appServerClient: client });
    const common = { workingDirectory: home, sandboxMode: 'read-only' as const, approvalPolicy: 'never' as const, webSearchMode: 'disabled' as const };
    const collect = async (thread: Thread, prompt: string) => {
      const events = [];
      for await (const event of (await thread.runStreamed(prompt)).events) events.push(event);
      assert.equal(events.at(-1)?.type, 'turn.completed', JSON.stringify(events.at(-1)));
      return thread.id!;
    };
    const legacy = await collect(codex.startThread({ ...common, model: 'gpt-6-sol', modelProvider: 'legacy', providerConfig: {
      'model_providers.legacy': { name: 'legacy', base_url: `${upstreamUrl}/a/v1`, wire_api: 'responses', experimental_bearer_token: 'key-a', supports_websockets: false },
    } }), 'Remember the first message.');
    const session = { id: '11111111-1111-4111-8111-111111111111', settings: { model: 'gpt-6-sol' } } as Session;
    const direct = await collect(codex.resumeThread(legacy, { ...common, ...await provider.threadOptions(session) }), 'Second message.');
    assert.notEqual(direct, legacy, 'the loaded legacy thread must adopt the direct provider');
    const unchanged = await collect(codex.resumeThread(direct, { ...common, ...await provider.threadOptions(session) }), 'Third message.');
    assert.equal(unchanged, direct, 'an unchanged channel must retain the native thread');
    channel = 'b';
    key = 'key-b';
    const changed = await collect(codex.resumeThread(direct, { ...common, ...await provider.threadOptions(session) }), 'Fourth message.');
    assert.notEqual(changed, direct, 'a changed endpoint must adopt the new direct provider');
    key = 'rotated-key-b';
    const rotated = await collect(codex.resumeThread(changed, { ...common, ...await provider.threadOptions(session) }), 'Fifth message.');
    assert.notEqual(rotated, changed, 'a changed key must be adopted by the loaded thread');
    await codex.close(); await client.close();
    client = await CodexAppServerClient.spawn({ command: resolve('node_modules/.bin/codex'), args: ['app-server'], cwd: home,
      env: { PATH: process.env.PATH, HOME: home, CODEX_HOME: home, NO_PROXY: '127.0.0.1,localhost' } });
    codex = new Codex({ appServerClient: client });
    const restored = await collect(codex.resumeThread(rotated, { ...common, ...await provider.threadOptions(session) }), 'After restart.');
    assert.equal(restored, rotated, 'a restored direct thread must retain its conversation');
    assert.deepEqual(requests.map(request => [request.path, request.key]), [
      ['/a/v1/responses', 'Bearer key-a'], ['/a/v1/responses', 'Bearer key-a'], ['/a/v1/responses', 'Bearer key-a'],
      ['/b/v1/responses', 'Bearer key-b'], ['/b/v1/responses', 'Bearer rotated-key-b'], ['/b/v1/responses', 'Bearer rotated-key-b'],
    ]);
    for (const message of ['Remember the first message', 'Second message', 'Third message', 'Fourth message', 'Fifth message', 'After restart']) {
      assert.match(requests[5].input, new RegExp(message));
    }
  } finally {
    await codex?.close(); await client?.close();
    await new Promise<void>(done => { upstream.closeAllConnections(); upstream.close(() => done()); });
    await rm(home, { recursive: true, force: true });
  }
});

test('native streaming failures retain the upstream cause after adopting the Codex transport identity', { timeout: 30_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'cocell-stream-error-'));
  const overload = { type: 'service_unavailable_error', code: 'server_is_overloaded',
    message: 'Our servers are currently overloaded. Please try again later.' };
  let upstreamError: typeof overload | undefined = overload;
  const requests: Array<{ originator?: string; input: string }> = [];
  const upstream = createServer(async (req, res) => {
    let input = ''; for await (const chunk of req) input += chunk;
    const originator = String(req.headers.originator ?? '');
    requests.push({ originator, input });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('event: response.created\ndata: {"type":"response.created","response":{"id":"resp_test","status":"in_progress","output":[]}}\n\n');
    if (upstreamError) {
      // CLIProxyAPI v7.2.154 selects this wire format by the request's Codex
      // identity. Its generic error event is ignored by the real Codex parser.
      const event = originator === 'codex_cli_rs'
        ? { type: 'response.failed', sequence_number: 0, response: { status: 'failed', error: upstreamError } }
        : { type: 'error', sequence_number: 0, code: upstreamError.code, message: upstreamError.message };
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    }
    res.end();
  });
  await new Promise<void>(done => upstream.listen(0, '127.0.0.1', done));
  const endpoint = `http://127.0.0.1:${(upstream.address() as { port: number }).port}/v1`;
  const selected = { model: 'gpt-6-sol', modelEntryId: 'entry', channelId: 'legacy-default', endpoint, apiKey: '' };
  const provider = new DirectModelProvider({ selection: async () => selected } as unknown as ModelService, true);
  const options = await provider.threadOptions({ settings: { model: selected.model } } as Session);
  const oldProvider = `cocell_direct_${createHash('sha256').update(JSON.stringify([selected.channelId, endpoint, ''])).digest('hex')}`;
  const { http_headers: _, ...oldConfig } = Object.values(options.providerConfig!)[0] as Record<string, unknown>;
  let client: CodexAppServerClient | undefined;
  let codex: Codex | undefined;
  try {
    client = await CodexAppServerClient.spawn({ command: resolve('node_modules/.bin/codex'), args: ['app-server'], cwd: home,
      env: { PATH: process.env.PATH, HOME: home, CODEX_HOME: home, NO_PROXY: '127.0.0.1,localhost' } });
    codex = new Codex({ appServerClient: client });
    const common = { workingDirectory: home, sandboxMode: 'read-only' as const, approvalPolicy: 'never' as const, webSearchMode: 'disabled' as const };
    const failure = async (thread: Thread, prompt: string) => {
      const events = [];
      for await (const event of (await thread.runStreamed(prompt)).events) events.push(event);
      const last = events.at(-1);
      assert.equal(last?.type, 'turn.failed');
      if (last?.type !== 'turn.failed') throw new Error('Expected failed turn');
      const stored = await client!.request('thread/read', { threadId: thread.id, includeTurns: true });
      assert.equal(stored.thread.turns.at(-1).error.message, last.error.message, 'history must retain the live failure');
      return last.error.message;
    };
    const legacy = codex.startThread({ ...common, model: selected.model, modelProvider: oldProvider,
      providerConfig: { [`model_providers.${oldProvider}`]: { ...oldConfig, name: oldProvider } } });
    assert.match(await failure(legacy, 'Original request.'), /stream closed before response.completed/);
    assert.equal(requests[0].originator, 'co_cell_app_server_client');

    const migrated = codex.resumeThread(legacy.id!, { ...common, ...options });
    assert.equal(await failure(migrated, 'Continue the original request.'), 'Selected model is at capacity. Please try a different model.');
    assert.notEqual(migrated.id, legacy.id, 'already loaded providers must adopt the new header through a history fork');
    assert.equal(requests[1].originator, 'codex_cli_rs');
    assert.match(requests[1].input, /Original request/);

    upstreamError = { type: 'server_error', code: 'upstream_failure', message: 'The upstream inference worker is unavailable.' };
    assert.match(await failure(migrated, 'Retry with an upstream error.'), /The upstream inference worker is unavailable\./);
    upstreamError = undefined;
    assert.match(await failure(migrated, 'Retry with a disconnected stream.'), /stream closed before response.completed/,
      'a later disconnect must not reuse an earlier upstream error');
    assert.equal(requests.length, 4);
  } finally {
    await codex?.close(); await client?.close();
    await new Promise<void>(done => { upstream.closeAllConnections(); upstream.close(() => done()); });
    await rm(home, { recursive: true, force: true });
  }
});
