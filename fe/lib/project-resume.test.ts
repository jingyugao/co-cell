import assert from 'node:assert/strict';
import test from 'node:test';
import type { ProjectResumeProgress } from '../../protocol/resume-types.js';
import { resumeProjectSandbox, ResumeRequestError } from './project-resume.js';

const project = {
  id: 'project-one', name: 'Project', requirementUrl: null, executionMode: 'sandbox', workingDirectory: '/workspace',
  createdAt: '2026-10-29T00:00:00.000Z', updatedAt: '2026-10-29T00:00:00.000Z', sessionCount: 0, activeSessionId: null,
  sandboxOperation: { kind: 'resume', status: 'succeeded', phase: '完成', updatedAt: '2026-10-29T00:00:01.000Z' },
};

function streamResponse(frames: string[]) {
  return new Response(new ReadableStream({
    start(controller) {
      for (const frame of frames) controller.enqueue(new TextEncoder().encode(frame));
      controller.close();
    },
  }), { headers: { 'Content-Type': 'text/event-stream' } });
}

function progress(sequence: number, stage: ProjectResumeProgress['stage'], resumePath?: 'warm_pool' | 'standard'): ProjectResumeProgress {
  return { sequence, stage, at: '2026-10-29T00:00:00.000Z', elapsedMs: sequence * 10, waitPorts: [40000, 4500], ...(resumePath ? { resumePath } : {}) };
}

test('resume consumes progress and accepts only a matching successful completion', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  let request: RequestInfo | URL | undefined;
  let options: RequestInit | undefined;
  globalThis.fetch = async (input, init) => {
    calls++; request = input; options = init;
    const events = [progress(1, 'received'), progress(2, 'ports_listening', 'warm_pool'), progress(3, 'completed', 'warm_pool')];
    return streamResponse([
      `: heartbeat\n\nevent: progress\ndata: ${JSON.stringify(events[0])}\n\n`,
      `event: progress\ndata: ${JSON.stringify(events[1])}\n\n`,
      `event: progress\ndata: ${JSON.stringify(events[2])}\n\n`,
      `event: complete\ndata: ${JSON.stringify(project)}\n\n`,
    ]);
  };
  const observed: ProjectResumeProgress[] = [];
  try {
    const result = await resumeProjectSandbox('project-one', item => observed.push(item));
    assert.deepEqual(result, project);
    assert.equal(calls, 1);
    assert.equal(request, '/api/projects/project-one/sandbox/resume');
    assert.equal(options?.method, 'POST');
    assert.equal(new Headers(options?.headers).get('Accept'), 'text/event-stream');
    assert.deepEqual(observed.map(item => item.stage), ['received', 'ports_listening', 'completed']);
    assert.deepEqual(observed.map(item => item.resumePath), [undefined, 'warm_pool', 'warm_pool']);
  } finally { globalThis.fetch = originalFetch; }
});

test('resume accepts standard restore paths and keeps missing path compatible', async () => {
  const originalFetch = globalThis.fetch;
  let nextPath: 'standard' | undefined = 'standard';
  globalThis.fetch = async () => streamResponse([
    `event: progress\ndata: ${JSON.stringify(progress(1, 'ports_listening', nextPath))}\n\n`,
    `event: complete\ndata: ${JSON.stringify(project)}\n\n`,
  ]);
  const observed: ProjectResumeProgress[] = [];
  try {
    await resumeProjectSandbox('project-one', item => observed.push(item));
    assert.equal(observed[0].resumePath, 'standard');

    nextPath = undefined;
    await resumeProjectSandbox('project-one', item => observed.push(item));
    assert.equal(observed[1].resumePath, undefined);
  } finally { globalThis.fetch = originalFetch; }
});

test('resume rejects an unsupported restore path', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => streamResponse([
    `event: progress\ndata: ${JSON.stringify({ ...progress(1, 'ports_listening'), resumePath: 'fallback' })}\n\n`,
  ]);
  try {
    await assert.rejects(resumeProjectSandbox('project-one', () => {}), error =>
      error instanceof ResumeRequestError && error.outcome === 'unknown');
  } finally { globalThis.fetch = originalFetch; }
});

test('resume progress stream ending without completion is unknown and does not replay the POST', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return streamResponse([`event: progress\ndata: ${JSON.stringify(progress(1, 'accepted'))}\n\n`]);
  };
  try {
    await assert.rejects(resumeProjectSandbox('project-one', () => {}), error =>
      error instanceof ResumeRequestError && error.outcome === 'unknown');
    assert.equal(calls, 1);
  } finally { globalThis.fetch = originalFetch; }
});

test('resume error reports an uncertain transport outcome as unknown', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => streamResponse([`event: error\ndata: ${JSON.stringify({
    message: '连接中断', code: 'UNKNOWN_OUTCOME', status: 502, at: '2026-10-29T00:00:01.000Z', elapsedMs: 100,
  })}\n\n`]);
  try {
    await assert.rejects(resumeProjectSandbox('project-one', () => {}), error =>
      error instanceof ResumeRequestError && error.outcome === 'unknown' && error.details?.code === 'UNKNOWN_OUTCOME');
  } finally { globalThis.fetch = originalFetch; }
});

test('resume rejects a completion for another project or an unfinished operation', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => streamResponse([`event: complete\ndata: ${JSON.stringify({ ...project, sandboxOperation: { ...project.sandboxOperation, status: 'running' } })}\n\n`]);
  try {
    await assert.rejects(resumeProjectSandbox('project-one', () => {}), error =>
      error instanceof ResumeRequestError && error.outcome === 'unknown');
  } finally { globalThis.fetch = originalFetch; }
});

test('an explicit failed outcome remains failed even when the provider maps it to HTTP 502', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => streamResponse([`event: error\ndata: ${JSON.stringify({
    message: 'restore failed', code: 'INTERNAL', status: 502, outcome: 'failed',
    at: '2026-10-29T00:00:01.000Z', elapsedMs: 100,
  })}\n\n`]);
  try {
    await assert.rejects(resumeProjectSandbox('project-one', () => {}), error =>
      error instanceof ResumeRequestError && error.outcome === 'failed');
  } finally { globalThis.fetch = originalFetch; }
});
