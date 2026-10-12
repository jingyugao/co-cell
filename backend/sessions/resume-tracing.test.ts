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
import { MemoryCoordinator } from '../infra/storage/coordination.js';
import { SessionManager, type CodexClient } from './manager.js';

test('open resume keeps one lifecycle span through detached work and durable completion', async () => {
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
  let finishTerminalCommit: () => void = () => {};
  const coordinator = new MemoryCoordinator();
  const runtime = {
    async close() {},
    async rebuild(_target, save) { await save(sandbox); },
    async querySandbox(value) { return { ...value, status: paused ? 'paused' as const : 'ready' as const }; },
    async checkpoint(value) { paused = true; return { ...value.sandbox!, status: 'paused' as const }; },
    async resume(_target) {
      await traced('test.resume.runtime', {}, async () => { resumeStarted(); await barrier; });
      if (failResume) throw new Error('runtime restore failed');
      paused = false;
      return { ...sandbox, status: 'ready' as const };
    },
    remoteArchives: { async capture(target) { return { id: 'trace-checkpoint', createdAt: new Date().toISOString(), sizeBytes: 1,
      sha256: 'a'.repeat(64), imageId: 'test-image', sourceSandboxId: target.sandbox!.id }; },
      async inspect(reference) { return reference; }, async restore() { throw new Error('unused'); }, async activate() {} },
    async verifySandbox() {}, async fenceSandbox() {}, async detachSandbox() {}, async deleteDanglingSandbox() {},
  } satisfies Partial<SandboxRuntime>;
  const state = new MemoryWebStateStore();
  const manager = new SessionManager({} as CodexClient, directory, defaults, state,
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

    let terminalCommitReached!: () => void;
    const terminalCommitStarted = new Promise<void>(resolve => { terminalCommitReached = resolve; });
    const terminalCommitBarrier = new Promise<void>(resolve => { finishTerminalCommit = resolve; });
    let terminalMutationParent = '';
    const mutateProject = state.mutateProject.bind(state);
    state.mutateProject = async (id, mutate) => {
      const current = await state.getProject(id);
      if (current?.sandboxOperation?.status === 'running' && current.sandboxOperation.kind === 'resume') {
        const projected = structuredClone(current);
        mutate(projected);
        const projectedOperation = projected.sandboxOperation;
        if (projectedOperation && projectedOperation.id === current.sandboxOperation.id && projectedOperation.status !== 'running') {
          terminalMutationParent = trace.getActiveSpan()?.spanContext().spanId ?? '';
          terminalCommitReached();
          await terminalCommitBarrier;
        }
      }
      return mutateProject(id, mutate);
    };
    const caller = new AbortController();
    const response = await app.request(`/api/projects/${projectId}/open`, { method: 'POST', signal: caller.signal });
    assert.equal(response.status, 202, JSON.stringify(await response.clone().json()));
    caller.abort();
    await started;

    const beforeCompletion = exporter.getFinishedSpans();
    assert(beforeCompletion.some(span => span.name === 'http.request'));
    assert.equal(beforeCompletion.some(span => span.name === 'project.resume'), false,
      'the project lifecycle span remains open after the accepted HTTP response');
    finishResume();
    await terminalCommitStarted;
    assert.equal(exporter.getFinishedSpans().some(span => ['project.resume', 'project.request'].includes(span.name)), false,
      'the request envelope and lifecycle span stay open while terminal state is not durable');
    finishTerminalCommit();
    await operations().close();
    await new Promise<void>(resolve => setImmediate(resolve));

    const spans = exporter.getFinishedSpans();
    const request = spans.find(span => span.name === 'http.request');
    const envelope = spans.find(span => span.name === 'project.request');
    const resume = spans.find(span => span.name === 'project.resume');
    const publish = spans.find(span => span.name === 'project.resume.publish');
    const admission = spans.find(span => span.name === 'project.operation.admission' && span.attributes['sandbox.operation.kind'] === 'resume');
    const runtimeSpan = spans.find(span => span.name === 'test.resume.runtime');
    assert(envelope && request && resume && publish && admission && runtimeSpan,
      `expected request/resume/admission/runtime spans; got ${spans.map(span => `${span.name}:${span.attributes['sandbox.operation.kind'] ?? ''}:${span.parentSpanContext?.spanId ?? ''}`).join(', ')}`);
    assert.equal(resume.parentSpanContext?.spanId, envelope.spanContext().spanId);
    assert.equal(request.parentSpanContext?.spanId, envelope.spanContext().spanId);
    assert.equal(response.headers.get('X-Trace-Id'), envelope.spanContext().traceId);
    assert.equal(admission.parentSpanContext?.spanId, resume.spanContext().spanId);
    assert.equal(runtimeSpan.parentSpanContext?.spanId, resume.spanContext().spanId,
      'runtime restoration belongs to the full lifecycle, not the completed admission');
    assert.equal(publish.parentSpanContext?.spanId, resume.spanContext().spanId);
    assert.equal(resume.attributes['project.operation.async'], true);
    assert.equal(typeof resume.attributes['operation.id'], 'string');
    assert.equal(resume.attributes['sandbox.id'], sandbox.id);
    assert.equal(terminalMutationParent, publish.spanContext().spanId, 'terminal persistence retains the publish context');
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
    assert.equal(failedResponse.status, 200, 'a terminal restore failure is returned synchronously with its operation state');
    await operations().close();
    await new Promise<void>(resolve => setImmediate(resolve));
    const failedResume = exporter.getFinishedSpans().filter(span => span.name === 'project.resume').at(-1);
    assert(failedResume);
    assert.equal(failedResume.status.code, 2, 'failed runtime work marks the lifecycle span as failed');
    const failedEnvelope = exporter.getFinishedSpans().filter(span => span.name === 'project.request').at(-1);
    assert.equal(failedEnvelope?.status.code, 2, 'accepted operation failure reaches the enclosing request lifecycle');
    assert.equal(failedResume.attributes['project.operation.async'], true, 'failed detached work retains its lifecycle span');
  } finally {
    finishResume();
    finishTerminalCommit();
    await manager.close();
    await coordinator.close();
    await rm(directory, { recursive: true, force: true });
    await provider.shutdown();
  }
});
