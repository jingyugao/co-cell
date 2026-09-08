import { createServer, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { chmod, mkdir, open, writeFile, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const secretName = /authorization|cookie|api[-_]?key|token|secret|password|credential|signature/i;
const hopHeaders = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'];

function safeUrl(value: string): string {
  const url = new URL(value, 'http://capture.invalid');
  url.username = ''; url.password = '';
  for (const key of url.searchParams.keys()) if (secretName.test(key)) url.searchParams.set(key, '[REDACTED]');
  return value.startsWith('/') ? `${url.pathname}${url.search}` : url.toString();
}

function safeHeaders(headers: IncomingHttpHeaders) {
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key,
    secretName.test(key) ? '[REDACTED]' : ['location', 'referer'].includes(key) && typeof value === 'string' ? safeUrl(value) : value,
  ]));
}

function forwardHeaders(headers: IncomingHttpHeaders) {
  const result = { ...headers };
  const connection = headers.connection?.split(',').map(value => value.trim().toLowerCase()) ?? [];
  for (const key of [...hopHeaders, ...connection]) delete result[key];
  return result;
}

function recorder(file: FileHandle, count: { bytes: number }) {
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      file.writeFile(chunk).then(() => { count.bytes += chunk.length; callback(null, chunk); }, callback);
    },
  });
}

/** Records HTTP entity bytes (including SSE), without decoding or buffering the response. */
export async function startHttpCapture(options: { upstreamBaseUrl: string; directory: string; port?: number }) {
  const upstreamBase = new URL(options.upstreamBaseUrl);
  if (!['http:', 'https:'].includes(upstreamBase.protocol) || upstreamBase.username || upstreamBase.password || upstreamBase.hash) {
    throw new Error('Capture upstream must be an HTTP(S) URL without userinfo or fragment');
  }
  await mkdir(options.directory, { recursive: true, mode: 0o700 });
  await chmod(options.directory, 0o700);
  let sequence = 0;
  const active = new Set<Promise<void>>();
  const outgoing = new Set<ReturnType<typeof httpRequest>>();
  const save = (directory: string, name: string, data: unknown) => writeFile(join(directory, name), `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  async function nextDirectory() {
    for (;;) {
      const directory = join(options.directory, String(++sequence).padStart(6, '0'));
      try { await mkdir(directory, { mode: 0o700 }); return directory; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    }
  }
  const server = createServer((request, response) => {
    const task = (async () => {
      let requestFile: FileHandle | undefined;
      let responseFile: FileHandle | undefined;
      let upstream: ReturnType<typeof httpRequest> | undefined;
      try {
        const directory = await nextDirectory();
        // Resolve only the incoming path: clients cannot redirect this recorder to another host.
        const incoming = new URL(request.url ?? '/', 'http://capture.invalid');
        const target = new URL(upstreamBase);
        target.pathname = `${upstreamBase.pathname.replace(/\/$/, '')}/${incoming.pathname.replace(/^\//, '')}`;
        for (const [key, value] of incoming.searchParams) target.searchParams.append(key, value);
        const headers = forwardHeaders(request.headers);
        headers.host = target.host;
        const requestMeta = { method: request.method, path: safeUrl(request.url ?? '/'), url: safeUrl(target.toString()), headers: safeHeaders(headers) };
        const requestCount = { bytes: 0 };
        const responseCount = { bytes: 0 };
        let responseMeta: Record<string, unknown> = { status: null, headers: {} };
        let upstreamResponse: IncomingMessage | undefined;
        let clientAborted = false;
        await save(directory, 'request.json', requestMeta);
        await save(directory, 'response.json', responseMeta);
        requestFile = await open(join(directory, 'request.body'), 'wx', 0o600);
        responseFile = await open(join(directory, 'response.body'), 'wx', 0o600);
        upstream = (target.protocol === 'https:' ? httpsRequest : httpRequest)(target, { method: request.method, headers });
        outgoing.add(upstream);
        const transport = upstream;
        const remote = new Promise<IncomingMessage>((resolve, reject) => {
          transport.once('response', resolve);
          transport.once('error', reject);
        });
        const onClientClose = () => {
          if (!response.writableFinished) {
            clientAborted = true;
            transport.destroy(new Error('Capture client disconnected'));
          }
        };
        response.once('close', onClientClose);
        if (response.destroyed || request.destroyed) { clientAborted = true; transport.destroy(new Error('Capture client disconnected')); }
        const upload = pipeline(request, recorder(requestFile, requestCount), transport);
        // Attach rejection handlers immediately: the request may fail before response headers arrive.
        const uploadResult = upload.then(() => true, () => false);
        const downloadResult = (async () => {
          const received = await remote;
          upstreamResponse = received;
          responseMeta = { status: received.statusCode, statusMessage: received.statusMessage, headers: safeHeaders(received.headers) };
          await save(directory, 'response.json', responseMeta);
          response.writeHead(received.statusCode ?? 502, received.statusMessage, forwardHeaders(received.headers));
          response.flushHeaders();
          await pipeline(received, recorder(responseFile!, responseCount), response);
          return true;
        })().catch(() => {
          transport.destroy();
          if (!response.headersSent && !response.destroyed) { response.writeHead(502); response.end('Upstream capture transport failed'); }
          else if (!response.writableFinished) response.destroy();
          return false;
        });
        const [requestComplete, responseComplete] = await Promise.all([uploadResult, downloadResult]);
        response.removeListener('close', onClientClose);
        await Promise.all([
          save(directory, 'request.json', { ...requestMeta, bytes: requestCount.bytes, complete: requestComplete }),
          save(directory, 'response.json', {
            ...responseMeta, bytes: responseCount.bytes, complete: responseComplete,
            upstreamComplete: upstreamResponse?.complete ?? false,
            clientAborted,
            // Codex may disconnect immediately after response.completed, before HTTP EOF.
            // This describes the transport only; callers can separately inspect SSE events.
            terminationReason: responseComplete ? 'upstream-ended' : clientAborted ? 'client-disconnected' : 'upstream-error',
          }),
        ]);
      } catch {
        upstream?.destroy();
        if (!response.headersSent && !response.destroyed) { response.writeHead(500); response.end('HTTP capture failed'); }
        else if (!response.writableFinished) response.destroy();
      } finally {
        if (upstream) outgoing.delete(upstream);
        await Promise.allSettled([requestFile?.close(), responseFile?.close()]);
      }
    })();
    active.add(task);
    void task.finally(() => active.delete(task));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Capture listener has no TCP address');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    async close() {
      const stopped = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      for (const request of outgoing) request.destroy(new Error('Capture closing'));
      server.closeAllConnections();
      await stopped;
      await Promise.allSettled([...active]);
    },
  };
}
