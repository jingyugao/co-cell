import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Hono } from 'hono';
import { trace } from '@opentelemetry/api';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { traced } from '@co-cell/sandbox';
import type { Settings } from '../../protocol/types.js';
import type { SandboxState } from '../../protocol/sandbox-types.js';
import type { SandboxRuntime } from '../execution/container-runtime.js';
import { installProjectsRoutes } from '../projects/routes.js';
import { MemoryWebStateStore } from '../testing/memory-web-state.js';
import { traceHttpRequest } from '../infra/diagnostics/tracing.js';
import type { SharedCoordinator } from '../infra/storage/coordination.js';
import { SessionManager, type CodexClient } from './manager.js';

test('open resume has one lifecycle span across admission, detached work and lease release', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cocell-resume-trace-'));
  const exporter = new InMemorySpanExporter();
  const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  provider.register();
  const defaults: Settings = { executionMode: 'sandbox', workingDirectory: '/home/agent/workspace', model: 'test',
    modelReasoningEffort: 'low', sandboxMode: 'danger-full-access', webSearchMode: 'disabled', networkAccessEnabled: true };
  const sandbox: SandboxState = { id: 'resume-trace-box', status: 'ready', template: 'default', workingDirectory: defaults.workingDirectory };
  let paused = false;
  let failResume = false;
  let finishResume!: () => void;
  let resumeStarted!: () => void;
  const started = new Promise<void>(resolve => { resumeStarted = resolve; });
  const barrier = new Promise<void>(resolve => { finishResume = resolve; });
  let releasedParent = '';
  let resumeAlreadyExportedAtRelease = false;
  let holdRelease = false;
  let leaseReleased!: () => void, finishRelease!: () => void;
  const leaseRelease = new Promise<void>(resolve => { leaseReleased = resolve; });
  const releaseBarrier = new Promise<void>(resolve => { finishRelease = resolve; });
  const coordinator: SharedCoordinator = {
    async run<T>(_key: string, action: () => Promise<T>) { return action(); },
    async tryAcquire() {
      return { signal: new AbortController().signal, assertHeld() {}, async release() {
        releasedParent = trace.getActiveSpan()?.spanContext().spanId ?? '';
        resumeAlreadyExportedAtRelease = exporter.getFinishedSpans().some(span => span.name === 'project.resume');
        if (holdRelease) { leaseReleased(); await releaseBarrier; }
      } };
    },
    async close() {},
  };
  const runtime = {
    async close() {},
    async rebuild(_target, save) { await save(sandbox); },
    async querySandbox(value) { return { ...value, status: paused ? 'paused' as const : 'ready' as const }; },
    async checkpoint(value) { paused = true; return { ...value.sandbox!, status: 'paused' as const }; },
    async resume(_target, save) {
      await traced('test.resume.runtime', {}, async () => { resumeStarted(); await barrier; });
      if (failResume) throw new Error('runtime restore failed');
      paused = false;
      await save({ ...sandbox, status: 'ready' });
    },
    async verifySandbox() {}, async fenceSandbox() {}, async detachSandbox() {}, async deleteDanglingSandbox() {},
  } satisfies Partial<SandboxRuntime>;
  const manager = new SessionManager({} as CodexClient, directory, defaults, new MemoryWebStateStore(),
    runtime as unknown as SandboxRuntime, defaults.workingDirectory, undefined, join(directory, 'images'), {}, undefined, coordinator);
  const app = new Hono();
  app.use('*', traceHttpRequest);
  installProjectsRoutes(app, manager);
  const operations = () => (manager as unknown as { sandboxOperations: { close(): Promise<void> } }).sandboxOperations;
  try {
    await manager.init();
    const session = await manager.create();
    const projectId = session.projectId!;
    await operations().close();
    await manager.checkpointProjectSandbox(projectId);
    await operations().close();

    holdRelease = true;
    const caller = new AbortController();
    const response = await app.request(`/api/projects/${projectId}/open`, { method: 'POST', signal: caller.signal });
    assert.equal(response.status, 202);
    caller.abort();
    await started;

    const beforeCompletion = exporter.getFinishedSpans();
    assert(beforeCompletion.some(span => span.name === 'http.request'));
    assert.equal(beforeCompletion.some(span => span.name === 'project.resume'), false,
      'the project lifecycle span remains open after the accepted HTTP response');
    finishResume();
    await operations().close();
    await leaseRelease;
    assert.equal(exporter.getFinishedSpans().some(span => ['project.resume', 'project.request'].includes(span.name)), false,
      'both operation and request envelope stay open through maintenance lease release');
    holdRelease = false;
    finishRelease();
    await new Promise<void>(resolve => setImmediate(resolve));

    const spans = exporter.getFinishedSpans();
    const request = spans.find(span => span.name === 'http.request');
    const envelope = spans.find(span => span.name === 'project.request');
    const resume = spans.find(span => span.name === 'project.resume');
    const admission = spans.find(span => span.name === 'project.operation.admission' && span.attributes['sandbox.operation.kind'] === 'resume');
    const runtimeSpan = spans.find(span => span.name === 'test.resume.runtime');
    assert(envelope && request && resume && admission && runtimeSpan,
      `expected request/resume/admission/runtime spans; got ${spans.map(span => `${span.name}:${span.attributes['sandbox.operation.kind'] ?? ''}:${span.parentSpanContext?.spanId ?? ''}`).join(', ')}`);
    assert.equal(resume.parentSpanContext?.spanId, envelope.spanContext().spanId);
    assert.equal(request.parentSpanContext?.spanId, envelope.spanContext().spanId);
    assert.equal(response.headers.get('X-Trace-Id'), envelope.spanContext().traceId);
    assert.equal(admission.parentSpanContext?.spanId, resume.spanContext().spanId);
    assert.equal(runtimeSpan.parentSpanContext?.spanId, resume.spanContext().spanId);
    assert.equal(resume.attributes['project.operation.async'], true);
    assert.equal(typeof resume.attributes['operation.id'], 'string');
    assert.equal(resume.attributes['sandbox.id'], sandbox.id);
    assert.equal(releasedParent, resume.spanContext().spanId, 'maintenance lease release keeps the lifecycle context');
    assert.equal(resumeAlreadyExportedAtRelease, false, 'lifecycle span stays open until lease release completes');
    const nanos = (time: [number, number]) => BigInt(time[0]) * 1_000_000_000n + BigInt(time[1]);
    const endNanos = (span: typeof resume) => nanos(span.endTime);
    assert(endNanos(resume) >= endNanos(runtimeSpan));
    const byId = new Map(spans.map(span => [span.spanContext().spanId, span]));
    for (const child of spans.filter(span => span.spanContext().traceId === envelope.spanContext().traceId)) {
      const parent = byId.get(child.parentSpanContext?.spanId ?? '');
      if (!parent) continue;
      assert(nanos(parent.startTime) <= nanos(child.startTime), `${child.name} starts before ${parent.name}`);
      // The JS SDK seeds each span with Date.now() (whole milliseconds), then
      // computes its duration with performance.now(). Independent start rounding
      // can put an already-ended child <1ms past its subsequently ended parent.
      assert(endNanos(parent) + 1_000_000n >= endNanos(child), `${child.name} outlives ${parent.name} by ${endNanos(child) - endNanos(parent)}ns`);
      assert.deepEqual(parent.spanContext().traceId, child.spanContext().traceId);
    }

    paused = true;
    await manager.checkpointProjectSandbox(projectId);
    await operations().close();
    failResume = true;
    const failedResponse = await app.request(`/api/projects/${projectId}/sandbox/resume`, { method: 'POST' });
    assert.equal(failedResponse.status, 202);
    await operations().close();
    await new Promise<void>(resolve => setImmediate(resolve));
    const failedResume = exporter.getFinishedSpans().filter(span => span.name === 'project.resume').at(-1);
    assert(failedResume);
    assert.equal(failedResume.status.code, 2, 'failed runtime work marks the lifecycle span as failed');
    const failedEnvelope = exporter.getFinishedSpans().filter(span => span.name === 'project.request').at(-1);
    assert.equal(failedEnvelope?.status.code, 2, 'accepted operation failure reaches the enclosing request lifecycle');
    assert.equal(releasedParent, failedResume.spanContext().spanId, 'failed work still releases the lease in lifecycle context');
  } finally {
    finishResume();
    finishRelease();
    await manager.close();
    await rm(directory, { recursive: true, force: true });
    await provider.shutdown();
  }
});
