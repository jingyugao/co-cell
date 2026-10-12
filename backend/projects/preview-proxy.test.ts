import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { connect, type Socket } from 'node:net';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { after, before, test } from 'node:test';
import { createPreviewProxy } from './preview-proxy.js';
import { serviceHost } from './service-host.js';

const token = 'a'.repeat(48);
const publicUrl = 'https://cocell.example.test';
const projectId = 'a3e7fbd0-31f3-4fc2-a69b-dabffbf616cb';
const port = 8123;
const host = serviceHost(projectId, port, publicUrl, token);

let upstream: ReturnType<typeof createServer>;
let proxyServer: ReturnType<typeof createServer>;
let upstreamPort: number;
let proxyPort: number;
let targetPort: number;
let releases: number;
let lastAccessSignal: AbortSignal | undefined;
let notifyFirstUploadChunk: (() => void) | undefined;
let proxy: ReturnType<typeof createPreviewProxy>;
const echoSockets = new Set<Socket>();
const gzipPayload = Buffer.from('wire bytes survive compression, proxying, and decompression');
const gzipResponse = gzipSync(gzipPayload);

function listen(server: ReturnType<typeof createServer>): Promise<number> {
  server.listen(0, '127.0.0.1');
  return once(server, 'listening').then(() => (server.address() as { port: number }).port);
}

function previewCookie(forHost = host): string {
  const expires = String(Date.now() + 60_000);
  const signature = createHmac('sha256', token)
    .update(`cocell-preview:${forHost.toLowerCase()}-v1\0${expires}`)
    .digest('base64url');
  return `__Host-cocell_preview=v1.${expires}.${signature}`;
}

function client(path: string, options: { method?: string; headers?: Record<string, string>; body?: Buffer } = {}) {
  return new Promise<{ status: number; headers: IncomingMessage['headers']; body: Buffer }>((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port: proxyPort, path, method: options.method ?? 'GET',
      headers: { host, authorization: `Bearer ${token}`, ...options.headers } }, res => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(Buffer.from(chunk)));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    if (options.body) req.end(options.body); else req.end();
  });
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await delay(10);
  }
  assert.fail(message);
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([promise, new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  })]).finally(() => clearTimeout(timer!));
}

before(async () => {
  releases = 0;
  upstream = createServer((req, res) => {
    if (req.url === '/stream-upload') {
      const chunks: Buffer[] = [];
      req.on('data', chunk => {
        chunks.push(Buffer.from(chunk));
        notifyFirstUploadChunk?.();
        notifyFirstUploadChunk = undefined;
      });
      req.on('end', () => { res.writeHead(200); res.end(Buffer.concat(chunks)); });
      return;
    }
    if (req.url === '/inspect') {
      req.on('end', () => {
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-encoding': 'gzip',
          'set-cookie': [
            'app_session=one; Domain=example.test; Path=/; HttpOnly; SameSite=Lax',
            '__Host-cocell_preview=attacker; Secure; Path=/',
            'cocell_operator=attacker; Path=/',
            'prefs=two; Domain=.example.test; Path=/prefs',
          ],
          'x-cellbox-secret': 'must-not-leak',
        });
        res.end(gzipResponse);
      });
      req.resume();
      return;
    }
    if (new URL(req.url ?? '/', 'http://localhost').pathname === '/redirect') {
      res.writeHead(302, { location: `http://localhost:${port}/login?next=%2F` }); res.end(); return;
    }
    if (new URL(req.url ?? '/', 'http://localhost').pathname === '/external-redirect') {
      res.writeHead(302, { location: 'https://accounts.example.net/login' }); res.end(); return;
    }
    if (req.url === '/head') { res.writeHead(200, { 'content-length': '4', etag: '"v1"' }); res.end(); return; }
    if (req.url === '/range') { res.writeHead(206, { 'content-range': 'bytes 1-2/4', 'content-length': '2' }); res.end('bc'); return; }
    if (req.url === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const timer = setInterval(() => res.write('data: tick\n\n'), 10);
      res.on('close', () => clearInterval(timer));
      return;
    }
    res.writeHead(404); res.end('missing');
  });
  upstreamPort = await listen(upstream);
  targetPort = upstreamPort;
  proxy = createPreviewProxy({ token, publicUrl, projects: () => [{ id: projectId, executionMode: 'cellbox' }],
    access: async (_project, _port, _method, signal) => {
      lastAccessSignal = signal;
      return {
      url: `http://127.0.0.1:${targetPort}`,
      headers: { 'x-cellbox-client-id': 'trusted-internal-id' }, signal,
      release: async () => { releases++; },
      };
    },
  });
  proxyServer = createServer((req, res) => {
    void proxy.handle(req, res).then(handled => { if (!handled && !res.writableEnded) { res.writeHead(404); res.end(); } });
  });
  proxyServer.on('upgrade', (req, socket, head) => { void proxy.upgrade(req, socket as Socket, head); });
  proxyPort = await listen(proxyServer);
});

after(async () => {
  proxy.close();
  await Promise.all([new Promise<void>(resolve => proxyServer.close(() => resolve())),
    new Promise<void>(resolve => upstream.close(() => resolve()))]);
});

test('streams uploads and preserves application auth while filtering platform credentials and cookies', async () => {
  const body = Buffer.from([0, 255, 31, 128, 10, 13, 42]);
  const response = await client('/inspect', { method: 'POST', body, headers: {
    authorization: 'Basic app-user:app-password',
    cookie: `${previewCookie()}; PHPSESSID=app-session; cocell_operator=spoof; cocell_preview=spoof; __Host-cocell_operator=spoof`,
    'x-cellbox-spoof': 'evil', 'x-forwarded-for': '198.51.100.7', forwarded: 'for=198.51.100.8',
    'proxy-authorization': 'Basic spoof', 'content-type': 'application/octet-stream',
  } });
  assert.equal(response.status, 200, response.body.toString());
  assert.deepEqual(response.body, gzipResponse, 'proxy preserves the exact compressed wire bytes');
  assert.deepEqual(gunzipSync(response.body), gzipPayload, 'compressed payload remains valid after proxying');
  assert.equal(response.headers['content-encoding'], 'gzip');
  assert.equal(response.headers['x-cellbox-secret'], undefined);
  assert.equal(response.headers['cache-control'], 'no-store');
  const cookies = response.headers['set-cookie'] ?? [];
  assert.equal(cookies.length, 2);
  assert.ok(cookies.every(cookie => !/domain=/i.test(cookie)));
  assert.ok(cookies.some(cookie => cookie.startsWith('app_session=one')));
  assert.ok(cookies.some(cookie => cookie.startsWith('prefs=two')));
  assert.ok(!cookies.some(cookie => /cocell/i.test(cookie)));
  assert.equal(releases, 1);
});

test('forwards upload chunks before the client finishes sending the request', { timeout: 5_000 }, async () => {
  let observed!: () => void;
  const firstChunk = new Promise<void>(resolve => { observed = resolve; });
  notifyFirstUploadChunk = observed;
  const first = Buffer.from('arrives before end:');
  const second = Buffer.from(' final chunk');
  const responsePromise = new Promise<{ status: number; body: Buffer }>((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port: proxyPort, method: 'POST', path: '/stream-upload',
      headers: { host, authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' } }, res => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(Buffer.from(chunk)));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.write(first);
    void withTimeout(firstChunk, 2_000, 'upstream did not observe the first upload chunk before req.end()')
      .then(() => req.end(second), reject);
  });
  const response = await withTimeout(responsePromise, 3_500, 'streamed upload response timed out');
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, Buffer.concat([first, second]));
});

test('strips only the platform bearer and spoofed transport headers while retaining application Authorization', async () => {
  let received: IncomingMessage['headers'] | undefined;
  const inspect = createServer((req, res) => {
    received = req.headers;
    req.resume(); req.on('end', () => { res.writeHead(204); res.end(); });
  });
  const inspectPort = await listen(inspect);
  targetPort = inspectPort;
  const response = await client('/auth', { headers: {
    authorization: 'Bearer application-token', cookie: `${previewCookie()}; PHPSESSID=ok`,
    'x-cellbox-client-id': 'spoof', 'x-forwarded-host': 'attacker.invalid', 'proxy-authenticate': 'spoof',
  } });
  assert.equal(response.status, 204);
  assert.equal(received?.authorization, 'Bearer application-token');
  assert.equal(received?.cookie, 'PHPSESSID=ok');
  assert.equal(received?.['x-cellbox-client-id'], 'trusted-internal-id');
  assert.equal(received?.['x-forwarded-host'], undefined);
  assert.equal(received?.['proxy-authenticate'], undefined);
  targetPort = upstreamPort;
  await new Promise<void>(resolve => inspect.close(() => resolve()));
});

test('removes the platform bearer from upstream requests', async () => {
  let authorization: string | undefined;
  const inspect = createServer((req, res) => { authorization = req.headers.authorization; req.resume(); req.on('end', () => { res.end('ok'); }); });
  const inspectPort = await listen(inspect);
  targetPort = inspectPort;
  const response = await client('/platform', { headers: { authorization: `Bearer ${token}` } });
  assert.equal(response.status, 200);
  assert.equal(authorization, undefined);
  targetPort = upstreamPort;
  await new Promise<void>(resolve => inspect.close(() => resolve()));
});

test('rewrites redirects back to the same preview port and leaves external redirects intact', async () => {
  const local = await client('/redirect?from=app');
  assert.equal(local.status, 302);
  assert.equal(local.headers.location, '/login?next=%2F');
  const external = await client('/external-redirect');
  assert.equal(external.headers.location, 'https://accounts.example.net/login');
});

test('preserves HEAD and range responses and releases a canceled SSE stream', async () => {
  const head = await client('/head', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.headers['content-length'], '4');
  assert.equal(head.body.length, 0);
  const range = await client('/range', { headers: { range: 'bytes=1-2' } });
  assert.equal(range.status, 206);
  assert.equal(range.headers['content-range'], 'bytes 1-2/4');
  assert.equal(range.body.toString(), 'bc');

  const beforeCount = releases;
  const req = httpRequest({ host: '127.0.0.1', port: proxyPort, path: '/events', headers: { host, cookie: previewCookie() } });
  const resPromise = once(req, 'response') as Promise<[IncomingMessage]>;
  req.end();
  const [res] = await resPromise;
  await once(res, 'data');
  res.destroy();
  await waitFor(() => releases > beforeCount, 'upstream lease was not released after SSE client cancellation');
  assert.equal(lastAccessSignal?.aborted, true, 'client disconnect aborts the access operation');
});

test('releases the upstream lease after an application 404 response', async () => {
  const beforeCount = releases;
  const response = await client('/missing-from-application');
  assert.equal(response.status, 404);
  assert.equal(response.body.toString(), 'missing');
  assert.equal(releases, beforeCount + 1);
});

function websocketRequest(headers: Record<string, string>): Promise<{ socket: ReturnType<typeof connect>; response: Promise<string> }> {
  const socket = connect(proxyPort, '127.0.0.1');
  const response = new Promise<string>((resolve, reject) => {
    let text = '';
    const timer = setTimeout(() => reject(new Error('WebSocket handshake timed out')), 1500);
    socket.on('data', chunk => {
      text += chunk.toString('latin1');
      if (text.includes('\r\n\r\n')) { clearTimeout(timer); resolve(text); }
    });
    socket.on('error', error => { clearTimeout(timer); reject(error); });
  });
  socket.once('connect', () => {
    socket.write(`GET /ws HTTP/1.1\r\nHost: ${host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n${Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join('')}\r\n`);
  });
  return Promise.resolve({ socket, response });
}

test('supports WebSocket upgrades and rejects unauthenticated or cross-origin upgrades', { timeout: 5_000 }, async () => {
  const echo = createServer();
  echo.on('upgrade', (_req, socket: Socket) => {
    echoSockets.add(socket);
    socket.once('close', () => echoSockets.delete(socket));
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    socket.on('data', data => socket.write(data));
    socket.once('end', () => socket.end());
  });
  const echoPort = await listen(echo);
  targetPort = echoPort;
  let openedSocket: Socket | undefined;
  try {
    const rejected = await websocketRequest({ origin: 'https://attacker.example', cookie: previewCookie() });
    assert.match(await rejected.response, /^HTTP\/1\.1 403/);
    rejected.socket.destroy();
    const unauthenticated = await websocketRequest({ origin: `https://${host}` });
    assert.match(await unauthenticated.response, /^HTTP\/1\.1 403/);
    unauthenticated.socket.destroy();

    const beforeOpen = releases;
    const opened = await websocketRequest({ origin: `https://${host}`, cookie: previewCookie() });
    openedSocket = opened.socket;
    assert.match(await withTimeout(opened.response, 2_000, 'WebSocket handshake timed out'), /^HTTP\/1\.1 101/);
    const echoed = await new Promise<Buffer>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('WebSocket echo timed out')), 1000);
      opened.socket.on('data', chunk => { clearTimeout(timer); resolve(Buffer.from(chunk)); });
      opened.socket.write(Buffer.from([0x81, 0x02, 0x6f, 0x6b]));
    });
    assert.deepEqual(echoed, Buffer.from([0x81, 0x02, 0x6f, 0x6b]));
    opened.socket.destroy();
    await waitFor(() => echoSockets.size === 0, 'WebSocket client close did not close the upstream socket');
    await waitFor(() => releases > beforeOpen, 'WebSocket request did not release upstream access');
  } finally {
    openedSocket?.destroy();
    for (const socket of echoSockets) socket.destroy();
    targetPort = upstreamPort;
    await withTimeout(new Promise<void>(resolve => echo.close(() => resolve())), 1_000, 'echo server cleanup timed out').catch(() => {});
  }
});

test('discovers a signed preview after another API creates its project', async () => {
  let refreshed = false;
  let releaseCount = 0;
  const isolated = createPreviewProxy({ token, publicUrl,
    projects: () => refreshed ? [{ id: projectId, executionMode: 'sandbox' }] : [],
    refreshProjects: async () => { refreshed = true; },
    access: async (_id, _port, _method, signal) => ({ url: `http://127.0.0.1:${upstreamPort}`, headers: {}, signal,
      release: async () => { releaseCount++; } }),
  });
  const server = createServer((req, res) => {
    void isolated.handle(req, res).then(handled => { if (!handled) { res.writeHead(403); res.end(); } });
  });
  const listenPort = await listen(server);
  try {
    const result = await new Promise<number>((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port: listenPort, path: '/missing-from-app',
        headers: { host, authorization: `Bearer ${token}` } }, res => {
        res.resume(); res.on('end', () => resolve(res.statusCode!));
      });
      req.on('error', reject); req.end();
    });
    assert.equal(result, 404);
    assert.equal(refreshed, true);
    assert.equal(releaseCount, 1);
  } finally { await isolated.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('shutdown closes active preview streams and drains their sandbox leases', { timeout: 3_000 }, async () => {
  const beforeCount = releases;
  const req = httpRequest({ host: '127.0.0.1', port: proxyPort, path: '/events', headers: { host, cookie: previewCookie() } });
  const response = once(req, 'response') as Promise<[IncomingMessage]>;
  req.end();
  const [res] = await response;
  await once(res, 'data');
  res.on('error', () => {});
  const closed = new Promise<void>(resolve => res.once('close', () => resolve()));
  await proxy.close();
  await closed;
  assert.equal(releases, beforeCount + 1);
});
