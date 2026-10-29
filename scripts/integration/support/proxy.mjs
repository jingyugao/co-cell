import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import WebSocket, { WebSocketServer } from 'ws';

const UPSTREAM_OPEN_TIMEOUT_MS = 10_000;
const MAX_EARLY_UPSTREAM_BYTES = 1024 * 1024;
const MAX_BUFFERED_BYTES = 1024 * 1024;
const MAX_EARLY_UPSTREAM_MESSAGES = 256;
const closeCodeIsValid = code => Number.isInteger(code) && code >= 1000 && code < 5000 && ![1004, 1005, 1006, 1015].includes(code);

function sendUpgradeError(socket, status, reason) {
  if (socket.destroyed) return;
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

/** Loopback transport for the real application, including streaming SSE and the native App Server socket.
 * Credentials stay in Node; browser artifacts never contain the operator token.
 */
export async function startBrowserProxy(environment) {
  const pairs = new Set();
  const pending = new Set();
  let closed = false;
  let closePromise;
  const websocketServer = new WebSocketServer({ noServer: true, perMessageDeflate: false });

  const server = createServer(async (request, response) => {
    const abort = new AbortController();
    response.on('close', () => abort.abort());
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const input = Buffer.concat(chunks).toString();
      const options = { method: request.method, signal: abort.signal,
        ...(input ? { body: JSON.parse(input) } : {}), expectedStatus: null };
      const acceptsEventStream = request.headers.accept?.split(',')
        .some(value => value.trim().split(';')[0].toLowerCase() === 'text/event-stream');
      if (request.url.endsWith('/events') || acceptsEventStream) {
        const started = performance.now();
        const upstream = await environment.fetch(request.url, { ...options, accept: 'text/event-stream',
          timeoutMs: request.url.endsWith('/events') ? environment.config.turnTimeout : environment.config.operationTimeout });
        const headers = Object.fromEntries(upstream.headers);
        for (const name of ['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'set-cookie']) delete headers[name];
        headers['cache-control'] ??= 'no-store';
        try {
          response.writeHead(upstream.status, headers);
          if (upstream.body) await pipeline(Readable.fromWeb(upstream.body), response);
          else response.end();
        } finally {
          environment.recordRequest(request.method, request.url, upstream.status, performance.now() - started);
        }
      } else {
        const result = await environment.request(request.url, options);
        const headers = Object.fromEntries(result.response.headers);
        for (const name of ['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'set-cookie']) delete headers[name];
        response.writeHead(result.response.status, headers); response.end(result.buffer);
      }
    } catch (error) {
      if (abort.signal.aborted) return;
      response.writeHead(502, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: environment.redact(error.message) }));
    }
  });

  const connectPair = (browserSocket, upstreamSocket) => {
    const pair = { browserSocket, upstreamSocket, closeTimer: undefined };
    pairs.add(pair);
    const cleanup = () => {
      if (browserSocket.readyState === WebSocket.CLOSED && upstreamSocket.readyState === WebSocket.CLOSED) {
        clearTimeout(pair.closeTimer);
        pairs.delete(pair);
      }
    };
    const closeOther = (target, code, reason) => {
      if (target.readyState !== WebSocket.OPEN && target.readyState !== WebSocket.CONNECTING) return;
      if (closeCodeIsValid(code)) target.close(code, Buffer.from(reason ?? '').subarray(0, 123));
      else target.close();
      pair.closeTimer ??= setTimeout(() => {
        if (browserSocket.readyState !== WebSocket.CLOSED) browserSocket.terminate();
        if (upstreamSocket.readyState !== WebSocket.CLOSED) upstreamSocket.terminate();
      }, 1_000);
      pair.closeTimer.unref?.();
    };
    const forward = (source, target, data, isBinary) => {
      if (target.readyState !== WebSocket.OPEN || target.bufferedAmount > MAX_BUFFERED_BYTES) {
        closeOther(target, 1013, 'Upstream is not keeping up');
        closeOther(source, 1013, 'Upstream is not keeping up');
        return;
      }
      target.send(data, { binary: isBinary, compress: false }, error => {
        if (error) {
          closeOther(target, 1011, 'WebSocket forwarding failed');
          closeOther(source, 1011, 'WebSocket forwarding failed');
        }
      });
    };
    browserSocket.on('message', (data, isBinary) => forward(browserSocket, upstreamSocket, data, isBinary));
    browserSocket.on('close', (code, reason) => { closeOther(upstreamSocket, code, reason); cleanup(); });
    upstreamSocket.on('close', (code, reason) => { closeOther(browserSocket, code, reason); cleanup(); });
    browserSocket.on('error', () => closeOther(upstreamSocket, 1011, 'WebSocket forwarding failed'));
    upstreamSocket.on('error', () => closeOther(browserSocket, 1011, 'WebSocket forwarding failed'));
    return (data, isBinary) => forward(upstreamSocket, browserSocket, data, isBinary);
  };

  server.on('upgrade', (request, socket, head) => {
    if (closed) { sendUpgradeError(socket, 503, 'Service Unavailable'); return; }
    let url;
    try { url = new URL(request.url, 'http://localhost'); }
    catch { sendUpgradeError(socket, 400, 'Bad Request'); return; }
    const match = /^\/api\/sessions\/([A-Za-z0-9_-]{1,100})\/app-server$/.exec(url.pathname);
    if (!match || url.search) { sendUpgradeError(socket, 404, 'Not Found'); return; }
    const sessionId = match[1];
    if (!environment.sessions.has(sessionId)) { sendUpgradeError(socket, 403, 'Forbidden'); return; }

    const base = environment.config.base;
    const upstreamUrl = new URL(url.pathname, base);
    upstreamUrl.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
    const upstreamSocket = new WebSocket(upstreamUrl, {
      headers: {
        Host: environment.config.publicURL.host,
        Origin: environment.config.publicURL.origin,
        Authorization: `Bearer ${environment.config.token}`,
      },
      perMessageDeflate: false,
      handshakeTimeout: UPSTREAM_OPEN_TIMEOUT_MS,
    });
    const entry = { socket, upstreamSocket, canceled: false, handshaken: false, timer: undefined,
      earlyMessages: [], earlyBytes: 0 };
    pending.add(entry);
    const cancelPending = () => {
      if (entry.handshaken || entry.canceled) return;
      entry.canceled = true;
      clearTimeout(entry.timer);
      pending.delete(entry);
      upstreamSocket.terminate();
    };
    socket.once('close', cancelPending);
    socket.on('error', cancelPending);
    entry.timer = setTimeout(() => {
      if (entry.canceled || entry.handshaken) return;
      entry.canceled = true;
      pending.delete(entry);
      upstreamSocket.terminate();
      sendUpgradeError(socket, 504, 'Gateway Timeout');
    }, UPSTREAM_OPEN_TIMEOUT_MS);
    entry.timer.unref?.();

    upstreamSocket.on('message', (data, isBinary) => {
      if (entry.canceled) return;
      if (entry.handshaken) {
        const browserSocket = entry.browserSocket;
        if (browserSocket) {
          entry.forwardToBrowser?.(data, isBinary);
        }
        return;
      }
      if (entry.earlyMessages.length >= MAX_EARLY_UPSTREAM_MESSAGES || entry.earlyBytes + data.length > MAX_EARLY_UPSTREAM_BYTES) {
        entry.canceled = true; pending.delete(entry); clearTimeout(entry.timer); upstreamSocket.terminate();
        sendUpgradeError(socket, 502, 'Bad Gateway');
        return;
      }
      entry.earlyMessages.push({ data, isBinary }); entry.earlyBytes += data.length;
    });
    upstreamSocket.once('open', () => {
      if (entry.canceled || closed || socket.destroyed) { cancelPending(); return; }
      clearTimeout(entry.timer);
      websocketServer.handleUpgrade(request, socket, head, browserSocket => {
        if (entry.canceled || closed) { browserSocket.terminate(); cancelPending(); return; }
        entry.handshaken = true;
        entry.browserSocket = browserSocket;
        pending.delete(entry);
        entry.forwardToBrowser = connectPair(browserSocket, upstreamSocket);
        websocketServer.emit('connection', browserSocket, request);
        for (const message of entry.earlyMessages) {
          if (browserSocket.bufferedAmount + message.data.length > MAX_BUFFERED_BYTES) {
            browserSocket.close(1013, 'Browser is not keeping up'); upstreamSocket.close(1013, 'Browser is not keeping up'); break;
          }
          browserSocket.send(message.data, { binary: message.isBinary, compress: false });
        }
        entry.earlyMessages.length = 0; entry.earlyBytes = 0;
      });
    });
    upstreamSocket.on('error', error => {
      if (entry.handshaken || entry.canceled) return;
      entry.canceled = true; pending.delete(entry); clearTimeout(entry.timer);
      sendUpgradeError(socket, 502, 'Bad Gateway');
    });
  });

  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      closed = true;
      for (const entry of pending) {
        entry.canceled = true; clearTimeout(entry.timer); entry.socket.destroy(); entry.upstreamSocket.terminate();
      }
      pending.clear();
      for (const pair of pairs) { pair.browserSocket.terminate(); pair.upstreamSocket.terminate(); clearTimeout(pair.closeTimer); }
      pairs.clear();
      await new Promise(resolve => websocketServer.close(() => resolve()));
      await new Promise(resolve => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    })();
    return closePromise;
  } };
}
