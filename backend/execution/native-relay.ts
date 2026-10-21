import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import WebSocket, { WebSocketServer } from 'ws';
import { isAuthenticatedOperatorRequest } from '../access/operator.js';
import { createMessageObservers, type MessageObservation } from './message-observers.js';

export type NativeRelayEvent = MessageObservation;

export type NativeRelayOpen = {
  sandboxId?: string;
  url: string;
  headers?: Record<string, string>;
  release(): Promise<void>;
};

export interface NativeRelayOptions {
  publicUrl: string;
  token: string;
  open(sessionId: string, signal: AbortSignal): Promise<NativeRelayOpen>;
  observe?(event: NativeRelayEvent): Promise<void> | void;
  observers?: Array<{ name: string; observe(event: NativeRelayEvent): Promise<void> | void }>;
  onError(error: unknown): void;
}

const MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;
const MAX_PENDING_REQUESTS = 2048;
const MAX_PENDING_REQUEST_BYTES = 2 * 1024 * 1024;
const MAX_SINGLE_REQUEST_PARAMS_BYTES = 64 * 1024;
const PENDING_REQUEST_TTL_MS = 5 * 60 * 1000;
const OBSERVATION_DRAIN_MS = 2_000;
const SOCKET_CLOSE_MS = 2_000;
const SETUP_TIMEOUT_MS = 30_000;
const UPSTREAM_HANDSHAKE_TIMEOUT_MS = 15_000;
const SESSION_PATH = /^\/api\/sessions\/([^/]+)\/app-server$/;
const CORRELATED_METHODS = new Set(['thread/start', 'thread/resume', 'turn/start', 'turn/steer']);

type PendingRequest = {
  request: NonNullable<NativeRelayEvent['request']>;
  expiresAt: number;
  sizeBytes: number;
};

type RelayConnection = {
  id: string;
  sessionId: string;
  sandboxId?: string;
  client: WebSocket;
  upstream: WebSocket;
  release(): Promise<void>;
  requests: Map<string, PendingRequest[]>;
  pendingRequestCount: number;
  pendingRequestBytes: number;
  closing: boolean;
  closeTimer?: ReturnType<typeof setTimeout>;
  released: boolean;
  releaseTask?: Promise<void>;
};

type PendingSetup = {
  controller: AbortController;
  sandboxId?: string;
};

function safeOnError(onError: NativeRelayOptions['onError'], error: unknown) {
  try { onError(error); } catch { /* Reporting must not affect the relay. */ }
}

function pathSessionId(request: IncomingMessage): string | undefined {
  if (!request.url || !request.url.startsWith('/') || request.url.startsWith('//')) return undefined;
  try {
    const match = SESSION_PATH.exec(new URL(request.url, 'http://relay.invalid').pathname);
    if (!match) return undefined;
    const id = decodeURIComponent(match[1]!);
    return id && !id.includes('/') ? id : undefined;
  } catch { return undefined; }
}

function requestKey(id: string | number) {
  return `${typeof id}:${String(id)}`;
}

function parsedMessage(data: WebSocket.RawData): Record<string, any> | undefined {
  try {
    const text = typeof data === 'string' ? data : Buffer.isBuffer(data)
      ? data.toString('utf8') : Array.isArray(data) ? Buffer.concat(data).toString('utf8') : Buffer.from(data).toString('utf8');
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, any> : undefined;
  } catch { return undefined; }
}

function protocolList(request: IncomingMessage): string[] {
  return (request.headers['sec-websocket-protocol'] ?? '').split(',').map(value => value.trim()).filter(Boolean);
}

function writeRejection(socket: Socket, status: number, message: string) {
  if (socket.destroyed) return;
  const body = `${message}\n`;
  socket.end(`HTTP/1.1 ${status} ${status === 400 ? 'Bad Request' : status === 403 ? 'Forbidden' : status === 502 ? 'Bad Gateway' : 'Service Unavailable'}\r\n` +
    'Connection: close\r\nContent-Type: text/plain; charset=utf-8\r\n' +
    `Content-Length: ${Buffer.byteLength(body)}\r\nCache-Control: no-store\r\n\r\n${body}`);
}

export function createNativeRelay(options: NativeRelayOptions) {
  const publicUrl = new URL(options.publicUrl);
  const publicHost = publicUrl.host.toLowerCase();
  const pending = new Map<AbortController, PendingSetup>();
  const connections = new Set<RelayConnection>();
  const drainingSandboxes = new Map<string, number>();
  const sandboxReleases = new Map<string, Set<Promise<void>>>();
  const observerPlugins = [...(options.observers ?? []), ...(options.observe ? [{ name: 'observe', observe: options.observe }] : [])];
  const observers = observerPlugins.map(plugin => ({
    name: plugin.name,
    dispatcher: createMessageObservers(plugin.observe, error => {
      const contextual = new Error(`Native relay observer "${plugin.name}" failed`, { cause: error });
      safeOnError(options.onError, contextual);
    }),
  }));
  let closing = false;

  const protocolByRequest = new WeakMap<IncomingMessage, string>();
  const wss = new WebSocketServer({
    noServer: true,
    clientTracking: false,
    perMessageDeflate: false,
    maxPayload: MAX_PAYLOAD_BYTES,
    handleProtocols(protocols, request) {
      const selected = protocolByRequest.get(request);
      return selected && protocols.has(selected) ? selected : false;
    },
  });

  function pruneRequests(connection: RelayConnection, now: number) {
    for (const [key, queue] of connection.requests) {
      while (queue[0] && queue[0].expiresAt <= now) {
        const expired = queue.shift()!;
        connection.pendingRequestCount--;
        connection.pendingRequestBytes -= expired.sizeBytes;
      }
      if (!queue.length) connection.requests.delete(key);
    }
  }

  function takeResponseRequest(connection: RelayConnection, message: Record<string, any>, now: number) {
    // A server-initiated JSON-RPC request has a method; its id must never be
    // mistaken for a response to a browser request with the same id.
    if (typeof message.method === 'string' || (typeof message.id !== 'string' && typeof message.id !== 'number')) return undefined;
    pruneRequests(connection, now);
    const key = requestKey(message.id);
    const queue = connection.requests.get(key);
    const matched = queue?.shift();
    if (matched) {
      connection.pendingRequestCount--;
      connection.pendingRequestBytes -= matched.sizeBytes;
      if (!queue?.length) connection.requests.delete(key);
    }
    return matched;
  }

  function rememberClientRequest(connection: RelayConnection, message: Record<string, any>, now: number) {
    if (typeof message.method !== 'string' || (typeof message.id !== 'string' && typeof message.id !== 'number')) return;
    if (!CORRELATED_METHODS.has(message.method) || message.method.length > 128 ||
      (typeof message.id === 'string' && message.id.length > 256)) return;
    pruneRequests(connection, now);
    if (connection.pendingRequestCount >= MAX_PENDING_REQUESTS) {
      safeOnError(options.onError, new Error('Native relay pending request map is full; response correlation was skipped'));
      return;
    }
    let paramsBytes = 0;
    if (message.params !== undefined) {
      try { paramsBytes = Buffer.byteLength(JSON.stringify(message.params)); }
      catch { safeOnError(options.onError, new Error('Native relay request parameters could not be sized; response correlation was skipped')); return; }
      if (paramsBytes > MAX_SINGLE_REQUEST_PARAMS_BYTES) {
        safeOnError(options.onError, new Error('Native relay request parameters exceed the correlation limit; response correlation was skipped'));
        return;
      }
    }
    const requestBytes = paramsBytes + Buffer.byteLength(String(message.method)) + Buffer.byteLength(String(message.id)) + 64;
    if (connection.pendingRequestBytes + requestBytes > MAX_PENDING_REQUEST_BYTES) {
      safeOnError(options.onError, new Error('Native relay pending request byte limit reached; response correlation was skipped'));
      return;
    }
    const key = requestKey(message.id);
    const queue = connection.requests.get(key) ?? [];
    queue.push({ request: { id: message.id, method: message.method, ...(message.params === undefined ? {} : { params: message.params }) },
      expiresAt: now + PENDING_REQUEST_TTL_MS, sizeBytes: requestBytes });
    connection.requests.set(key, queue);
    connection.pendingRequestCount++;
    connection.pendingRequestBytes += requestBytes;
  }

  function trackSandboxRelease(sandboxId: string | undefined, task: Promise<void>) {
    if (!sandboxId) return;
    const tasks = sandboxReleases.get(sandboxId) ?? new Set<Promise<void>>();
    tasks.add(task);
    sandboxReleases.set(sandboxId, tasks);
    const remove = () => {
      tasks.delete(task);
      if (!tasks.size) sandboxReleases.delete(sandboxId);
    };
    void task.then(remove, remove);
  }

  function releaseConnection(connection: RelayConnection): Promise<void> {
    if (connection.releaseTask) return connection.releaseTask;
    connection.released = true;
    if (connection.closeTimer) clearTimeout(connection.closeTimer);
    connections.delete(connection);
    connection.releaseTask = (async () => {
      try { await connection.release(); }
      catch (error) { safeOnError(options.onError, error); }
    })();
    return connection.releaseTask;
  }

  function terminatePair(connection: RelayConnection, code = 1011, reason = 'Relay closed') {
    if (connection.closing) return;
    connection.closing = true;
    const close = (socket: WebSocket) => {
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        try { socket.close(code, Buffer.from(reason).subarray(0, 123).toString()); }
        catch { socket.terminate(); }
      }
    };
    close(connection.client);
    close(connection.upstream);
    connection.closeTimer = setTimeout(() => {
      connection.client.terminate();
      connection.upstream.terminate();
      void releaseConnection(connection);
    }, SOCKET_CLOSE_MS);
    connection.closeTimer.unref?.();
  }

  function forwardMessage(connection: RelayConnection, destination: WebSocket,
    direction: NativeRelayEvent['direction'], data: WebSocket.RawData, isBinary: boolean) {
    if (connection.closing) return;
    const size = Array.isArray(data) ? data.reduce((total, part) => total + part.byteLength, 0)
      : Buffer.isBuffer(data) ? data.byteLength : Buffer.byteLength(String(data));
    if (destination.readyState !== WebSocket.OPEN || destination.bufferedAmount + size > MAX_BUFFERED_BYTES) {
      safeOnError(options.onError, new Error('Native relay backpressure limit exceeded'));
      terminatePair(connection, 1013, 'Relay backpressure limit exceeded');
      return;
    }
    try {
      destination.send(data, { binary: isBinary }, error => {
        if (error) { safeOnError(options.onError, error); terminatePair(connection); }
      });
    } catch (error) {
      safeOnError(options.onError, error);
      terminatePair(connection);
      return;
    }

    const message = parsedMessage(data);
    if (!message) return;
    const receivedAt = Date.now();
    if (direction === 'client') rememberClientRequest(connection, message, receivedAt);
    const matched = direction === 'server' ? takeResponseRequest(connection, message, receivedAt) : undefined;
    const event: NativeRelayEvent = { sessionId: connection.sessionId, connectionId: connection.id,
      direction, message, ...(matched ? { request: matched.request } : {}), receivedAt };
    for (const observer of observers) observer.dispatcher.dispatch(event, size + (matched?.sizeBytes ?? 0));
  }

  function bind(connection: RelayConnection, initialMessages: Array<{ data: WebSocket.RawData; isBinary: boolean }> = []) {
    const forward = (source: WebSocket, destination: WebSocket, direction: NativeRelayEvent['direction']) => {
      source.on('message', (data, isBinary) => forwardMessage(connection, destination, direction, data, isBinary));
      source.on('error', error => { safeOnError(options.onError, error); terminatePair(connection); });
      source.on('close', () => {
        if (!connection.closing) {
          const peer = source === connection.client ? connection.upstream : connection.client;
          connection.closing = true;
          if (peer.readyState === WebSocket.OPEN || peer.readyState === WebSocket.CONNECTING) peer.close(1000, 'Peer closed');
          connection.closeTimer = setTimeout(() => {
            connection.client.terminate(); connection.upstream.terminate(); void releaseConnection(connection);
          }, SOCKET_CLOSE_MS);
          connection.closeTimer.unref?.();
        }
        if (connection.client.readyState === WebSocket.CLOSED && connection.upstream.readyState === WebSocket.CLOSED)
          void releaseConnection(connection);
      });
    };
    forward(connection.client, connection.upstream, 'client');
    forward(connection.upstream, connection.client, 'server');
    for (const message of initialMessages) {
      // The initial server frames arrived before the browser upgrade completed.
      // Replay them through the same path once the destination exists.
      forwardMessage(connection, connection.client, 'server', message.data, message.isBinary);
      if (connection.closing) break;
    }
    if (connection.client.readyState === WebSocket.CLOSED || connection.upstream.readyState === WebSocket.CLOSED)
      terminatePair(connection);
  }

  function matches(request: IncomingMessage): boolean {
    return pathSessionId(request) !== undefined;
  }

  async function upgrade(request: IncomingMessage, socket: Socket, head: Buffer): Promise<void> {
    const sessionId = pathSessionId(request);
    if (!sessionId) { writeRejection(socket, 404, 'Not found'); return; }
    if (closing) { writeRejection(socket, 503, 'Relay is closing'); return; }
    if (request.method !== 'GET' || request.headers.upgrade?.toLowerCase() !== 'websocket') {
      writeRejection(socket, 400, 'Invalid WebSocket upgrade'); return;
    }
    if (request.headers.host?.toLowerCase() !== publicHost || !isAuthenticatedOperatorRequest(request.headers, options.token)) {
      writeRejection(socket, 403, 'Forbidden'); return;
    }
    const origin = request.headers.origin;
    const bearer = request.headers.authorization?.startsWith('Bearer ') === true;
    if (origin !== publicUrl.origin && !(origin === undefined && bearer)) {
      writeRejection(socket, 403, 'Invalid origin'); return;
    }

    const controller = new AbortController();
    const pendingSetup: PendingSetup = { controller };
    pending.set(controller, pendingSetup);
    const abortOnDisconnect = () => controller.abort(new Error('Browser disconnected during relay setup'));
    socket.once('close', abortOnDisconnect);
    socket.once('error', abortOnDisconnect);
    let opened: NativeRelayOpen | undefined;
    let upstream: WebSocket | undefined;
    let releaseStarted = false;
    let releasePromise: Promise<void> | undefined;
    let connectionOwned = false;
    let abandonedOpen = false;
    let setupTimer: ReturnType<typeof setTimeout> | undefined;
    const releaseOpened = async () => {
      if (!opened) return;
      if (releaseStarted) return releasePromise;
      releaseStarted = true;
      releasePromise = Promise.resolve().then(() => opened!.release());
      trackSandboxRelease(opened.sandboxId, releasePromise);
      await releasePromise;
    };
    const earlyMessages: Array<{ data: WebSocket.RawData; isBinary: boolean }> = [];
    let earlyBytes = 0;
    let earlyOverflow = false;
    let earlyClosed = false;
    let earlyError: Error | undefined;
    const onEarlyMessage = (data: WebSocket.RawData, isBinary: boolean) => {
      const size = Array.isArray(data) ? data.reduce((total, part) => total + part.byteLength, 0)
        : Buffer.isBuffer(data) ? data.byteLength : Buffer.byteLength(String(data));
      if (earlyBytes + size > MAX_BUFFERED_BYTES) {
        earlyOverflow = true;
        upstream?.terminate();
        return;
      }
      earlyMessages.push({ data, isBinary });
      earlyBytes += size;
    };
    const onEarlyError = (error: Error) => { earlyError = error; };
    const onEarlyClose = () => { earlyClosed = true; };
    try {
      setupTimer = setTimeout(() => controller.abort(new Error('Native relay setup timed out')), SETUP_TIMEOUT_MS);
      setupTimer.unref?.();
      const opening = options.open(sessionId, controller.signal);
      void opening.then(value => {
        pendingSetup.sandboxId = value.sandboxId;
        if (value.sandboxId && drainingSandboxes.has(value.sandboxId))
          controller.abort(new Error('Sandbox is draining'));
        if (abandonedOpen) {
          const lateRelease = Promise.resolve().then(() => value.release());
          trackSandboxRelease(value.sandboxId, lateRelease);
          void lateRelease.catch(error => safeOnError(options.onError, error));
        }
      }, error => { if (abandonedOpen) safeOnError(options.onError, error); });
      let removeAbortListener = () => {};
      const abortPromise = new Promise<never>((_resolve, reject) => {
        const rejectAbort = () => reject(controller.signal.reason ?? new Error('Relay setup aborted'));
        if (controller.signal.aborted) rejectAbort();
        else {
          controller.signal.addEventListener('abort', rejectAbort, { once: true });
          removeAbortListener = () => controller.signal.removeEventListener('abort', rejectAbort);
        }
      });
      try { opened = await Promise.race([opening, abortPromise]); }
      catch (error) { abandonedOpen = true; throw error; }
      finally { removeAbortListener(); }
      pendingSetup.sandboxId = opened.sandboxId;
      controller.signal.throwIfAborted();
      if (closing || (opened.sandboxId && drainingSandboxes.has(opened.sandboxId)))
        throw new Error(closing ? 'Relay is closing' : 'Sandbox is draining');
      const protocols = protocolList(request);
      upstream = new WebSocket(opened.url, protocols, { headers: opened.headers, maxPayload: MAX_PAYLOAD_BYTES,
        handshakeTimeout: UPSTREAM_HANDSHAKE_TIMEOUT_MS, perMessageDeflate: false });
      upstream.on('message', onEarlyMessage);
      upstream.on('error', onEarlyError);
      upstream.on('close', onEarlyClose);
      await new Promise<void>((resolve, reject) => {
        const onOpen = () => { cleanup(); resolve(); };
        const onError = (error: Error) => { cleanup(); reject(error); };
        const onAbort = () => { cleanup(); upstream?.terminate(); reject(controller.signal.reason ?? new Error('Relay setup aborted')); };
        const cleanup = () => {
          upstream?.off('open', onOpen);
          upstream?.off('error', onError);
          controller.signal.removeEventListener('abort', onAbort);
        };
        upstream!.once('open', onOpen);
        upstream!.once('error', onError);
        controller.signal.addEventListener('abort', onAbort, { once: true });
        if (controller.signal.aborted) onAbort();
      });
      controller.signal.throwIfAborted();
      if (closing || socket.destroyed || earlyClosed || earlyError || earlyOverflow)
        throw earlyError ?? new Error(earlyOverflow ? 'App Server sent too much data before browser upgrade' : 'Relay setup was cancelled');
      if (upstream.protocol) protocolByRequest.set(request, upstream.protocol);
      let callbackCalled = false;
      wss.handleUpgrade(request, socket, head, client => {
        callbackCalled = true;
        socket.off('close', abortOnDisconnect);
        socket.off('error', abortOnDisconnect);
        upstream?.off('message', onEarlyMessage);
        upstream?.off('error', onEarlyError);
        upstream?.off('close', onEarlyClose);
        if (closing || (opened?.sandboxId && drainingSandboxes.has(opened.sandboxId))) {
          client.terminate(); upstream?.terminate();
          void releaseOpened().catch(error => safeOnError(options.onError, error));
          return;
        }
        if (!upstream || upstream.readyState !== WebSocket.OPEN) {
          client.terminate(); upstream?.terminate();
          void releaseOpened().catch(error => safeOnError(options.onError, error));
          return;
        }
        const relay: RelayConnection = { id: randomUUID(), sessionId, sandboxId: pendingSetup.sandboxId, client, upstream, release: releaseOpened,
          requests: new Map(), pendingRequestCount: 0, pendingRequestBytes: 0, closing: false, released: false };
        connectionOwned = true;
        connections.add(relay);
        bind(relay, earlyMessages);
      });
      if (!callbackCalled) throw new Error('WebSocket upgrade did not complete');
    } catch (error) {
      socket.off('close', abortOnDisconnect);
      socket.off('error', abortOnDisconnect);
      upstream?.off('message', onEarlyMessage);
      upstream?.off('error', onEarlyError);
      upstream?.off('close', onEarlyClose);
      if (upstream && upstream.readyState !== WebSocket.CLOSED) {
        // ws emits an error when a connecting socket is terminated. Keep a
        // listener installed until its close event even after setup cleanup.
        upstream.on('error', onEarlyError);
        upstream.terminate();
      }
      if (!socket.destroyed) writeRejection(socket, closing ? 503 : 502, closing ? 'Relay is closing' : 'Unable to connect to App Server');
      if (!connectionOwned && opened) {
        try { await releaseOpened(); } catch (releaseError) { safeOnError(options.onError, releaseError); }
      }
      if (!controller.signal.aborted) safeOnError(options.onError, error);
    } finally {
      if (setupTimer) clearTimeout(setupTimer);
      pending.delete(controller);
    }
  }

  async function closeSandbox(sandboxId: string): Promise<void> {
    if (!sandboxId) return;
    drainingSandboxes.set(sandboxId, (drainingSandboxes.get(sandboxId) ?? 0) + 1);
    const deadline = Date.now() + SOCKET_CLOSE_MS + OBSERVATION_DRAIN_MS;
    try {
      for (const setup of pending.values()) {
        if (setup.sandboxId === sandboxId)
          setup.controller.abort(new Error('Sandbox is draining'));
      }
      const matching = () => [...connections].filter(connection => connection.sandboxId === sandboxId);
      for (const connection of matching()) terminatePair(connection, 1001, 'Sandbox is pausing');
      while (Date.now() < deadline) {
        const remaining = matching();
        const pendingMatching = [...pending.values()].some(setup => setup.sandboxId === sandboxId);
        if (!remaining.length && !pendingMatching && !sandboxReleases.has(sandboxId)) break;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      const remaining = matching();
      const releases = remaining.map(connection => {
        connection.client.terminate();
        connection.upstream.terminate();
        return releaseConnection(connection);
      });
      releases.push(...(sandboxReleases.get(sandboxId) ?? []));
      const stillPending = [...pending.values()].filter(setup => setup.sandboxId === sandboxId);
      for (const setup of stillPending) setup.controller.abort(new Error('Sandbox is draining'));
      const timeLeft = Math.max(0, deadline - Date.now());
      if (releases.length && timeLeft > 0) {
        await Promise.race([Promise.all(releases), new Promise(resolve => setTimeout(resolve, timeLeft))]);
      }
    } finally {
      const activeDrains = (drainingSandboxes.get(sandboxId) ?? 1) - 1;
      if (activeDrains > 0) drainingSandboxes.set(sandboxId, activeDrains);
      else drainingSandboxes.delete(sandboxId);
    }
  }

  async function close(): Promise<void> {
    if (closing) return;
    closing = true;
    for (const controller of pending.keys()) controller.abort(new Error('Relay is closing'));
    for (const connection of connections) terminatePair(connection, 1001, 'Relay is shutting down');
    const deadline = Date.now() + SOCKET_CLOSE_MS + OBSERVATION_DRAIN_MS;
    while ((pending.size || connections.size) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    for (const connection of connections) {
      connection.client.terminate(); connection.upstream.terminate(); await releaseConnection(connection);
    }
    await Promise.all(observers.map(observer => observer.dispatcher.close(OBSERVATION_DRAIN_MS)));
    await new Promise<void>(resolve => wss.close(() => resolve()));
  }

  return { matches, upgrade, close, closeSandbox };
}
