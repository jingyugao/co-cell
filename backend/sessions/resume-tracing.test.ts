import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Hono } from 'hono';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { traced } from '@co-cell/sandbox';
import type { Project, Settings } from '../../protocol/types.js';
import type { SandboxRuntime } from '../execution/container-runtime.js';
import { installProjectsRoutes } from '../projects/routes.js';
import { MemoryWebStateStore } from '../testing/memory-web-state.js';
import { traceHttpRequest } from '../infra/diagnostics/tracing.js';
import { SessionManager, type CodexClient } from './manager.js';

test('read-only project entry does not resume; explicit resume trace spans cover one submission', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cocell-resume-trace-'));
  const exporter = new InMemorySpanExporter();
  const tracerProvider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  tracerProvider.register();
  const defaults: Settings = { executionMode: 'sandbox', workingDirectory: '/home/agent/workspace', model: 'test',
    modelReasoningEffort: 'low', sandboxMode: 'danger-full-access', webSearchMode: 'disabled', networkAccessEnabled: true };
  const at = new Date().toISOString();
  const project: Project = { id: 'trace-project', name: 'Trace project', type: 1, requirementUrl: null,
    status: 'active', executionMode: 'sandbox', workingDirectory: defaults.workingDirectory, completedAt: null, archivedAt: null,
    createdAt: at, updatedAt: at, sandbox: { id: 'trace-box', status: 'paused', template: 'default',
      workingDirectory: defaults.workingDirectory, pausedAt: at } };
  const state = new MemoryWebStateStore();
  await state.saveProject(project);
  let calls = 0;
  let finishResume!: () => void;
  let resumeStarted!: () => void;
  const started = new Promise<void>(resolve => { resumeStarted = resolve; });
  const barrier = new Promise<void>(resolve => { finishResume = resolve; });
  const runtime = {
    async close() {},
    async querySandbox(value) { return { ...value, status: 'paused' as const }; },
    async resume(target) {
      calls++;
      await traced('test.resume.runtime', {}, async () => { resumeStarted(); await barrier; });
      return { ...target.sandbox!, status: 'ready' as const, pausedAt: undefined };
    },
  } satisfies Partial<SandboxRuntime>;
  const manager = new SessionManager({} as CodexClient, directory, defaults, state, runtime as SandboxRuntime);
  const app = new Hono();
  app.use('*', traceHttpRequest);
  installProjectsRoutes(app, manager);
  try {
    await manager.init();
    const entry = await app.request('/api/projects/trace-project/open', { method: 'POST' });
    assert.equal(entry.status, 200);
    assert.equal(((await entry.json()) as Project).sandbox?.status, 'paused');
    assert.equal(calls, 0, 'project entry is a read and does not submit resume');

    let settled = false;
    const responsePromise = Promise.resolve(app.request('/api/projects/trace-project/sandbox/resume', { method: 'POST' }))
      .then(response => { settled = true; return response; });
    await started;
    assert.equal(calls, 1, 'the explicit endpoint submits one runtime resume');
    assert.equal(settled, false);
    finishResume();
    const response = await responsePromise;
    assert.equal(response.status, 200);
    assert.equal(((await response.json()) as Project).sandboxOperation?.status, 'succeeded');
    await new Promise<void>(resolve => setImmediate(resolve));

    const spans = exporter.getFinishedSpans();
    const request = spans.filter(span => span.name === 'http.request').at(-1);
    const projectOperation = spans.find(span => span.name === 'project.operation');
    const operation = spans.find(span => span.name === 'project.sandbox.resume');
    const runtimeSpan = spans.find(span => span.name === 'test.resume.runtime');
    assert(request && projectOperation && operation && runtimeSpan, `expected request/operation/runtime spans; got ${spans.map(span => span.name).join(', ')}`);
    assert.equal(runtimeSpan.parentSpanContext?.spanId, operation.spanContext().spanId);
    assert.equal(request.spanContext().traceId, operation.spanContext().traceId);
    assert.equal(projectOperation.spanContext().traceId, operation.spanContext().traceId);
    assert.equal(calls, 1);
  } finally {
    finishResume();
    await manager.close();
    await rm(directory, { recursive: true, force: true });
    await tracerProvider.shutdown();
  }
});
