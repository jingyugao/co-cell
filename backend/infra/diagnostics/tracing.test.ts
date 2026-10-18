import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { CellboxClient, CellboxSandboxProvider, traced } from '@co-cell/sandbox';
import { context } from '@opentelemetry/api';
import { retainProjectRequestTrace, traceHttpRequest } from './tracing.js';

const exporter = new InMemorySpanExporter();
const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
provider.register();

test('accepted background work retains incoming trace after response and caller abort', async () => {
  exporter.reset();
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
  const providerAdapter = new CellboxSandboxProvider({ baseUrl: 'http://cellbox.test', profileId: 'profile', revisionId: 'revision', fetch });
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
    const operationRequest = spans.find(span => span.name === 'cellbox.http.client' && span.attributes['url.path'] === '/v1/operations/op-resume');
    assert.equal(operationRequest, undefined, 'metadata long polls should propagate context without adding a client span');
    const wait = spans.find(span => span.name === 'cellbox.operation.wait');
    assert(wait);
    assert.equal(wait.parentSpanContext?.spanId, workSpan.spanContext().spanId);
    assert.equal(outgoing.split('-')[2], wait.spanContext().spanId, 'the untraced GET must still propagate its wait span');
    assert.equal(wait?.attributes['cellbox.operation.kind'], 'resume');
    assert.equal(wait?.attributes['cellbox.operation.wait_limit_ms'], 1000);
    assert(wait?.events.some(event => event.name === 'cellbox.operation.status' && event.attributes?.['operation.status'] === 'succeeded'));
    const failureProbe = spans.find(span => span.name === 'accepted.failure_probe');
    assert.equal(failureProbe?.status.code, 2);
    assert.equal(failureProbe?.attributes['error.type'], 'Error');
    assert.equal(failureProbe?.attributes['exception.message'], undefined);
  } finally { unblock(); await submitted; }
});

test('project lifecycle envelope remains the trace root until async work releases it', async () => {
  exporter.reset();
  const traceId = 'abcdef0123456789abcdef0123456789';
  let unblock!: () => void;
  const gate = new Promise<void>(resolve => { unblock = resolve; });
  let work!: Promise<void>;
  let release!: (error?: unknown) => void;
  const app = new Hono();
  app.use('*', traceHttpRequest);
  app.post('/api/projects/:id/open', c => {
    const retained = retainProjectRequestTrace();
    assert(retained);
    release = retained.release;
    work = context.with(retained.context, () => traced('project.resume', {}, () => gate));
    return c.json({ accepted: true }, 202);
  });
  try {
    const caller = new AbortController();
    const response = await app.request('/api/projects/project-1/open', { method: 'POST', signal: caller.signal,
      headers: { traceparent: `00-${traceId}-0123456789abcdef-01` } });
    assert.equal(response.status, 202);
    assert.equal(response.headers.get('X-Trace-Id'), traceId);
    caller.abort();
    await new Promise<void>(resolve => setImmediate(resolve));
    let spans = exporter.getFinishedSpans();
    assert(spans.some(span => span.name === 'http.request'));
    assert.equal(spans.some(span => span.name === 'project.request'), false,
      'the envelope stays open while accepted lifecycle work retains it');

    unblock();
    await work;
    release(new Error('resume failed after acceptance'));
    release(new Error('release is idempotent'));
    await new Promise<void>(resolve => setImmediate(resolve));
    spans = exporter.getFinishedSpans();
    const envelope = spans.find(span => span.name === 'project.request');
    const request = spans.find(span => span.name === 'http.request');
    const resume = spans.find(span => span.name === 'project.resume');
    assert(envelope && request && resume);
    assert.equal(envelope.spanContext().traceId, traceId);
    assert.equal(request.parentSpanContext?.spanId, envelope.spanContext().spanId);
    assert.equal(resume.parentSpanContext?.spanId, envelope.spanContext().spanId);
    assert.equal(resume.spanContext().traceId, traceId);
    assert.equal(envelope.status.code, 2, 'an asynchronous failure marks the envelope error');
    assert.equal(envelope.attributes['error.type'], 'Error');
    assert.equal(envelope.attributes['exception.message'], undefined, 'raw errors are not attached to the root');
  } finally { unblock(); release?.(); await work; }
});

test.after(() => provider.shutdown());
