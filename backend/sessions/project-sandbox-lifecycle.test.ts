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

test('project creation returns a durable pending operation; checkpoint/resume require readiness and preserve the box', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cocell-provision-'));
  const state = new MemoryWebStateStore();
  const defaults: Settings = { executionMode: 'sandbox', workingDirectory: '/home/agent/workspace', model: 'test',
    modelReasoningEffort: 'low', sandboxMode: 'danger-full-access', webSearchMode: 'disabled', networkAccessEnabled: true };
  const box: SandboxState = { id: 'project-box', status: 'ready', template: 'default', workingDirectory: defaults.workingDirectory };
  let finishPreparation!: () => void;
  const preparation = new Promise<void>(resolve => { finishPreparation = resolve; });
  let saveBinding!: (value: SandboxState) => Promise<void>;
  let verifications = 0, inspections = 0, createCalls = 0;
  let failVerification = false;
  const runtime = {
    async close() {},
    async rebuild(_target, save) {
      createCalls++; saveBinding = save;
      await save({ ...box });
      await preparation;
    },
    async verifySandbox() { verifications++; if (failVerification) throw new Error('App Server unavailable'); },
    async inspect() { inspections++; },
    async checkpoint(target) { assert.equal(target.sandbox?.id, box.id); return { ...box, status: 'paused' }; },
    async resume(target, save) { assert.equal(target.sandbox?.id, box.id); await save({ ...box }); },
    async delete(target) { assert.equal(target.sandbox?.id, box.id); await saveBinding({ ...box, status: 'unavailable' }); },
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
    assert.equal(inspections, 0, 'polling must not contend with the creation lock or resume a box');
    assert.equal(canEnterProject(duringCreate[0]), false);
    await assert.rejects(manager.checkpointProjectSandbox(created.id), /维护/);
    finishPreparation(); await operations().close();
    assert.equal(createCalls, 1);
    assert.equal(verifications, 1);
    assert.equal(canEnterProject(manager.getProject(created.id)), true);
    // The persistent runtime callback must use current lifecycle state after creation.
    await saveBinding({ ...box, status: 'paused' });
    assert.equal(manager.getProject(created.id).sandbox?.status, 'paused');
    await saveBinding({ ...box });
    assert.equal(manager.getProject(created.id).sandbox?.status, 'ready');
    const projects = (manager as unknown as { projects: ProjectService }).projects;
    const finishTask = projects.startSession(created.id, 'active-task');
    try { await assert.rejects(manager.checkpointProjectSandbox(created.id), /正在使用/); }
    finally { finishTask(); }
    const checkpoint = await app.request(`/api/projects/${created.id}/sandbox/checkpoint`, { method: 'POST' });
    assert.equal(checkpoint.status, 202);
    await operations().close();
    assert.equal(manager.getProject(created.id).sandbox?.status, 'paused');
    assert.equal(canEnterProject(manager.getProject(created.id)), false);
    const resumed = await app.request(`/api/projects/${created.id}/sandbox/resume`, { method: 'POST' });
    assert.equal(resumed.status, 202);
    await operations().close();
    assert.equal(verifications, 3, 'checkpoint inspects health and resume verifies the restored application');
    assert.equal(manager.getProject(created.id).sandbox?.id, box.id);
    assert.equal(createCalls, 1, 'resume must not provision a second sandbox');
    assert.equal(canEnterProject(manager.getProject(created.id)), true);
    await saveBinding({ ...box, status: 'paused' });
    failVerification = true;
    await manager.resumeProjectSandbox(created.id); await operations().close();
    const failed = manager.getProject(created.id);
    assert.equal(failed.sandboxOperation?.status, 'failed');
    assert.equal(canEnterProject(failed), false);
    const beforeFailedPoll = inspections;
    await manager.listProjectsWithArchives(true);
    assert.equal(inspections, beforeFailedPoll, 'runtime running alone cannot erase a failed readiness check');
    failVerification = false;
    await manager.rebuildProjectSandbox(created.id); await operations().close();
    assert.equal(canEnterProject(manager.getProject(created.id)), true);
    assert.equal(manager.getProject(created.id).sandbox?.id, box.id);
    // Runtime persistence during deletion must respect the deletion guard
    // without failing or resurrecting the project.
    await manager.deleteProject(created.id);
    assert.equal((await state.listProjects()).length, 0);
    assert.throws(() => manager.getProject(created.id), /不存在/);
  } finally { finishPreparation(); await manager.close(); await rm(directory, { recursive: true, force: true }); }
});
