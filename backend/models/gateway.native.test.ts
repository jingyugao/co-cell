import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Hono } from 'hono';
import { getRequestListener } from '@hono/node-server';
import { Codex, CodexAppServerClient, type Thread } from '../../packages/agentcore/src/index.mjs';
import { ModelGateway, installModelGateway } from './gateway.js';
import type { ModelService } from './service.js';
import { SecretCrypto } from '../secrets/crypto.js';
import type { Session } from '../../protocol/types.js';

// Exercise the pinned App Server's real resume/fork behavior. Only the remote
// model is replaced with a loopback Responses peer; no credentials or tokens.
test('native loaded threads change gateway channels without losing their conversation', { timeout: 30_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'cocell-gateway-native-'));
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
  const service = { selection: async () => ({ model: 'gpt-6-sol', modelEntryId: channel, channelId: channel,
    endpoint: `${upstreamUrl}/${channel}/v1`, apiKey: `key-${channel}` }) } as unknown as ModelService;
  const snapshots = new Map<string, string>();
  const app = new Hono();
  const web = createServer(getRequestListener(app.fetch));
  await new Promise<void>(done => web.listen(0, '127.0.0.1', done));
  const gateway = new ModelGateway(service, new SecretCrypto(Buffer.alloc(32, 2).toString('base64')),
    `http://127.0.0.1:${(web.address() as { port: number }).port}`, {
      init: async () => {}, save: async (id, value) => { snapshots.set(id, value); }, load: async id => snapshots.get(id),
      delete: async id => { snapshots.delete(id); },
    });
  installModelGateway(app, gateway);
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
    const managed = await collect(codex.resumeThread(legacy, { ...common, ...await gateway.threadOptions(session) }), 'Second message.');
    assert.notEqual(managed, legacy, 'the loaded legacy thread must adopt the managed gateway');
    channel = 'b';
    const resumed = await collect(codex.resumeThread(managed, { ...common, ...await gateway.threadOptions(session) }), 'Third message.');
    assert.equal(resumed, managed, 'changing channels must retain the managed thread');
    assert.deepEqual(requests.map(request => [request.path, request.key]), [
      ['/a/v1/responses', 'Bearer key-a'], ['/a/v1/responses', 'Bearer key-a'], ['/b/v1/responses', 'Bearer key-b'],
    ]);
    assert.match(requests[2].input, /Remember the first message/);
    assert.match(requests[2].input, /Second message/);
    assert.match(requests[2].input, /Third message/);
  } finally {
    await codex?.close(); await client?.close();
    await Promise.all([upstream, web].map(server => new Promise<void>(done => { server.closeAllConnections(); server.close(() => done()); })));
    await rm(home, { recursive: true, force: true });
  }
});
