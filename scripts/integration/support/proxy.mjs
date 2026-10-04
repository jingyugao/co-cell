import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/** Loopback transport for the real application, including streaming SSE.
 * Credentials stay in Node; browser artifacts never contain the operator token.
 */
export async function startBrowserProxy(environment) {
  const server = createServer(async (request, response) => {
    const abort = new AbortController();
    response.on('close', () => abort.abort());
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const input = Buffer.concat(chunks).toString();
      const options = { method: request.method, signal: abort.signal,
        ...(input ? { body: JSON.parse(input) } : {}), expectedStatus: null };
      if (request.url.endsWith('/events')) {
        const upstream = await environment.fetch(request.url, { ...options, timeoutMs: environment.config.turnTimeout });
        response.writeHead(upstream.status, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
        if (upstream.body) await pipeline(Readable.fromWeb(upstream.body), response);
        else response.end();
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
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve()); server.closeAllConnections();
  }) };
}
