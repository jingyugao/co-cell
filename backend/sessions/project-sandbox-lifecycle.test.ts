import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Hono } from 'hono';
import type { ProjectSummary, Settings } from '../../protocol/types.js';
import type { SandboxState } from '../../protocol/sandbox-types.js';
import type { SandboxRuntime } from '../execution/container-runtime.js';
import type { ProjectService } from '../projects/service.js';
import { installProjectsRoutes } from '../projects/routes.js';
import { MemoryWebStateStore } from '../testing/memory-web-state.js';
import { SessionManager, type CodexClient } from './manager.js';
import { canEnterProject } from '../../util/project-sandbox.js';

test('project creation verifies readiness; resume preserves the box without repeating diagnostics', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cocell-provision-'));
  const state = new MemoryWebStateStore();
  const defaults: Settings = { executionMode: 'sandbox', workingDirectory: '/home/agent/workspace', model: 'test',
    modelReasoningEffort: 'low', sandboxMode: 'danger-full-access', webSearchMode: 'disabled', networkAccessEnabled: true };
  const box: SandboxState = { id: 'project-box', status: 'ready', template: 'default', workingDirectory: defaults.workingDirectory };
  let providerBox = { ...box };
  let finishPreparation!: () => void;
  const preparation = new Promise<void>(resolve => { finishPreparation = resolve; });
  let saveBinding!: (value: SandboxState) => Promise<void>;
  let verifications = 0, inspections = 0, createCalls = 0, resumeCalls = 0, queryCalls = 0;
  let failVerification = false;
  let failResume = false;
  const runtime = {
    async close() {},
    async rebuild(_target, save) {
      createCalls++; saveBinding = save; providerBox = { ...box, status: 'ready' };
      await save({ ...box });
      await preparation;
    },
    async querySandbox(sandbox) { queryCalls++; return { ...sandbox, status: providerBox.status }; },
    async querySandboxes(sandboxes) { queryCalls++; return sandboxes.map(sandbox => ({ ...sandbox, status: providerBox.status })); },
    async verifySandbox() { verifications++; if (failVerification) throw new Error('App Server unavailable'); },
    async inspect() { inspections++; },
    async checkpoint(target) { assert.equal(target.sandbox?.id, box.id); providerBox = { ...box, status: 'paused' }; return { ...providerBox }; },
    async resume(target, save) { resumeCalls++; assert.equal(target.sandbox?.id, box.id); providerBox = { ...box, status: 'ready' }; await save({ ...providerBox });
      if (failResume) throw new Error('Runtime restore outcome unavailable'); },
    async delete(target) { assert.equal(target.sandbox?.id, box.id); providerBox = { ...box, status: 'unavailable' }; await saveBinding({ ...providerBox }); },
  } satisfies Partial<SandboxRuntime>;
  const manager = new SessionManager({} as CodexClient, directory, defaults, state, runtime as unknown as SandboxRuntime);
  const app = new Hono(); installProjectsRoutes(app, manager);
  const operations = () => (manager as unknown as { sandboxOperations: { close(): Promise<void> } }).sandboxOperations;
  try {
    await manager.init();
    const response = await app.request('/api/projects', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'immediate sandbox' }) });
    assert.equal(response.status, 201);
    const created = await response.json() as ProjectSummary;
    assert.equal(created.sandboxOperation?.kind, 'create');
    assert.equal(created.sandboxOperation?.status, 'running');
    assert.equal((await state.listProjects())[0].sandboxOperation?.id, created.sandboxOperation?.id);
    assert.equal(canEnterProject(created), false);
    const duringCreate = await (await app.request('/api/projects?refreshSandboxes=1')).json() as ProjectSummary[];
    assert.equal(duringCreate[0].sandbox?.status, 'ready', 'live provider status is returned during creation maintenance');
    assert.equal(inspections, 0, 'polling must not inspect, prepare, resume, or verify the Sandbox');
    assert.equal(resumeCalls, 0);
    assert.equal(verifications, 0);
    assert.equal(canEnterProject(duringCreate[0]), false);
    await assert.rejects(manager.checkpointProjectSandbox(created.id), /维护/);
    finishPreparation(); await operations().close();
    assert.equal(createCalls, 1);
    assert.equal(verifications, 1);
    const readyAfterCreate = await manager.readProject(created.id);
    assert.equal(readyAfterCreate.sandbox?.status, 'ready');
    assert.equal(canEnterProject(readyAfterCreate), true);
    // The persistent runtime callback must use current lifecycle state after creation.
    providerBox = { ...box, status: 'paused' };
    await saveBinding({ ...providerBox });
    assert.equal((await manager.readProject(created.id)).sandbox?.status, 'paused');
    providerBox = { ...box, status: 'ready' };
    await saveBinding({ ...providerBox });
    assert.equal((await manager.readProject(created.id)).sandbox?.status, 'ready');
    const projects = (manager as unknown as { projects: ProjectService }).projects;
    const finishTask = projects.startSession(created.id, 'active-task');
    try {
      await assert.rejects(manager.checkpointProjectSandbox(created.id), /正在使用/);
      const beforePoll = { inspections, rebuilds: createCalls, resumes: resumeCalls, verifications };
      const activeList = await manager.listProjectsWithArchives();
      assert.equal(activeList[0].sandbox?.status, 'ready');
      assert.deepEqual({ inspections, rebuilds: createCalls, resumes: resumeCalls, verifications }, beforePoll,
        'read-only polling during an active task does not start lifecycle work');
    }
    finally { finishTask(); }
    const checkpoint = await app.request(`/api/projects/${created.id}/sandbox/checkpoint`, { method: 'POST' });
    assert.equal(checkpoint.status, 202);
    await operations().close();
    const pausedAfterCheckpoint = await manager.readProject(created.id);
    assert.equal(pausedAfterCheckpoint.sandbox?.status, 'paused');
    assert.equal(canEnterProject(pausedAfterCheckpoint), false);
    const resumed = await app.request(`/api/projects/${created.id}/sandbox/resume`, { method: 'POST' });
    assert.equal(resumed.status, 202);
    await operations().close();
    assert.equal(verifications, 2, 'creation and checkpoint inspect health; resume relies on runtime completion');
    assert.equal((await manager.readProject(created.id)).sandbox?.id, box.id);
    assert.equal(createCalls, 1, 'resume must not provision a second sandbox');
    assert.equal(canEnterProject(await manager.readProject(created.id)), true);
    providerBox = { ...box, status: 'paused' };
    await saveBinding({ ...providerBox });
    failVerification = true;
    await manager.resumeProjectSandbox(created.id); await operations().close();
    assert.equal((await manager.readProject(created.id)).sandboxOperation?.status, 'succeeded');
    assert.equal(canEnterProject(await manager.readProject(created.id)), true);
    assert.equal(verifications, 2, 'a diagnostic failure cannot delay or fail a restored execution');
    providerBox = { ...box, status: 'paused' };
    await saveBinding({ ...providerBox });
    failResume = true;
    await manager.resumeProjectSandbox(created.id); await operations().close();
    const failed = await manager.readProject(created.id);
    assert.equal(failed.sandboxOperation?.status, 'failed');
    assert.equal(canEnterProject(failed), false);
    const beforeFailedPoll = { queries: queryCalls, inspections, resumes: resumeCalls, verifications };
    const failedPoll = await manager.listProjectsWithArchives();
    assert.equal(failedPoll[0].sandbox?.status, 'ready', 'provider state is refreshed even after a failed restore operation');
    assert.equal(failedPoll[0].sandboxOperation?.status, 'failed');
    assert.equal(canEnterProject(failedPoll[0]), false, 'a successful provider query does not erase the failed-operation gate');
    assert.equal(queryCalls, beforeFailedPoll.queries + 1);
    assert.deepEqual({ inspections, resumes: resumeCalls, verifications }, {
      inspections: beforeFailedPoll.inspections, resumes: beforeFailedPoll.resumes, verifications: beforeFailedPoll.verifications,
    }, 'polling after failed restore only queries provider status');
    failVerification = false;
    await manager.rebuildProjectSandbox(created.id); await operations().close();
    const rebuilt = await manager.readProject(created.id);
    assert.equal(canEnterProject(rebuilt), true);
    assert.equal(rebuilt.sandbox?.id, box.id);
    // Runtime persistence during deletion must respect the deletion guard
    // without failing or resurrecting the project.
    await manager.deleteProject(created.id);
    assert.equal((await state.listProjects()).length, 0);
    assert.throws(() => manager.getProject(created.id), /不存在/);
  } finally { finishPreparation(); await manager.close(); await rm(directory, { recursive: true, force: true }); }
});
