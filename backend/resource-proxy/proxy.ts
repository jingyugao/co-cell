import { request as httpRequest, type IncomingMessage, type ServerResponse, type OutgoingHttpHeaders } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { pipeline } from 'node:stream/promises';
import { RESOURCE_NAME, type ApiResourceList } from '../../protocol/api-resource-types.js';
import { HttpError } from '../../util/errors.js';
import type { ApiResourceStore } from './store.js';

const methods = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
const requestHeaders = ['accept', 'accept-encoding', 'accept-language', 'content-type', 'content-encoding', 'content-length',
  'if-match', 'if-none-match', 'if-modified-since', 'if-unmodified-since', 'if-range', 'range', 'user-agent', 'idempotency-key'];
const responseExcluded = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'set-cookie']);

function upstreamPath(endpoint: URL, suffix: string) {
  const query = suffix.indexOf('?');
  const path = query < 0 ? suffix : suffix.slice(0, query);
  let decoded: string;
  try { decoded = decodeURIComponent(path); } catch { throw new HttpError(400, '请求路径编码无效'); }
  if (decoded.startsWith('//') || decoded.includes('\\') || decoded.split('/').some(part => part === '.' || part === '..'))
    throw new HttpError(400, '无效的上游路径');
  return endpoint.pathname.replace(/\/$/, '') + (path || '/') + (query < 0 ? '' : suffix.slice(query));
}

function json(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(body));
}

export function createResourceProxy(store: Pick<ApiResourceStore, 'projectForBox' | 'available' | 'upstream'>,
  boxForPeer: (address: string) => Promise<string>) {
  return async (request: IncomingMessage, response: ServerResponse) => {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    response.on('close', cancel);
    try {
      const box = await boxForPeer(request.socket.remoteAddress ?? '');
      const project = await store.projectForBox(box);
      const target = request.url ?? '';
      if (/^\/proxy\/?(?:\?|$)/.test(target)) {
        if (request.method !== 'GET') throw new HttpError(405, '资源列表仅支持 GET');
        json(response, 200, { resources: await store.available(project) } satisfies ApiResourceList);
        return;
      }
      const route = /^\/proxy\/([^/?]+)(.*)$/.exec(target);
      if (!route || !RESOURCE_NAME.test(route[1])) throw new HttpError(400, '代理路径中缺少有效的服务名');
      const [, service, suffix] = route;
      if (!methods.has(request.method ?? '')) throw new HttpError(405, '不支持此请求方法');
      const upstream = await store.upstream(project, service);
      const endpoint = new URL(upstream.endpoint);
      const path = upstreamPath(endpoint, suffix);
      const headers: OutgoingHttpHeaders = Object.create(null);
      for (const name of requestHeaders) if (request.headers[name] !== undefined) headers[name] = request.headers[name];
      Object.assign(headers, upstream.headers);
      const timeout = AbortSignal.timeout(60_000);
      const signal = AbortSignal.any([controller.signal, timeout]);
      const send = endpoint.protocol === 'https:' ? httpsRequest : httpRequest;
      // Node streams the original bytes (including compressed bodies) and never follows redirects.
      try {
        const upstreamResponse = await new Promise<IncomingMessage>((resolve, reject) => {
          const outgoing = send(endpoint, { path, method: request.method, headers, signal }, resolve);
          outgoing.on('error', reject);
          request.pipe(outgoing);
          outgoing.once('close', () => request.unpipe(outgoing));
        });
        const connectionHeaders = (upstreamResponse.headers.connection ?? '').toLowerCase().split(',').map(name => name.trim());
        const outgoingHeaders = { ...upstreamResponse.headers };
        for (const name of [...responseExcluded, ...connectionHeaders, upstream.authHeader]) delete outgoingHeaders[name];
        // Keep response representation metadata, but suppress echoed custom credential headers.
        for (const [name, value] of Object.entries(upstream.headers)) {
          if (!name.startsWith('content-') && outgoingHeaders[name] === value) delete outgoingHeaders[name];
        }
        outgoingHeaders['cache-control'] = 'no-store';
        response.writeHead(upstreamResponse.statusCode ?? 502, outgoingHeaders);
        await pipeline(upstreamResponse, response, { signal });
      } catch {
        throw new HttpError(timeout.aborted ? 504 : 502, timeout.aborted ? '上游请求超时' : '上游连接失败');
      }
    } catch (error) {
      if (response.headersSent || response.destroyed) { response.destroy(); return; }
      json(response, error instanceof HttpError ? error.status : 500,
        { error: error instanceof HttpError ? error.message : '代理请求失败' });
    } finally { response.off('close', cancel); }
  };
}
