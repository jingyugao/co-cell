import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Hono } from 'hono';
import type { AppConfig, Project, Session, Settings } from '../../protocol/types.js';
import type { SandboxRuntime } from '../execution/container-runtime.js';
import type { ProjectService } from '../projects/service.js';
import { installProjectsRoutes } from '../projects/routes.js';
import { installSessionsRoutes } from './routes.js';
import { MemoryWebStateStore } from '../testing/memory-web-state.js';
import { SessionManager, type CodexClient } from './manager.js';

test('five projects use one fresh batch query; session lists do not query the runtime', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cocell-batch-list-'));
  const state = new MemoryWebStateStore();
  const defaults: Settings = { executionMode: 'sandbox', workingDirectory: '/workspace', model: 'test',
    modelReasoningEffort: 'low', sandboxMode: 'danger-full-access', webSearchMode: 'disabled', networkAccessEnabled: true };
  const at = '2026-10-01T00:00:00.000Z';
  for (let i = 0; i < 5; i++) {
    const project: Project = { id: `project-${i}`, name: `Project ${i}`, executionMode: 'sandbox',
      workingDirectory: defaults.workingDirectory, requirementUrl: null, status: 'active', archivedAt: null,
      createdAt: at, updatedAt: at, sandbox: { id: `box-${i}`, template: 'base', status: 'ready', workingDirectory: defaults.workingDirectory } };
    await state.saveProject(project);
    await state.saveSession({ id: `session-${i}`, projectId: project.id, title: 'Session', threadId: null,
      settings: defaults, status: 'idle', startedAt: at, createdAt: at, updatedAt: at, archivedAt: null, turns: [], sandbox: project.sandbox } satisfies Session);
  }
  let batches = 0, failure = false;
  let status: 'ready' | 'paused' = 'ready';
  const runtime = { async close() {}, async querySandbox() { assert.fail('list performed a per-box query'); },
    async querySandboxes(sandboxes: NonNullable<Project['sandbox']>[]) {
      batches++;
      assert.equal(sandboxes.length, 5);
      if (failure) throw new Error('batch unavailable');
      return sandboxes.map(sandbox => ({ ...sandbox, status }));
    } } as unknown as SandboxRuntime;
  const manager = new SessionManager({} as CodexClient, directory, defaults, state, runtime);
  const app = new Hono();
  installProjectsRoutes(app, manager);
  installSessionsRoutes(app, manager, { defaults } as AppConfig);
  try {
    await manager.init();
    batches = 0;
    const storedBeforeReads = await state.listProjects();
    const readProjects = async () => {
      const response = await app.request('/api/projects');
      assert.equal(response.status, 200);
      return await response.json() as Project[];
    };
    assert.ok((await readProjects()).every(project => project.sandbox?.status === 'ready'));
    assert.equal(batches, 1);
    const sessions = await app.request('/api/sessions');
    assert.equal(sessions.status, 200);
    assert.equal((await sessions.json() as Session[]).length, 5);
    assert.equal(batches, 1, 'session list adds no runtime reads');
    status = 'paused';
    assert.ok((await readProjects()).every(project => project.sandbox?.status === 'paused'));
    assert.equal(batches, 2, 'refresh reads the source again without caching');
    failure = true;
    assert.ok((await readProjects()).every(project => project.sandbox?.status === 'unknown'));
    assert.equal(batches, 3, 'failure does not fall back to per-box queries');
    assert.deepEqual(await state.listProjects(), storedBeforeReads, 'reads do not persist observations');
  } finally { await manager.close(); await rm(directory, { recursive: true, force: true }); }
});

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
  const observe = async (sandbox: NonNullable<Project['sandbox']>) => {
    queries++;
    if (queryFailure) throw new Error('provider query failed');
    return { ...sandbox, status: providerStatus };
  };
  const runtime = { async close() {}, querySandbox: observe,
  async querySandboxes(sandboxes: NonNullable<Project['sandbox']>[]) { return Promise.all(sandboxes.map(observe)); },
  async inspect() { inspections++; }, async rebuild() { rebuilds++; }, async resume() { resumes++; },
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
