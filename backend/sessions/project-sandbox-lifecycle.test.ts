import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Hono } from 'hono';
import type { Project, ProjectSummary, Settings } from '../../protocol/types.js';
import type { SandboxState } from '../../protocol/sandbox-types.js';
import type { SandboxRuntime } from '../execution/container-runtime.js';
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
    async checkpoint() { paused = true; },
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
    await manager.checkpointProjectSandbox(session.projectId!);
    await (manager as unknown as { sandboxOperations: { close(): Promise<void> } }).sandboxOperations.close();
    await manager.backupProjectNow(session.projectId!);
    await manager.archiveProjectNow(session.projectId!, { useExistingBackup: true });
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

test('project entry stays read-only; explicit lifecycle actions are observed from Cellbox', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cocell-explicit-lifecycle-'));
  const state = new MemoryWebStateStore();
  const defaults: Settings = { executionMode: 'sandbox', workingDirectory: '/home/agent/workspace', model: 'test',
    modelReasoningEffort: 'low', sandboxMode: 'danger-full-access', webSearchMode: 'disabled', networkAccessEnabled: true };
  const at = new Date().toISOString();
  const box: SandboxState = { id: 'project-box', status: 'paused', template: 'default', workingDirectory: defaults.workingDirectory, pausedAt: at };
  const project: Project = { id: 'lifecycle-project', name: 'Lifecycle project', type: 1, requirementUrl: null,
    status: 'active', executionMode: 'sandbox', workingDirectory: defaults.workingDirectory, completedAt: null, archivedAt: null,
    createdAt: at, updatedAt: at, sandbox: box };
  await state.saveProject(project);
  let providerStatus: SandboxState['status'] = 'paused';
  let observationUnavailable = false;
  let resumeCalls = 0, checkpointCalls = 0, archiveCalls = 0;
  const archive = { id: 'lifecycle-archive', sourceSandboxId: box.id, imageId: 'image', createdAt: at,
    sizeBytes: 10, sha256: 'a'.repeat(64), threadIds: [] };
  const runtime = {
    async close() {},
    async querySandbox(value) {
      if (observationUnavailable) throw new Error('Cellbox observation unavailable');
      return { ...value, status: providerStatus };
    },
    async resume() { resumeCalls++; providerStatus = 'ready'; },
    async checkpoint() { checkpointCalls++; providerStatus = 'paused'; },
    remoteArchives: { async capture() { archiveCalls++; return archive; }, async inspect(ref) { return ref; },
      async restore() { throw new Error('unused'); }, async activate() {} },
  } satisfies Partial<SandboxRuntime>;
  const manager = new SessionManager({} as CodexClient, directory, defaults, state, runtime as unknown as SandboxRuntime);
  const app = new Hono(); installProjectsRoutes(app, manager);
  const operations = () => (manager as unknown as { sandboxOperations: { close(): Promise<void> } }).sandboxOperations;
  try {
    await manager.init();
    const entry = await app.request(`/api/projects/${project.id}/open`, { method: 'POST' });
    assert.equal(entry.status, 200);
    const read = await entry.json() as ProjectSummary;
    assert.equal(read.sandbox?.status, 'paused');
    assert.equal(resumeCalls, 0, 'open reads state and does not resume');
    assert.equal(canEnterProject(read), true);
    assert.equal(isProjectSandboxReady(read), false);

    const response = await app.request(`/api/projects/${project.id}/sandbox/resume`, { method: 'POST' });
    assert.equal(response.status, 200);
    const resumed = await response.json() as ProjectSummary;
    assert.equal(resumeCalls, 1, 'explicit resume submits once');
    assert.equal(resumed.sandbox?.id, box.id);
    assert.equal(resumed.sandboxOperation?.status, 'succeeded');
    assert.equal(isProjectSandboxReady(resumed), true);

    observationUnavailable = true;
    const unobserved = await app.request(`/api/projects/${project.id}/sandbox/resume`, { method: 'POST' });
    assert.equal(unobserved.status, 200);
    const completed = await unobserved.json() as ProjectSummary;
    assert.equal(resumeCalls, 2, 'each explicit request reaches Cellbox even if the box is already running');
    assert.equal(completed.sandboxOperation?.status, 'succeeded', 'a later observation failure cannot change the operation result');
    assert.equal(completed.sandbox?.status, 'unknown', 'a completed resume does not fabricate a ready observation');
    observationUnavailable = false;

    const checkpoint = await app.request(`/api/projects/${project.id}/sandbox/checkpoint`, { method: 'POST' });
    assert.equal(checkpoint.status, 200);
    await operations().close();
    const paused = await manager.readProject(project.id);
    assert.equal(checkpointCalls, 1);
    assert.equal(archiveCalls, 0, 'Checkpoint must not submit disk backup');
    assert.equal(paused.sandboxBackup, undefined);
    assert.equal(paused.remoteArchives?.length ?? 0, 0);
    assert.equal(paused.sandbox?.id, box.id);
    assert.equal(paused.sandbox?.status, 'paused');
    assert.equal(paused.sandboxOperation?.kind, 'checkpoint');
    assert.equal(paused.sandboxOperation?.status, 'succeeded');
    assert.equal(isProjectSandboxReady(paused), false);
    const backupResponse = await app.request(`/api/projects/${project.id}/backup`, { method: 'POST' });
    assert.equal(backupResponse.status, 200);
    const backedUp = await backupResponse.json() as ProjectSummary;
    assert.equal(archiveCalls, 1, 'Only the explicit backup request captures disk');
    assert.equal(backedUp.sandboxOperation?.kind, 'backup');
    assert.equal(backedUp.sandboxOperation?.status, 'succeeded');
    assert.equal(backedUp.sandboxBackup?.status, 'succeeded');
    assert.equal(backedUp.sandboxBackup?.id, backedUp.sandboxOperation?.id);
    assert.equal(backedUp.remoteArchives?.[0].id, archive.id);
    assert.equal(backedUp.sandbox?.status, 'paused');
  } finally { await manager.close(); await rm(directory, { recursive: true, force: true }); }
});

test('unsupported persistent rebuild is reported without touching the sandbox or older archive', async () => {
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
  let rebuildCalls = 0, archiveCalls = 0;
  const runtime = {
    async close() {},
    async querySandbox(value) { return { ...value, status: 'unavailable' as const }; },
    async rebuildPersistent() { rebuildCalls++; },
    async verifySandbox() {}, async verifyHistory() {},
    async rebuild() { assert.fail('must not create an empty sandbox'); },
    async deleteDanglingSandbox() { assert.fail('must retain HOME'); },
    remoteArchives: { async capture() { archiveCalls++; assert.fail('must not archive'); }, async inspect() { archiveCalls++; assert.fail('must not inspect archive'); },
      async restore() { assert.fail('must not roll back archive'); }, async activate() {} },
  } satisfies Partial<SandboxRuntime>;
  const manager = new SessionManager({} as CodexClient, directory, defaults, state, runtime as unknown as SandboxRuntime);
  try {
    await manager.init();
    await assert.rejects(manager.rebuildProjectSandbox('mounted-project'), /不支持同 ID 重建/);
    const operations = (manager as unknown as { sandboxOperations: { close(): Promise<void> } }).sandboxOperations;
    await operations.close();
    assert.equal(manager.getProject('mounted-project').sandbox?.id, box.id);
    assert.equal(manager.getProject('mounted-project').sandboxOperation?.status, 'failed');
    assert.equal(rebuildCalls, 0);
    assert.equal(archiveCalls, 0);
  } finally { await manager.close(); await rm(directory, { recursive: true, force: true }); }
});

test('single-API idle checkpoint only pauses and never captures disk', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cocell-idle-backup-'));
  const state = new MemoryWebStateStore();
  const defaults: Settings = { executionMode: 'sandbox', workingDirectory: '/home/agent/workspace', model: 'test',
    modelReasoningEffort: 'low', sandboxMode: 'danger-full-access', webSearchMode: 'disabled', networkAccessEnabled: true };
  let paused = false, captures = 0;
  const runtime = {
    async close() {},
    async querySandbox(value) { return { ...value, status: paused ? 'paused' as const : 'ready' as const }; },
    async resume() { paused = false; },
    async checkpoint() { paused = true; },
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
    assert.equal(captures, 0);
    const project = await manager.readProject('idle-project');
    assert.equal(project.sandboxOperation?.kind, 'checkpoint');
    assert.equal(project.sandboxOperation?.status, 'succeeded');
    assert.equal(project.remoteArchives?.length ?? 0, 0);
    assert.equal(project.sandboxBackup, undefined);
    await manager.scheduledArchive();
    assert.equal(captures, 0, 'later scheduler ticks must not back up a paused project');
    await manager.resumeProjectSandbox('idle-project');
    await manager.scheduledArchive();
    assert.equal(paused, false, 'a successful explicit resume starts a new idle interval');
    assert.equal(manager.getProject('idle-project').sandboxOperation?.kind, 'resume');
  } finally { await manager.close(); await rm(directory, { recursive: true, force: true }); }
});
