import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Hono } from 'hono';
import type { SandboxResumeProgress } from '@co-cell/sandbox';
import { installProjectsRoutes } from '../projects/routes.js';
import type { Project, Settings } from '../../protocol/types.js';
import type { SandboxRuntime } from '../execution/container-runtime.js';
import { MemoryWebStateStore } from '../testing/memory-web-state.js';
import { SessionManager, type CodexClient } from './manager.js';

const settings: Settings = { executionMode: 'sandbox', workingDirectory: '/home/agent/workspace', model: 'test',
  modelReasoningEffort: 'low', sandboxMode: 'danger-full-access', webSearchMode: 'disabled', networkAccessEnabled: true };
const at = new Date().toISOString();
const initialProject = (): Project => ({ id: 'resume-project', name: 'Resume test', status: 'active', requirementUrl: null,
  executionMode: 'sandbox', workingDirectory: settings.workingDirectory, completedAt: null, archivedAt: null,
  createdAt: at, updatedAt: at, sandbox: { id: 'resume-box', status: 'paused', template: 'test',
    workingDirectory: settings.workingDirectory, pausedAt: at } });

async function fixture(resume: (target: Parameters<NonNullable<SandboxRuntime['resume']>>[0], observeStatus: (status: 'paused' | 'ready') => void,
  onProgress?: (event: SandboxResumeProgress) => void) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'cocell-resume-contract-'));
  const state = new MemoryWebStateStore();
  await state.saveProject(initialProject());
  let observedStatus: 'paused' | 'ready' = 'paused';
  let queryCalls = 0;
  const runtime = {
    async close() {},
    async querySandbox(sandbox) { queryCalls++; return { ...sandbox, status: observedStatus }; },
    async resume(target, _signal, onProgress) {
      await resume(target, status => { observedStatus = status; }, onProgress);
    },
  } satisfies Partial<SandboxRuntime>;
  const makeManager = async () => {
    const manager = new SessionManager({} as CodexClient, directory, settings, state, runtime as SandboxRuntime);
    await manager.init();
    return manager;
  };
  const manager = await makeManager();
  return { directory, state, runtime, manager, makeManager, queryCalls: () => queryCalls,
    async close(managerToClose = manager) { await managerToClose.close(); await state.close(); await rm(directory, { recursive: true, force: true }); } };
}

test('project entry is read-only; each explicit resume submits once and surfaces Cellbox conflicts', async () => {
  let calls = 0;
  let mode: 'success' | 'busy' = 'success';
  const f = await fixture(async (_target, observeStatus) => {
    calls++;
    if (mode === 'busy') throw Object.assign(new Error('Cellbox reports BUSY'), { code: 'BUSY' });
    observeStatus('ready');
  });
  try {
    const entry = await f.manager.enterProject('resume-project');
    assert.equal(entry.sandbox?.status, 'paused');
    assert.equal(calls, 0, 'entering a paused project does not restore it');

    const resumed = await f.manager.resumeProjectSandbox('resume-project');
    assert.equal(calls, 1, 'one explicit resume produced one runtime submission');
    assert.equal(resumed.sandbox?.id, 'resume-box');
    assert.equal(resumed.sandbox?.status, 'ready', 'the returned project observes current Cellbox state');
    assert.equal(resumed.sandboxOperation?.status, 'succeeded');

    mode = 'busy';
    await assert.rejects(f.manager.resumeProjectSandbox('resume-project'), error =>
      (error as { code?: string }).code === 'BUSY' || /BUSY/.test(String(error)));
    assert.equal(calls, 2, 'a later user submission is a distinct single request');
    const latest = await f.state.getProject('resume-project');
    assert.equal(latest?.sandboxOperation?.status, 'failed');
    assert.equal(latest?.sandboxOperation?.errorCode, 'BUSY');
  } finally { await f.close(); }
});

test('project metadata edits made during resume survive completion', async () => {
  let calls = 0;
  let start!: () => void, finish!: () => void;
  const started = new Promise<void>(resolve => { start = resolve; });
  const barrier = new Promise<void>(resolve => { finish = resolve; });
  const f = await fixture(async (_target, observeStatus) => {
    calls++;
    start();
    await barrier;
    observeStatus('ready');
  });
  try {
    const resuming = f.manager.resumeProjectSandbox('resume-project');
    await started;
    await f.manager.updateProject('resume-project', { name: 'Edited during resume' });
    finish();
    const result = await resuming;
    assert.equal(calls, 1);
    assert.equal(result.name, 'Edited during resume');
    assert.equal(result.sandbox?.status, 'ready');
    assert.equal((await f.state.getProject('resume-project'))?.name, 'Edited during resume');
    assert.equal(result.sandboxOperation?.status, 'succeeded');
  } finally { finish(); await f.close(); }
});

test('unknown resume outcome remains unknown across reads and startup without replay', async () => {
  let calls = 0;
  const f = await fixture(async () => {
    calls++;
    throw Object.assign(new Error('response lost after submission'), { code: 'UNKNOWN_OUTCOME' });
  });
  let restarted: SessionManager | undefined;
  try {
    await assert.rejects(f.manager.resumeProjectSandbox('resume-project'), /response lost/);
    assert.equal(calls, 1);
    assert.equal((await f.state.getProject('resume-project'))?.sandboxOperation?.status, 'unknown');

    const readsBefore = f.queryCalls();
    const observed = await f.manager.enterProject('resume-project');
    assert.equal(observed.sandbox?.status, 'paused');
    assert.equal(calls, 1, 'GET-style project observation does not repeat the mutation');
    assert.equal(f.queryCalls(), readsBefore + 1);

    restarted = await f.makeManager();
    assert.equal(calls, 1, 'startup observes the unknown operation and does not take it over');
    assert.equal((await f.state.getProject('resume-project'))?.sandboxOperation?.status, 'unknown');
  } finally {
    if (restarted) await restarted.close();
    await f.close();
  }
});

const streamEvents = (text: string) => text.split('\n\n').filter(frame => frame.startsWith('event: ')).map(frame => ({
  event: frame.match(/^event: (.+)/)![1], data: JSON.parse(frame.split('\n').find(line => line.startsWith('data: '))!.slice(6)),
}));

test('resume SSE exposes live progress before completion without persisting its timeline', { timeout: 10_000 }, async () => {
  let finish!: () => void;
  const barrier = new Promise<void>(resolve => { finish = resolve; });
  let calls = 0;
  const f = await fixture(async (target, status, progress) => {
    calls++;
    const detail = { sandboxId: target.sandbox!.id, waitPorts: [40000, 4500], remoteOperationId: 'cellbox-resume-one' };
    progress?.({ ...detail, stage: 'submitting' });
    progress?.({ ...detail, stage: 'accepted', remoteStatus: 'running' });
    await barrier;
    progress?.({ ...detail, stage: 'ports_listening', remoteStatus: 'succeeded', resumePath: 'warm_pool' });
    status('ready');
  });
  const app = new Hono();
  installProjectsRoutes(app, f.manager);
  try {
    const response = await app.request('/api/projects/resume-project/sandbox/resume', {
      method: 'POST', headers: { Accept: 'text/event-stream' },
    });
    assert.match(response.headers.get('Content-Type')!, /text\/event-stream/);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    const reader = response.body!.getReader(), decoder = new TextDecoder();
    let text = '';
    while (!text.includes('"stage":"accepted"')) {
      const chunk = await reader.read();
      assert.equal(chunk.done, false);
      text += decoder.decode(chunk.value, { stream: true });
    }
    assert.equal(text.includes('ports_listening'), false);
    assert.equal(text.includes('resumePath'), false);
    assert.equal((await f.state.getProject('resume-project'))?.sandboxOperation?.status, 'running');
    finish();
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += decoder.decode(chunk.value, { stream: true });
    }
    const events = streamEvents(text), progress = events.filter(event => event.event === 'progress').map(event => event.data);
    assert.deepEqual(progress.map(event => event.stage), ['received', 'preparing', 'submitting', 'accepted', 'ports_listening', 'syncing', 'completed']);
    assert.deepEqual(progress.map(event => event.sequence), [1, 2, 3, 4, 5, 6, 7]);
    assert(progress.every((event, index) => Number.isFinite(Date.parse(event.at)) && (index === 0 || event.elapsedMs >= progress[index - 1].elapsedMs)));
    assert.deepEqual(progress[4].waitPorts, [40000, 4500]);
    assert.deepEqual(progress.slice(4).map(event => event.resumePath), ['warm_pool', 'warm_pool', 'warm_pool']);
    assert.equal(events.at(-1)!.event, 'complete');
    assert.equal(events.at(-1)!.data.sandboxOperation.status, 'succeeded');
    assert.equal(events.at(-1)!.data.sandbox.status, 'ready');
    assert.equal(calls, 1);
    assert.equal(JSON.stringify(await f.state.getProject('resume-project')).includes('ports_listening'), false);
    assert.equal(JSON.stringify(await f.manager.readProject('resume-project')).includes('ports_listening'), false);
    assert.equal(JSON.stringify(await f.state.getProject('resume-project')).includes('resumePath'), false);
    assert.equal(JSON.stringify(await f.manager.readProject('resume-project')).includes('resumePath'), false);
  } finally { finish(); await f.close(); }
});

test('closing a resume stream stops observation without cancelling or repeating the operation', { timeout: 10_000 }, async () => {
  let finish!: () => void, begin!: () => void;
  const started = new Promise<void>(resolve => { begin = resolve; });
  const barrier = new Promise<void>(resolve => { finish = resolve; });
  let calls = 0;
  const f = await fixture(async (_target, status, progress) => {
    calls++; begin(); await barrier;
    progress?.({ stage: 'ports_listening', sandboxId: 'resume-box' });
    status('ready');
  });
  const app = new Hono();
  installProjectsRoutes(app, f.manager);
  try {
    const response = await app.request('/api/projects/resume-project/sandbox/resume', { method: 'POST', headers: { Accept: 'text/event-stream' } });
    await started;
    await response.body!.cancel();
    finish();
    await f.manager.close();
    assert.equal(calls, 1);
    assert.equal((await f.state.getProject('resume-project'))?.sandboxOperation?.status, 'succeeded');
  } finally { finish(); await f.close(); }
});

test('resume SSE preserves an unknown outcome and never emits listening or completion', async () => {
  let calls = 0;
  const f = await fixture(async () => {
    calls++;
    throw Object.assign(new Error('lost response token=private-value'), { name: 'CellboxError', code: 'UNKNOWN_OUTCOME' });
  });
  const app = new Hono();
  installProjectsRoutes(app, f.manager);
  try {
    const response = await app.request('/api/projects/resume-project/sandbox/resume', { method: 'POST', headers: { Accept: 'text/event-stream' } });
    const events = streamEvents(await response.text());
    assert.equal(events.some(event => event.event === 'complete' || event.data.stage === 'ports_listening'), false);
    assert.equal(events.at(-1)!.event, 'error');
    assert.equal(events.at(-1)!.data.code, 'UNKNOWN_OUTCOME');
    assert.equal(events.at(-1)!.data.outcome, 'unknown');
    assert.equal(events.at(-1)!.data.message.includes('private-value'), false);
    assert.equal((await f.state.getProject('resume-project'))?.sandboxOperation?.status, 'unknown');
    assert.equal(calls, 1);
  } finally { await f.close(); }
});

test('resume SSE distinguishes a confirmed provider failure from an unknown outcome', async () => {
  const f = await fixture(async () => {
    throw Object.assign(new Error('restore failed'), { name: 'CellboxError', code: 'INTERNAL' });
  });
  const app = new Hono();
  installProjectsRoutes(app, f.manager);
  try {
    const response = await app.request('/api/projects/resume-project/sandbox/resume', { method: 'POST', headers: { Accept: 'text/event-stream' } });
    const events = streamEvents(await response.text());
    assert.equal(events.some(event => event.event === 'complete' || event.data.stage === 'ports_listening'), false);
    assert.equal(events.at(-1)!.event, 'error');
    assert.equal(events.at(-1)!.data.status, 502);
    assert.equal(events.at(-1)!.data.outcome, 'failed');
    assert.equal((await f.state.getProject('resume-project'))?.sandboxOperation?.status, 'failed');
  } finally { await f.close(); }
});
