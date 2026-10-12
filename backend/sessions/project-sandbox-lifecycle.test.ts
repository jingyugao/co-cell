import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
import { canEnterProject, isProjectSandboxReady } from '../../util/project-sandbox.js';

test('archiving deletes current and legacy attachment caches and blocks new uploads', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cocell-archive-cache-'));
  const state = new MemoryWebStateStore();
  const defaults: Settings = { executionMode: 'sandbox', workingDirectory: '/home/agent/workspace', model: 'test',
    modelReasoningEffort: 'low', sandboxMode: 'danger-full-access', webSearchMode: 'disabled', networkAccessEnabled: true };
  const box: SandboxState = { id: 'archive-box', status: 'ready', template: 'default', workingDirectory: defaults.workingDirectory };
  const reference = { id: 'archive-1', createdAt: new Date().toISOString(), sizeBytes: 10, sha256: 'a'.repeat(64),
    imageId: 'image', sourceSandboxId: box.id, threadIds: [] };
  let paused = false;
  const runtime = {
    async close() {}, async rebuild(_target, save) { await save(box); },
    async querySandbox(value) { return { ...value, status: paused ? 'paused' as const : 'ready' as const }; },
    async checkpoint(value) { paused = true; return { ...value.sandbox!, status: 'paused' as const }; },
    async verifySandbox() {}, async fenceSandbox() {}, async detachSandbox() {}, async deleteDanglingSandbox() {},
    remoteArchives: { async capture() { return reference; }, async inspect() { return reference; },
      async restore() { throw new Error('unused'); }, async activate() {} },
  } satisfies Partial<SandboxRuntime>;
  const manager = new SessionManager({} as CodexClient, directory, defaults, state, runtime as unknown as SandboxRuntime,
    defaults.workingDirectory, undefined, join(directory, 'custom-images'));
  try {
    await manager.init();
    const session = await manager.create();
    const image = await manager.uploadImage(session.id, Buffer.from('attachment'), 'png');
    const legacyDirectory = join(directory, 'images', session.id);
    await mkdir(legacyDirectory, { recursive: true });
    await writeFile(join(legacyDirectory, 'legacy.png'), 'legacy attachment');
    await manager.archiveProjectNow(session.projectId!);
    assert.equal(manager.getProject(session.projectId!).status, 'archived');
    await assert.rejects(access(image), { code: 'ENOENT' });
    await assert.rejects(access(legacyDirectory), { code: 'ENOENT' });
    assert.equal(manager.get(session.id).sandbox, undefined);
    assert.deepEqual(manager.get(session.id).turns, []);
    await assert.rejects(manager.uploadImage(session.id, Buffer.from('late'), 'png'), /已归档/);
    assert.equal((await state.listSessions())[0].sandbox, undefined);
    assert.equal(manager.getProject(session.projectId!).remoteArchives?.[0].id, reference.id);
  } finally { await manager.close(); await rm(directory, { recursive: true, force: true }); }
});

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
  let failCapture = false;
  let failResume = false;
  let resumeBarrier = Promise.resolve();
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
    async resume(target) { resumeCalls++; assert.equal(target.sandbox?.id, box.id); providerBox = { ...box, status: 'ready' };
      await resumeBarrier;
      if (failResume) throw new Error('Runtime restore outcome unavailable'); return { ...providerBox }; },
    remoteArchives: { async capture(target) { assert.equal(target.sandbox?.status, 'paused'); if (failCapture) throw new Error('archive storage unavailable'); return { id: 'archive-checkpoint', createdAt: new Date().toISOString(), sizeBytes: 10, sha256: 'a'.repeat(64), imageId: 'image', sourceSandboxId: box.id }; },
      async inspect(ref) { return ref; }, async restore() { throw new Error('unused'); }, async activate() {} },
    async fenceSandbox() {}, async detachSandbox() {}, async deleteDanglingSandbox() {},
    async delete(target) { assert.equal(target.sandbox?.id, box.id); providerBox = { ...box, status: 'unavailable' }; await saveBinding({ ...providerBox }); },
  } satisfies Partial<SandboxRuntime>;
  const manager = new SessionManager({} as CodexClient, directory, defaults, state, runtime as unknown as SandboxRuntime);
  const app = new Hono(); installProjectsRoutes(app, manager);
  const operations = () => (manager as unknown as { sandboxOperations: { close(): Promise<void> } }).sandboxOperations;
  const waitFor = async <T>(read: () => Promise<T | undefined>, ready: (value: T | undefined) => boolean) => {
    const deadline = Date.now() + 4_000;
    let value = await read();
    while (!ready(value) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10));
      value = await read();
    }
    assert(ready(value), 'timed out waiting for durable lifecycle state');
    return value as T;
  };
  try {
    await manager.init();
    let createSettled = false;
    const createResponse = Promise.resolve(app.request('/api/projects', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'immediate sandbox' }) }));
    void createResponse.then(() => { createSettled = true; });
    const creating = await waitFor(async () => (await state.listProjects())[0], project => project?.sandboxOperation?.kind === 'create');
    const createOperationId = creating.sandboxOperation!.id!;
    assert.equal(creating.sandboxOperation?.status, 'running');
    await new Promise(resolve => setTimeout(resolve, 1_600));
    assert.equal(createSettled, false, 'create must keep the request open while runtime preparation exceeds the old 1.5s budget');
    assert.equal((await state.getProject(creating.id))?.sandboxOperation?.id, createOperationId,
      'the in-flight operation remains readable from durable project history');
    const created = creating as ProjectSummary;
    assert.equal(canEnterProject(created), true);
    assert.equal(isProjectSandboxReady(created), false);
    let duringEntrySettled = false;
    const duringEntryResponse = Promise.resolve(app.request(`/api/projects/${created.id}/open`, { method: 'POST' }))
      .then(response => { duringEntrySettled = true; return response; });
    await assert.rejects(manager.create({ projectId: created.id }), /维护/);
    const duringCreate = await (await app.request('/api/projects?refreshSandboxes=1')).json() as ProjectSummary[];
    assert.equal(duringCreate[0].sandbox?.status, 'ready', 'live provider status is returned during creation maintenance');
    assert.equal(inspections, 0, 'polling must not inspect, prepare, resume, or verify the Sandbox');
    assert.equal(resumeCalls, 0);
    assert.equal(verifications, 0);
    assert.equal(canEnterProject(duringCreate[0]), true);
    assert.equal(isProjectSandboxReady(duringCreate[0]), false);
    await assert.rejects(manager.checkpointProjectSandbox(created.id), /维护/);
    assert.equal(duringEntrySettled, false, 'open joins in-flight creation and waits for a usable sandbox');
    finishPreparation();
    const response = await createResponse;
    assert.equal(response.status, 201);
    const completedCreate = await response.json() as ProjectSummary;
    assert.equal(completedCreate.sandboxOperation?.id, createOperationId);
    assert.equal(completedCreate.sandboxOperation?.status, 'succeeded');
    const duringEntry = await duringEntryResponse;
    assert.equal(duringEntry.status, 200);
    assert.equal((await duringEntry.json() as ProjectSummary).sandboxOperation?.status, 'succeeded');
    await operations().close();
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
    assert.equal(checkpoint.status, 200);
    await operations().close();
    const pausedAfterCheckpoint = await manager.readProject(created.id);
    assert.equal(pausedAfterCheckpoint.sandbox?.status, 'paused');
    assert.equal(canEnterProject(pausedAfterCheckpoint), true);
    assert.equal(isProjectSandboxReady(pausedAfterCheckpoint), false);
    let finishResume!: () => void;
    resumeBarrier = new Promise<void>(resolve => { finishResume = resolve; });
    let opensSettled = 0;
    const opened = [1, 2].map(() => Promise.resolve(app.request(`/api/projects/${created.id}/open`, { method: 'POST' }))
      .then(response => { opensSettled++; return response; }));
    const resuming = await waitFor(() => state.getProject(created.id), project => project?.sandboxOperation?.kind === 'resume'
      && project.sandboxOperation.status === 'running');
    const operationId = resuming.sandboxOperation!.id!;
    assert.equal(resumeCalls, 1);
    await new Promise(resolve => setTimeout(resolve, 1_600));
    assert.equal(opensSettled, 0, 'concurrent open requests must remain pending beyond the old 1.5s wait budget');
    assert.equal((await state.getProject(created.id))?.sandboxOperation?.id, operationId,
      'the running resume operation remains visible while callers wait');
    const joinedEntry = manager.enterProject(created.id);
    await assert.rejects(manager.create({ projectId: created.id }), /维护/);
    let notified = false;
    const beforeWaitQueries = queryCalls;
    const waitingResponse = Promise.resolve(app.request(`/api/projects/${created.id}?waitForOperation=${operationId}&waitMs=10000`))
      .then(response => { notified = true; return response; });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(notified, false, 'runtime ready alone cannot finish the wait');
    assert.equal(queryCalls, beforeWaitQueries, 'waiting for completion does not poll the provider');
    const mutateProject = state.mutateProject.bind(state);
    let persistReached!: () => void, commitResult!: () => void;
    const persistenceStarted = new Promise<void>(resolve => { persistReached = resolve; });
    const persistenceBarrier = new Promise<void>(resolve => { commitResult = resolve; });
    state.mutateProject = async (id, mutate) => {
      const current = await state.getProject(id);
      if (current?.sandboxOperation?.id === operationId && current.sandboxOperation.status === 'running') {
        const projected = structuredClone(current);
        mutate(projected);
        if (projected.sandboxOperation?.id === operationId && projected.sandboxOperation.status === 'succeeded') {
          persistReached(); await persistenceBarrier;
        }
      }
      return mutateProject(id, mutate);
    };
    const projectService = (manager as unknown as { projects: ProjectService }).projects;
    finishResume(); await persistenceStarted;
    try {
      assert.equal(notified, false, 'completion must be durable before notifying readers');
      assert.equal(projectService.isMaintaining(created.id), true);
    } finally { commitResult(); }
    const completionResponse = await waitingResponse;
    assert.equal(completionResponse.status, 200);
    const completion = await completionResponse.json() as ProjectSummary;
    assert.equal(completion.sandboxOperation?.id, operationId);
    assert.equal(completion.sandboxOperation?.status, 'succeeded');
    assert.equal(isProjectSandboxReady(completion), true);
    assert.equal(projectService.isMaintaining(created.id), false, 'notified clients can begin execution');
    state.mutateProject = mutateProject;
    const openResponses = await Promise.all(opened);
    assert.ok(openResponses.every(response => response.status === 200));
    const entries = await Promise.all(openResponses.map(response => response.json() as Promise<ProjectSummary>));
    assert.equal(entries[0].sandboxOperation?.id, operationId);
    assert.equal(entries[1].sandboxOperation?.id, operationId);
    assert.ok(entries.every(entry => entry.sandboxOperation?.status === 'succeeded' && isProjectSandboxReady(entry)));
    assert.equal((await joinedEntry).sandboxOperation?.status, 'succeeded');
    await operations().close();
    assert.equal(resumeCalls, 1, 'concurrent entries and repeated entry during preparation share one resume');
    await manager.enterProject(created.id);
    assert.equal(resumeCalls, 2, 'a new idle project entry rechecks runtime through ensure-running');
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
    let restoreFailure: unknown;
    try { await manager.resumeProjectSandbox(created.id); } catch (error) { restoreFailure = error; }
    assert.match(String(restoreFailure), /Runtime restore outcome unavailable/);
    await operations().close();
    const failed = await manager.readProject(created.id);
    assert.equal(failed.sandboxOperation?.status, 'failed');
    assert.equal(canEnterProject(failed), true);
    assert.equal(isProjectSandboxReady(failed), false);
    const beforeFailedPoll = { queries: queryCalls, inspections, resumes: resumeCalls, verifications };
    const failedPoll = await manager.listProjectsWithArchives();
    assert.equal(failedPoll[0].sandbox?.status, 'ready', 'provider state is refreshed even after a failed restore operation');
    assert.equal(failedPoll[0].sandboxOperation?.status, 'failed');
    assert.equal(canEnterProject(failedPoll[0]), true);
    assert.equal(isProjectSandboxReady(failedPoll[0]), false, 'a successful provider query does not erase the failed-operation gate');
    assert.equal(queryCalls, beforeFailedPoll.queries + 1);
    assert.deepEqual({ inspections, resumes: resumeCalls, verifications }, {
      inspections: beforeFailedPoll.inspections, resumes: beforeFailedPoll.resumes, verifications: beforeFailedPoll.verifications,
    }, 'polling after failed restore only queries provider status');
    failVerification = false;
    failResume = false;
    await manager.rebuildProjectSandbox(created.id); await operations().close();
    const rebuilt = await manager.readProject(created.id);
    assert.equal(canEnterProject(rebuilt), true);
    assert.equal(rebuilt.sandbox?.id, box.id);
    // Runtime persistence during deletion must respect the deletion guard
    // without failing or resurrecting the project.
    failCapture = true;
    await assert.rejects(manager.deleteProject(created.id), /archive storage unavailable/);
    assert.equal((await manager.readProject(created.id)).sandbox?.status, 'paused');
    assert.equal((await state.listProjects()).length, 1, 'failed backup must preserve project and source disk');
    failCapture = false;
    await manager.deleteProject(created.id);
    assert.equal((await state.listProjects()).length, 0);
    assert.throws(() => manager.getProject(created.id), /不存在/);
  } finally { finishPreparation(); await manager.close(); await rm(directory, { recursive: true, force: true }); }
});

test('rebuild endpoint chooses mounted HOME despite an existing older archive', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cocell-home-rebuild-'));
  const state = new MemoryWebStateStore();
  const defaults: Settings = { executionMode: 'sandbox', workingDirectory: '/home/agent/workspace', model: 'test',
    modelReasoningEffort: 'low', sandboxMode: 'danger-full-access', webSearchMode: 'disabled', networkAccessEnabled: true };
  const box: SandboxState = { id: 'same-box', status: 'unavailable', template: 'default', workingDirectory: defaults.workingDirectory };
  await state.init();
  await state.saveProject({ id: 'mounted-project', name: 'mounted project', type: 1, requirementUrl: null,
    status: 'active', completedAt: null, archivedAt: null, executionMode: 'sandbox', workingDirectory: defaults.workingDirectory,
    sandbox: box, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    remoteArchives: [{ id: 'old-archive', createdAt: '2025-01-01T00:00:00Z', sizeBytes: 128, sha256: 'a'.repeat(64), imageId: 'image', sourceSandboxId: 'old-box', threadIds: [] }] });
  let rebuilt = false;
  const runtime = {
    async close() {},
    async querySandbox(value) { return { ...value, status: rebuilt ? 'ready' as const : 'unavailable' as const }; },
    async rebuildPersistent(target, _key, save) { assert.equal(target.sandbox?.id, box.id); rebuilt = true; await save({ ...box, status: 'ready' }); },
    async verifySandbox() {}, async verifyHistory() {},
    async rebuild() { assert.fail('must not create an empty sandbox'); },
    async deleteDanglingSandbox() { assert.fail('must retain HOME'); },
    remoteArchives: { async capture() { assert.fail('must not archive'); }, async inspect() { assert.fail('must not inspect archive'); },
      async restore() { assert.fail('must not roll back archive'); }, async activate() {} },
  } satisfies Partial<SandboxRuntime>;
  const manager = new SessionManager({} as CodexClient, directory, defaults, state, runtime as unknown as SandboxRuntime);
  try {
    await manager.init();
    const accepted = await manager.rebuildProjectSandbox('mounted-project');
    assert.equal(accepted.sandboxOperation?.kind, 'rebuild');
    const operations = (manager as unknown as { sandboxOperations: { close(): Promise<void> } }).sandboxOperations;
    await operations.close();
    assert.equal(manager.getProject('mounted-project').sandbox?.id, box.id);
    assert.equal(manager.getProject('mounted-project').sandboxOperation?.status, 'succeeded');
    assert.equal(rebuilt, true);
  } finally { await manager.close(); await rm(directory, { recursive: true, force: true }); }
});

test('single-API idle checkpoint also backs up the paused workspace', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cocell-idle-backup-'));
  const state = new MemoryWebStateStore();
  const defaults: Settings = { executionMode: 'sandbox', workingDirectory: '/home/agent/workspace', model: 'test',
    modelReasoningEffort: 'low', sandboxMode: 'danger-full-access', webSearchMode: 'disabled', networkAccessEnabled: true };
  let paused = false, captures = 0;
  const runtime = {
    async close() {},
    async querySandbox(value) { return { ...value, status: paused ? 'paused' as const : 'ready' as const }; },
    async checkpoint(value) { paused = true; return { ...value.sandbox!, status: 'paused' as const }; },
    remoteArchives: { async capture(value) { assert.equal(value.sandbox?.status, 'paused'); captures++; return {
      id: 'idle-archive', sourceSandboxId: 'idle-box', imageId: 'image', createdAt: new Date().toISOString(), sizeBytes: 10, sha256: 'a'.repeat(64),
    }; }, async inspect(ref) { return ref; }, async restore() { throw new Error('unused'); }, async activate() {} },
  } satisfies Partial<SandboxRuntime>;
  await state.init();
  await state.saveProject({ id: 'idle-project', name: 'idle project', status: 'active', executionMode: 'sandbox', requirementUrl: null,
    workingDirectory: defaults.workingDirectory, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
    sandbox: { id: 'idle-box', status: 'ready', template: 'default', workingDirectory: defaults.workingDirectory } });
  const manager = new SessionManager({} as CodexClient, directory, defaults, state, runtime as unknown as SandboxRuntime);
  try {
    await manager.init();
    await manager.scheduledArchive();
    await (manager as unknown as { sandboxOperations: { close(): Promise<void> } }).sandboxOperations.close();
    assert.equal(paused, true);
    assert.equal(captures, 1);
    const project = await manager.readProject('idle-project');
    assert.equal(project.sandboxOperation?.kind, 'checkpoint');
    assert.equal(project.sandboxOperation?.status, 'succeeded');
    assert.equal(project.remoteArchives?.[0].id, 'idle-archive');
    await manager.scheduledArchive();
    assert.equal(captures, 1, 'later scheduler ticks must not periodically back up a paused project');
  } finally { await manager.close(); await rm(directory, { recursive: true, force: true }); }
});
