import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { createProxyServer } from 'httpxy';
import { isAuthenticatedPreviewRequest, PREVIEW_CALLBACK, type OperatorAccessOptions } from '../access/operator.js';
import type { ServiceProxyAccess } from '../execution/container-runtime.js';
import { HttpError } from '../../util/errors.js';
import { parseServiceHost, type ServiceTarget } from './service-host.js';
import { applicationCookies, applicationSetCookie, previewLocation } from './preview-policy.js';

export interface PreviewProxyOptions extends Pick<OperatorAccessOptions, 'token' | 'publicUrl' | 'projects' | 'refreshProjects'> {
  access(projectId: string, port: number, method: string, signal: AbortSignal): Promise<ServiceProxyAccess & { signal: AbortSignal }>;
  onError?: (error: unknown) => void;
}

type Metadata = { target: ServiceTarget; path: string };

/** Native streams stay outside Hono's Request/Response conversion. */
export function createPreviewProxy(options: PreviewProxyOptions) {
  const publicUrl = new URL(options.publicUrl);
  const proxy = createProxyServer({ changeOrigin: true, xfwd: false, followRedirects: false });
  const metadata = new WeakMap<IncomingMessage, Metadata>();
  const connections = new Set<ServerResponse | Socket>();
  const forwards = new Set<Promise<void>>();
  let closing = false;

  const rewriteResponse = (upstream: IncomingMessage, request: IncomingMessage) => {
    const meta = metadata.get(request);
    if (!meta) return;
    const cookies = upstream.headers['set-cookie']?.map(applicationSetCookie).filter((value): value is string => Boolean(value));
    if (cookies?.length) upstream.headers['set-cookie'] = cookies; else delete upstream.headers['set-cookie'];
    for (const name of Object.keys(upstream.headers)) {
      if (/^x-cellbox-/i.test(name)) delete upstream.headers[name];
    }
    if (upstream.headers.location) upstream.headers.location = previewLocation(upstream.headers.location, meta.target.port, meta.path);
    upstream.headers['cache-control'] = 'no-store';
    upstream.headers['referrer-policy'] = 'same-origin';
    upstream.headers['x-content-type-options'] = 'nosniff';
    upstream.headers['strict-transport-security'] = 'max-age=86400';
  };
  proxy.on('proxyRes', rewriteResponse);
  proxy.on('proxyReqWs', (upstream, request, socket) => {
    // Apply the same cookie boundary to both successful and rejected upgrades.
    upstream.on('upgrade', (response, proxySocket) => {
      rewriteResponse(response, request);
      socket.once('close', () => proxySocket.destroy());
    });
    upstream.on('response', response => rewriteResponse(response, request));
    socket.once('end', () => socket.destroy());
    socket.once('close', () => upstream.destroy());
  });

  function resolve(request: IncomingMessage): ServiceTarget | null {
    return parseServiceHost(request.headers.host ?? '', options.publicUrl, options.token, options.projects().map(p => p.id));
  }

  async function resolveTarget(request: IncomingMessage): Promise<ServiceTarget | null> {
    let target = resolve(request);
    if (!target && request.headers.host?.toLowerCase().endsWith(`.${publicUrl.host.toLowerCase()}`)) {
      await options.refreshProjects?.();
      target = resolve(request);
    }
    return target;
  }

  function validPath(request: IncomingMessage): boolean {
    return Boolean(request.url?.startsWith('/') && !request.url.startsWith('//') && !/[\\\u0000-\u001f\u007f]/.test(request.url));
  }

  function authenticated(request: IncomingMessage): boolean {
    return isAuthenticatedPreviewRequest(request.headers, request.headers.host ?? '', options.token);
  }

  function validOrigin(request: IncomingMessage): boolean {
    return request.headers.origin === undefined || request.headers.origin === `${publicUrl.protocol}//${request.headers.host?.toLowerCase()}`;
  }

  function sanitize(request: IncomingMessage, access: ServiceProxyAccess) {
    const cookie = applicationCookies(request.headers.cookie);
    if (cookie) request.headers.cookie = cookie; else delete request.headers.cookie;
    if (request.headers.authorization === `Bearer ${options.token}`) delete request.headers.authorization;
    for (const name of Object.keys(request.headers)) {
      if (/^(x-cellbox-|x-forwarded-)/i.test(name) || ['forwarded', 'proxy-authorization', 'proxy-authenticate'].includes(name)) delete request.headers[name];
    }
    // Internal headers come exclusively from the configured Cellbox provider.
    for (const [name, value] of Object.entries(access.headers)) request.headers[name.toLowerCase()] = value;
  }

  async function forward(request: IncomingMessage, response: ServerResponse | Socket, target: ServiceTarget, head?: Buffer) {
    connections.add(response);
    const controller = new AbortController();
    const closed = () => controller.abort();
    response.once('close', closed);
    request.once('aborted', closed);
    let access: Awaited<ReturnType<PreviewProxyOptions['access']>> | undefined;
    let abort: (() => void) | undefined;
    try {
      access = await options.access(target.projectId, target.port, request.method ?? 'GET', controller.signal);
      access.signal.throwIfAborted();
      abort = () => response.destroy();
      access.signal.addEventListener('abort', abort, { once: true });
      metadata.set(request, { target, path: request.url! });
      sanitize(request, access);
      const proxyOptions = { target: access.url.replace(/\/$/, ''), headers: access.headers };
      if (head !== undefined) await proxy.ws(request, response as Socket, proxyOptions, head);
      else await proxy.web(request, response as ServerResponse, proxyOptions);
    } catch (error) {
      if (!controller.signal.aborted) {
        options.onError?.(error);
        const status = error instanceof HttpError ? error.status : 502;
        if ('writeHead' in response) {
          if (!response.headersSent) { response.writeHead(status, { 'content-type': 'text/plain', 'cache-control': 'no-store' }); response.end('Preview service unavailable'); }
          else response.destroy();
        } else if (!response.destroyed) response.end(`HTTP/1.1 ${status} Preview service unavailable\r\nConnection: close\r\n\r\n`);
      }
    } finally {
      response.removeListener('close', closed);
      request.removeListener('aborted', closed);
      if (access && abort) access.signal.removeEventListener('abort', abort);
      metadata.delete(request);
      await access?.release().catch(error => options.onError?.(error));
      connections.delete(response);
    }
  }

  function runForward(request: IncomingMessage, response: ServerResponse | Socket, target: ServiceTarget, head?: Buffer) {
    const task = forward(request, response, target, head);
    forwards.add(task);
    void task.finally(() => forwards.delete(task)).catch(() => {});
    return task;
  }

  return {
    async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
      if (closing) { response.writeHead(503); response.end('Preview proxy is closing'); return true; }
      const target = await resolveTarget(request);
      if (closing) { response.writeHead(503); response.end('Preview proxy is closing'); return true; }
      if (!target || !authenticated(request)) return false;
      if (!validPath(request)) { response.writeHead(400); response.end('Invalid path'); return true; }
      if (new URL(request.url!, publicUrl).pathname === PREVIEW_CALLBACK) return false;
      if (!validOrigin(request)) { response.writeHead(403); response.end('Invalid origin'); return true; }
      await runForward(request, response, target);
      return true;
    },
    async upgrade(request: IncomingMessage, socket: Socket, head: Buffer): Promise<void> {
      const target = await resolveTarget(request);
      if (closing || !target || !validPath(request) || !authenticated(request) || !validOrigin(request) ||
        request.method !== 'GET' || request.headers.upgrade?.toLowerCase() !== 'websocket' ||
        new URL(request.url!, publicUrl).pathname === PREVIEW_CALLBACK) {
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
      }
      await runForward(request, socket, target, head);
    },
    async close() {
      closing = true;
      for (const connection of connections) connection.destroy();
      await Promise.allSettled([...forwards]);
      proxy.close();
    },
  };
}
