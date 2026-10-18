import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
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

async function fixture(resume: (target: Parameters<NonNullable<SandboxRuntime['resume']>>[0], observeStatus: (status: 'paused' | 'ready') => void) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'cocell-resume-contract-'));
  const state = new MemoryWebStateStore();
  await state.saveProject(initialProject());
  let observedStatus: 'paused' | 'ready' = 'paused';
  let queryCalls = 0;
  const runtime = {
    async close() {},
    async querySandbox(sandbox) { queryCalls++; return { ...sandbox, status: observedStatus }; },
    async resume(target) {
      await resume(target, status => { observedStatus = status; });
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
