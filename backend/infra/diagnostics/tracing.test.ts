import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { CellboxClient, CellboxSandboxProvider, traced } from '@co-cell/sandbox';
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
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    outgoing = new Headers(init?.headers).get('traceparent') ?? '';
    const url = new URL(String(input));
    if (url.pathname === '/v1/operations/op-resume') return Response.json({ id: 'op-resume', kind: 'resume', targetId: 'box',
      status: 'succeeded', version: 2, createdAt: new Date().toISOString() });
    return Response.json({ id: 'box', phase: 'running' });
  };
  const client = new CellboxClient({ baseUrl: 'http://cellbox.test', fetch });
  const providerAdapter = new CellboxSandboxProvider({ baseUrl: 'http://cellbox.test', profileId: 'profile', fetch });
  const app = new Hono();
  app.use('*', traceHttpRequest);
  app.post('/resume', c => {
    submitted = traced('accepted.work', {}, async () => {
      await gate;
      await client.getBox('box');
      await providerAdapter.waitForOperation({ id: 'op-resume', kind: 'resume', targetId: 'box', status: 'running',
        version: 1, createdAt: new Date().toISOString() }, 1000);
      await traced('accepted.failure_probe', {}, async () => { throw new Error('must not be recorded'); }).catch(() => undefined);
    });
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
    const requestSpan = spans.find(span => span.name === 'http.request');
    const workSpan = spans.find(span => span.name === 'accepted.work');
    assert(requestSpan && workSpan);
    assert.equal(workSpan.parentSpanContext?.spanId, requestSpan.spanContext().spanId);
    const operationRequest = spans.find(span => span.name === 'cellbox.http' && span.attributes['url.path'] === '/v1/operations/op-resume');
    assert(operationRequest);
    const wait = spans.find(span => span.name === 'cellbox.operation.wait');
    assert(wait);
    assert.equal(wait.parentSpanContext?.spanId, workSpan.spanContext().spanId);
    assert.equal(operationRequest.parentSpanContext?.spanId, wait.spanContext().spanId);
    assert.equal(wait?.attributes['cellbox.operation.kind'], 'resume');
    assert.equal(wait?.attributes['cellbox.operation.wait_limit_ms'], 1000);
    assert(wait?.events.some(event => event.name === 'cellbox.operation.status' && event.attributes?.['operation.status'] === 'succeeded'));
    const failureProbe = spans.find(span => span.name === 'accepted.failure_probe');
    assert.equal(failureProbe?.status.code, 2);
    assert.equal(failureProbe?.attributes['error.type'], 'Error');
    assert.equal(failureProbe?.attributes['exception.message'], undefined);
  } finally { unblock(); await submitted; await provider.shutdown(); }
});
