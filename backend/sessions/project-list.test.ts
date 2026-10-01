import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Hono } from 'hono';
import type { Project, Settings } from '../../protocol/types.js';
import type { SandboxRuntime } from '../execution/container-runtime.js';
import type { ProjectService } from '../projects/service.js';
import { installProjectsRoutes } from '../projects/routes.js';
import { MemoryWebStateStore } from '../testing/memory-web-state.js';
import { SessionManager, type CodexClient } from './manager.js';

test('project list and detail query live sandbox state without mutating lifecycle state', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cocell-project-list-'));
  const id = 'project-1';
  const workingDirectory = '/workspace';
  const state = new MemoryWebStateStore();
  const project: Project = { id, name: 'Project', type: 1, requirementUrl: null,
    executionMode: 'sandbox', workingDirectory, status: 'active', completedAt: null, archivedAt: null,
    sandbox: { id: 'sandbox-1', template: 'base', status: 'ready', workingDirectory },
    createdAt: '2026-09-27T00:00:00.000Z', updatedAt: '2026-09-27T00:00:00.000Z' };
  await state.saveProject(project);
  let providerStatus: 'ready' | 'paused' | 'unavailable' = 'paused';
  let queryFailure = false;
  let queries = 0, inspections = 0, rebuilds = 0, resumes = 0, verifications = 0, preparations = 0;
  const runtime = { async close() {}, async querySandbox(sandbox: NonNullable<Project['sandbox']>) {
    queries++;
    if (queryFailure) throw new Error('provider query failed');
    return { ...sandbox, status: providerStatus };
  }, async inspect() { inspections++; }, async rebuild() { rebuilds++; }, async resume() { resumes++; },
  async verifySandbox() { verifications++; }, async prepare() { preparations++; } } as unknown as SandboxRuntime;
  const defaults: Settings = { executionMode: 'sandbox', workingDirectory, model: 'test', modelReasoningEffort: 'low',
    sandboxMode: 'danger-full-access', webSearchMode: 'disabled', networkAccessEnabled: true };
  const manager = new SessionManager({} as CodexClient, directory, defaults, state, runtime);
  const app = new Hono(); installProjectsRoutes(app, manager);
  const saveProject = state.saveProject.bind(state);
  let writes = 0;
  state.saveProject = async value => { writes++; await saveProject(value); };
  let releaseMaintenance: (() => void) | undefined;
  try {
    await manager.init();
    writes = 0;
    const queriesBeforePoll = queries;
    const lifecycleCallsBeforePoll = { inspections, rebuilds, resumes, verifications, preparations };
    const projects = (manager as unknown as { projects: ProjectService }).projects;
    releaseMaintenance = projects.beginMaintenance(id);
    const list = await manager.listProjectsWithArchives();
    assert.equal(list.length, 1);
    assert.equal(list[0].sandbox?.status, 'paused', 'provider state replaces stale saved status in list response');
    assert.equal(projects.get(id).sandbox?.status, 'unknown', 'internal metadata keeps status transient');
    assert.equal(writes, 0);
    assert.deepEqual({ inspections, rebuilds, resumes, verifications, preparations }, lifecycleCallsBeforePoll);

    providerStatus = 'unavailable';
    queryFailure = true;
    const failedList = await manager.listProjectsWithArchives();
    assert.equal(failedList[0].sandbox?.status, 'unknown', 'query errors are represented as unknown');
    const detail = await app.request(`/api/projects/${id}`);
    assert.equal(detail.status, 200);
    assert.equal((await detail.json() as Project).sandbox?.status, 'unknown', 'single-project reads also fail closed to unknown');
    assert.equal(writes, 0);
    assert.deepEqual({ inspections, rebuilds, resumes, verifications, preparations }, lifecycleCallsBeforePoll);

    queryFailure = false;
    providerStatus = 'ready';
    releaseMaintenance(); releaseMaintenance = undefined;
    const releaseTask = projects.startSession(id, 'active-task');
    try {
      const activeList = await manager.listProjectsWithArchives();
      assert.equal(activeList[0].sandbox?.status, 'ready', 'polling remains live while a project task is active');
      const activeDetail = await app.request(`/api/projects/${id}`);
      assert.equal((await activeDetail.json() as Project).sandbox?.status, 'ready');
    } finally { releaseTask(); }
    assert.equal(writes, 0);
    assert.deepEqual({ inspections, rebuilds, resumes, verifications, preparations }, lifecycleCallsBeforePoll);
    assert.equal(queries - queriesBeforePoll, 5);
  } finally {
    releaseMaintenance?.();
    await manager.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('new sessions and restarted projects retain their selected image version', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cocell-project-image-'));
  const state = new MemoryWebStateStore();
  const defaults: Settings = { executionMode: 'sandbox', workingDirectory: '/home/agent/workspace', model: 'test', modelReasoningEffort: 'low',
    sandboxMode: 'danger-full-access', webSearchMode: 'disabled', networkAccessEnabled: true };
  const runtime = { async close() {}, async rebuild(target: Parameters<SandboxRuntime['rebuild']>[0], save: Parameters<SandboxRuntime['rebuild']>[1]) {
    assert.deepEqual(target.imageSelection, selection);
    await save({ id: 'python-box', template: 'default', status: 'ready', workingDirectory: defaults.workingDirectory });
  }, async verifySandbox() {} } as unknown as SandboxRuntime;
  const selection = { imageId: 'python', imageName: 'Python', category: '开发', versionId: 'v1', version: 'v1',
    importedImageId: 'imported-v1', image: 'registry/python@sha256:pinned' };
  let manager = new SessionManager({} as CodexClient, directory, defaults, state, runtime);
  try {
    await manager.init();
    const project = await manager.createProject({ name: 'Python project', imageSelection: selection });
    await (manager as unknown as { sandboxOperations: { close(): Promise<void> } }).sandboxOperations.close();
    const session = await manager.create({ projectId: project.id });
    assert.deepEqual(session.imageSelection, selection);
    assert.deepEqual((await state.listProjects())[0].imageSelection, selection);
    await manager.close();
    manager = new SessionManager({} as CodexClient, directory, defaults, state, runtime);
    await manager.init();
    assert.deepEqual(manager.get(session.id).imageSelection, selection);
    assert.deepEqual(manager.getProject(project.id).imageSelection, selection);
    const sibling = await manager.create({ projectId: project.id });
    assert.deepEqual(sibling.imageSelection, selection);
  } finally { await manager.close(); await rm(directory, { recursive: true, force: true }); }
});
