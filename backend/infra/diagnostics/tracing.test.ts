import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { CellboxClient, traced } from '@co-cell/sandbox';
import { traceHttpRequest } from './tracing.js';

test('accepted background work retains incoming trace after response and caller abort', async () => {
  const exporter = new InMemorySpanExporter();
  const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  provider.register();
  const traceId = '0123456789abcdef0123456789abcdef';
  let unblock!: () => void;
  const gate = new Promise<void>(resolve => { unblock = resolve; });
  let submitted!: Promise<void>;
  let outgoing = '';
  const client = new CellboxClient({ baseUrl: 'http://cellbox.test', fetch: async (_url, init) => {
    outgoing = new Headers(init?.headers).get('traceparent') ?? '';
    return Response.json({ id: 'box', phase: 'running' });
  } });
  const app = new Hono();
  app.use('*', traceHttpRequest);
  app.post('/resume', c => {
    submitted = traced('accepted.work', {}, async () => { await gate; await client.getBox('box'); });
    return c.json({ accepted: true }, 202);
  });
  const caller = new AbortController();
  try {
    const response = await app.request('/resume', { method: 'POST', signal: caller.signal,
      headers: { traceparent: `00-${traceId}-0123456789abcdef-01` } });
    assert.equal(response.status, 202);
    assert.equal(response.headers.get('X-Trace-Id'), traceId);
    caller.abort();
    unblock();
    await submitted;
    assert.equal(outgoing.split('-')[1], traceId);
    const spans = exporter.getFinishedSpans();
    assert(spans.every(span => span.spanContext().traceId === traceId));
    assert(spans.some(span => span.name === 'accepted.work'));
    assert(spans.some(span => span.name === 'cellbox.http'));
  } finally { unblock(); await submitted; await provider.shutdown(); }
});
