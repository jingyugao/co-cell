import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Project, ProjectSummary, Session, Settings } from '../../protocol/types.js';
import type { SandboxMount, SandboxState } from '../../protocol/sandbox-types.js';
import type { RemoteArchiveRef } from '../../protocol/remote-archive-types.js';
import type { SandboxRuntime } from '../execution/container-runtime.js';
import { installProjectsRoutes } from '../projects/routes.js';
import { MemoryWebStateStore } from '../testing/memory-web-state.js';
import { SessionManager, type CodexClient } from './manager.js';
import { canEnterProject, isProjectSandboxReady } from '../../util/project-sandbox.js';
import { CellboxError } from '../../packages/sandbox/src/providers/cellbox/client.js';

type VolumeSandboxState = SandboxState;
type VolumeProject = Project;

test('release keeps project mounts and conversation thread for a new Box on the same volume', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cocell-release-volume-'));
  const state = new MemoryWebStateStore();
  const defaults: Settings = { executionMode: 'sandbox', workingDirectory: '/home/agent/workspace', model: 'test',
    modelReasoningEffort: 'low', sandboxMode: 'danger-full-access', webSearchMode: 'disabled', networkAccessEnabled: true };
  const at = new Date().toISOString();
  const mounts: SandboxMount[] = [{ volumeId: 'workspace-volume', mountPath: '/home/agent' }];
  const original = { id: 'released-box', status: 'ready' as const, template: 'default',
    workingDirectory: defaults.workingDirectory } satisfies VolumeSandboxState;
  const project: VolumeProject = { id: 'release-project', name: 'Release project', type: 1, requirementUrl: null,
    status: 'active', executionMode: 'sandbox', workingDirectory: defaults.workingDirectory, completedAt: null, archivedAt: null,
    createdAt: at, updatedAt: at, sandbox: original };
  const session: Session = { id: 'release-session', projectId: project.id, threadId: 'thread-kept', title: 'Existing thread',
    settings: defaults, status: 'idle', startedAt: at, archivedAt: null, createdAt: at, updatedAt: at, turns: [], sandbox: original };
  await state.saveProject(project);
  await state.saveSession(session);
  const calls: string[] = [];
  const recreated = { ...original, id: 'replacement-box', status: 'ready' as const, mounts } satisfies VolumeSandboxState;
  const runtime = {
    async close() {},
    async release(target) {
      calls.push('release');
      assert.equal(target.sandbox?.id, original.id);
      assert.equal(target.sandbox?.homeVolumeId, undefined, 'Legacy Box state has not published its promoted HOME volume yet');
      return { ...target.sandbox!, status: 'unavailable' as const, homeVolumeId: 'workspace-volume' };
    },
    async rebuild(target, save) {
      calls.push('create');
      assert.equal(target.sandbox, undefined, 'Released Box reference must not be reused');
      assert.deepEqual(target.sandboxMounts, mounts,
        'Create must receive the project volume attachment after release');
      await save(recreated);
    },
    async verifySandbox() {},
  } satisfies Partial<SandboxRuntime> & { release(target: import('../sandboxes/types.js').WorkspaceTarget): Promise<SandboxState> };
  const manager = new SessionManager({} as CodexClient, directory, defaults, state, runtime as unknown as SandboxRuntime);
  const app = new Hono(); installProjectsRoutes(app, manager);
  try {
    await manager.init();
    const releasedResponse = await app.request(`/api/projects/${project.id}/sandbox/release`, { method: 'POST' });
    assert.equal(releasedResponse.status, 200);
    const released = await releasedResponse.json() as ProjectSummary;
    assert.equal(released.sandbox, undefined);
    assert.deepEqual(released.sandboxMounts, mounts);
    assert.deepEqual(calls, ['release']);
    assert.equal(manager.get(session.id).threadId, 'thread-kept');

    const createdResponse = await app.request(`/api/projects/${project.id}/sandbox/create`, { method: 'POST' });
    assert.equal(createdResponse.status, 200);
    const created = await createdResponse.json() as ProjectSummary;
    assert.equal(created.sandbox?.id, recreated.id);
    assert.deepEqual((created.sandbox as VolumeSandboxState).mounts, mounts);
    assert.deepEqual(created.sandboxMounts, mounts);
    assert.equal(manager.get(session.id).threadId, 'thread-kept');
    assert.deepEqual(calls, ['release', 'create']);
  } finally { await manager.close(); await rm(directory, { recursive: true, force: true }); }
});

test('release BUSY and UNKNOWN outcomes submit once and retain Box, volume, and thread bindings', async () => {
  for (const code of ['BUSY', 'UNKNOWN_OUTCOME'] as const) {
    const directory = await mkdtemp(join(tmpdir(), `cocell-release-${code.toLowerCase()}-`));
    const state = new MemoryWebStateStore();
    const defaults: Settings = { executionMode: 'sandbox', workingDirectory: '/home/agent/workspace', model: 'test',
      modelReasoningEffort: 'low', sandboxMode: 'danger-full-access', webSearchMode: 'disabled', networkAccessEnabled: true };
    const at = new Date().toISOString();
    const mounts: SandboxMount[] = [{ volumeId: 'workspace-volume', mountPath: '/home/agent' }];
    const box = { id: 'release-box', status: 'ready' as const, template: 'default',
      workingDirectory: defaults.workingDirectory, mounts } satisfies VolumeSandboxState;
    const project: VolumeProject = { id: `release-${code.toLowerCase()}`, name: 'Release failure', type: 1, requirementUrl: null,
      status: 'active', executionMode: 'sandbox', workingDirectory: defaults.workingDirectory, completedAt: null, archivedAt: null,
      createdAt: at, updatedAt: at, sandbox: box, sandboxMounts: mounts };
    const session: Session = { id: `session-${code.toLowerCase()}`, projectId: project.id, threadId: 'thread-kept', title: 'Existing thread',
      settings: defaults, status: 'idle', startedAt: at, archivedAt: null, createdAt: at, updatedAt: at, turns: [], sandbox: box };
    await state.saveProject(project);
    await state.saveSession(session);
    let submissions = 0;
    const runtime = {
      async close() {},
      async release() {
        submissions++;
        throw new CellboxError(code, `Cellbox release ${code}`, code === 'BUSY' ? 409 : 502);
      },
    } satisfies Partial<SandboxRuntime> & { release(target: import('../sandboxes/types.js').WorkspaceTarget): Promise<SandboxState> };
    const manager = new SessionManager({} as CodexClient, directory, defaults, state, runtime as unknown as SandboxRuntime);
    const app = new Hono(); installProjectsRoutes(app, manager);
    try {
      await manager.init();
      const response = await app.request(`/api/projects/${project.id}/sandbox/release`, { method: 'POST' });
      assert.notEqual(response.status, 200, `${code} must not be reported as a successful release`);
      await (manager as unknown as { sandboxOperations: { close(): Promise<void> } }).sandboxOperations.close();
      const retained = manager.getProject(project.id);
      assert.equal(submissions, 1, `${code} release is not automatically replayed`);
      assert.equal(retained.sandbox?.id, box.id);
      assert.deepEqual(retained.sandboxMounts, mounts);
      assert.equal(manager.get(session.id).threadId, 'thread-kept');
      assert.equal(retained.sandboxOperation?.errorCode, code);
    } finally { await manager.close(); await rm(directory, { recursive: true, force: true }); }
  }
});

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

test('single-API idle checkpoint skips system, only pauses, and never captures disk', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cocell-idle-backup-'));
  const state = new MemoryWebStateStore();
  const defaults: Settings = { executionMode: 'sandbox', workingDirectory: '/home/agent/workspace', model: 'test',
    modelReasoningEffort: 'low', sandboxMode: 'danger-full-access', webSearchMode: 'disabled', networkAccessEnabled: true };
  const paused = new Set<string>();
  let captures = 0;
  const runtime = {
    async close() {},
    async querySandbox(value) { return { ...value, status: paused.has(value.id) ? 'paused' as const : 'ready' as const }; },
    async resume(target) { paused.delete(target.sandbox!.id); },
    async checkpoint(target) { paused.add(target.sandbox!.id); },
    remoteArchives: { async capture(value) { assert.equal(value.sandbox?.status, 'paused'); captures++; return {
      id: 'idle-archive', sourceSandboxId: 'idle-box', imageId: 'image', createdAt: new Date().toISOString(), sizeBytes: 10, sha256: 'a'.repeat(64),
    }; }, async inspect(ref) { return ref; }, async restore() { throw new Error('unused'); }, async activate() {} },
  } satisfies Partial<SandboxRuntime>;
  await state.init();
  await state.saveProject({ id: 'idle-project', name: 'idle project', status: 'active', executionMode: 'sandbox', requirementUrl: null,
    workingDirectory: defaults.workingDirectory, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
    sandbox: { id: 'idle-box', status: 'ready', template: 'default', workingDirectory: defaults.workingDirectory } });
  await state.saveProject({ id: 'system-project', name: 'system', status: 'active', executionMode: 'sandbox', requirementUrl: null,
    workingDirectory: defaults.workingDirectory, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
    sandbox: { id: 'system-box', status: 'ready', template: 'default', workingDirectory: defaults.workingDirectory } });
  const manager = new SessionManager({} as CodexClient, directory, defaults, state, runtime as unknown as SandboxRuntime);
  try {
    await manager.init();
    await manager.scheduledArchive();
    await (manager as unknown as { sandboxOperations: { close(): Promise<void> } }).sandboxOperations.close();
    assert.equal(paused.has('idle-box'), true);
    assert.equal(paused.has('system-box'), false, 'system stays running even after exceeding the idle timeout');
    assert.equal(manager.getProject('system-project').sandboxOperation, undefined);
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
    assert.equal(paused.has('idle-box'), false, 'a successful explicit resume starts a new idle interval');
    assert.equal(manager.getProject('idle-project').sandboxOperation?.kind, 'resume');
    await manager.checkpointProjectSandbox('system-project');
    assert.equal(paused.has('system-box'), true, 'system still supports an explicit manual pause');
  } finally { await manager.close(); await rm(directory, { recursive: true, force: true }); }
});

test('deleting a completed project releases, backs up, removes its volume, and keeps only its recovery catalog', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cocell-delete-volume-'));
  const state = new MemoryWebStateStore();
  const defaults: Settings = { executionMode: 'sandbox', workingDirectory: '/home/agent/workspace', model: 'test',
    modelReasoningEffort: 'low', sandboxMode: 'danger-full-access', webSearchMode: 'disabled', networkAccessEnabled: true };
  const at = new Date().toISOString();
  const mounts: SandboxMount[] = [{ volumeId: 'completed-volume', mountPath: '/home/agent' }];
  const box: SandboxState = { id: 'completed-box', status: 'ready', template: 'default',
    workingDirectory: defaults.workingDirectory, mounts };
  const project: Project = { id: 'completed-project', name: 'Completed project', type: 1, requirementUrl: null,
    status: 'completed', completedAt: at, archivedAt: null, executionMode: 'sandbox', workingDirectory: defaults.workingDirectory,
    sandbox: box, sandboxMounts: mounts, sandboxOwnerKey: 'owner-key', createdAt: at, updatedAt: at };
  const session: Session = { id: 'completed-session', projectId: project.id, threadId: 'thread-to-recover', title: 'Thread',
    settings: defaults, status: 'idle', startedAt: at, archivedAt: null, createdAt: at, updatedAt: at, turns: [], sandbox: box };
  await state.saveProject(project);
  await state.saveSession(session);
  const calls: string[] = [];
  const backupId = 'd'.repeat(64);
  const backup = { storageType: 'cellbox-volume' as const, id: `volume:${mounts[0].volumeId}:${backupId}`,
    volumeId: mounts[0].volumeId, snapshotId: backupId, ownerKey: 'owner-key', profileId: 'profile', mounts,
    createdAt: at, threadIds: [] as string[] };
  const candidate: SandboxState = { id: 'restored-box', status: 'ready', template: 'default',
    workingDirectory: defaults.workingDirectory, mounts };
  let restoredThreadIds: string[] | undefined;
  const runtime = {
    async close() {},
    async release() { calls.push('release'); return { ...box, status: 'unavailable' as const }; },
    async verifySandbox() {}, async fenceSandbox() {}, async detachSandbox() {},
    remoteArchives: {
      async capture(target) { calls.push('backup'); assert.deepEqual(target.sandboxMounts, mounts); return backup; },
      async inspect(ref) { return ref; }, async activate() {},
      async removeVolume(volumeId: string) { calls.push(`delete-volume:${volumeId}`); },
      async restore(_target, ref) { calls.push('restore'); restoredThreadIds = ref.threadIds; return candidate; },
  },
  } satisfies Partial<SandboxRuntime>;
  const manager = new SessionManager({} as CodexClient, directory, defaults, state, runtime as unknown as SandboxRuntime);
  const app = new Hono();
  app.onError((error, c) => c.json({ error: error.message }, ((error as { status?: number }).status ?? 500) as ContentfulStatusCode));
  installProjectsRoutes(app, manager);
  try {
    await manager.init();
    const response = await app.request(`/api/projects/${project.id}`, { method: 'DELETE' });
    assert.equal(response.status, 200);
    await (manager as unknown as { sandboxOperations: { close(): Promise<void> } }).sandboxOperations.close();
    assert.deepEqual(calls, ['release', 'backup', `delete-volume:${mounts[0].volumeId}`]);
    assert.equal(manager.listProjects().some(item => item.id === project.id), false);
    assert.equal(manager.list().some(item => item.id === session.id), false);
    assert.equal((await state.listSessions()).some(item => item.id === session.id), false);
    assert.equal((await app.request(`/api/projects/${project.id}`)).status, 404);
    const recovery = (await manager.listArchiveProjects()).find(item => item.id === project.id);
    assert.ok(recovery?.removedAt);
    assert.deepEqual(recovery?.remoteArchives?.[0]?.threadIds, ['thread-to-recover']);
    assert.equal(recovery?.archiveVersions?.[0]?.id, backup.id);

    await manager.restoreProjectSandbox(project.id);
    assert.equal(manager.getProject(project.id).removedAt, undefined);
    assert.equal(manager.listProjects().some(item => item.id === project.id), true);
    assert.equal(manager.getProject(project.id).sandbox?.id, candidate.id);
    assert.deepEqual(restoredThreadIds, ['thread-to-recover']);
  } finally { await manager.close(); await rm(directory, { recursive: true, force: true }); }
});

test('BUSY and UNKNOWN backup outcomes keep the removed project recoverable and never delete its volume', async () => {
  for (const code of ['BUSY', 'UNKNOWN_OUTCOME'] as const) {
    const directory = await mkdtemp(join(tmpdir(), `cocell-delete-backup-${code.toLowerCase()}-`));
    const state = new MemoryWebStateStore();
    const defaults: Settings = { executionMode: 'sandbox', workingDirectory: '/home/agent/workspace', model: 'test',
      modelReasoningEffort: 'low', sandboxMode: 'danger-full-access', webSearchMode: 'disabled', networkAccessEnabled: true };
    const at = new Date().toISOString();
    const mounts: SandboxMount[] = [{ volumeId: 'protected-volume', mountPath: '/home/agent' }];
    const box: SandboxState = { id: 'protected-box', status: 'ready', template: 'default',
      workingDirectory: defaults.workingDirectory, mounts };
    const project: Project = { id: `protected-${code.toLowerCase()}`, name: 'Protected completed project', type: 1,
      requirementUrl: null, status: 'completed', completedAt: at, archivedAt: null, executionMode: 'sandbox',
      workingDirectory: defaults.workingDirectory, sandbox: box, sandboxMounts: mounts, createdAt: at, updatedAt: at };
    const session: Session = { id: `protected-session-${code.toLowerCase()}`, projectId: project.id, threadId: 'thread-kept',
      title: 'Thread', settings: defaults, status: 'idle', startedAt: at, archivedAt: null, createdAt: at, updatedAt: at,
      turns: [], sandbox: box };
    await state.saveProject(project);
    await state.saveSession(session);
    let captures = 0, volumeDeletes = 0;
    const runtime = {
      async close() {},
      async release() { return { ...box, status: 'unavailable' as const }; },
      remoteArchives: {
        async capture() { captures++; throw new CellboxError(code, `Cellbox backup ${code}`, code === 'BUSY' ? 409 : 502); },
        async inspect(ref) { return ref; }, async activate() {},
        async restore() { assert.fail('failed backup must not proceed to restore'); },
        async removeVolume() { volumeDeletes++; },
      },
    } satisfies Partial<SandboxRuntime>;
    const manager = new SessionManager({} as CodexClient, directory, defaults, state, runtime as unknown as SandboxRuntime);
    const app = new Hono(); installProjectsRoutes(app, manager);
    try {
      await manager.init();
      const response = await app.request(`/api/projects/${project.id}`, { method: 'DELETE' });
      assert.notEqual(response.status, 200, `${code} must not report project deletion as successful`);
      await (manager as unknown as { sandboxOperations: { close(): Promise<void> } }).sandboxOperations.close();
      assert.equal(captures, 1, `${code} backup is submitted once`);
      assert.equal(volumeDeletes, 0, `${code} must stop before disk deletion`);
      assert.equal(manager.listProjects().some(item => item.id === project.id), true);
      assert.equal(manager.list().some(item => item.id === session.id), true);
      assert.equal((await state.listSessions()).some(item => item.id === session.id), true);
      assert.equal(manager.getProject(project.id).removedAt, undefined);
      assert.equal(manager.getProject(project.id).sandboxOperation?.errorCode, code);
      assert.equal(manager.getProject(project.id).sandboxOperation?.status, code === 'UNKNOWN_OUTCOME' ? 'unknown' : 'failed');
    } finally { await manager.close(); await rm(directory, { recursive: true, force: true }); }
  }
});

test('archive directory uses the local index and keyed version refresh queries only its owning project', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cocell-archive-index-'));
  const state = new MemoryWebStateStore();
  const defaults: Settings = { executionMode: 'sandbox', workingDirectory: '/home/agent/workspace', model: 'test',
    modelReasoningEffort: 'low', sandboxMode: 'danger-full-access', webSearchMode: 'disabled', networkAccessEnabled: true };
  const at = new Date().toISOString();
  const archive = (projectId: string): RemoteArchiveRef => ({
    storageType: 'cellbox-volume', id: `volume:${projectId}:${projectId}`, volumeId: projectId, snapshotId: projectId,
    ownerKey: `project:${projectId}`, profileId: 'profile', mounts: [{ volumeId: projectId, mountPath: '/home/agent' }],
    createdAt: at, threadIds: [],
  });
  const projects: Project[] = [
    { id: 'archive-a', name: 'A', type: 1, requirementUrl: null, status: 'archived', removedAt: at,
      executionMode: 'sandbox', workingDirectory: defaults.workingDirectory, remoteArchives: [archive('archive-a')], createdAt: at, updatedAt: at },
    { id: 'archive-b', name: 'B', type: 1, requirementUrl: null, status: 'archived',
      executionMode: 'sandbox', workingDirectory: defaults.workingDirectory, remoteArchives: [archive('archive-b')], createdAt: at, updatedAt: at },
  ];
  for (const project of projects) await state.saveProject(project);
  const nativeQueries: string[] = [];
  const runtime = {
    async close() {},
    remoteArchives: {
      async list(target: { projectId?: string }, references: readonly RemoteArchiveRef[]) {
        nativeQueries.push(target.projectId ?? 'missing-project-id');
        return [...references];
      },
    },
  } as unknown as SandboxRuntime;
  const manager = new SessionManager({} as CodexClient, directory, defaults, state, runtime);
  try {
    await manager.init();
    const indexed = await manager.listArchiveProjects();
    assert.deepEqual(indexed.map(project => project.id).sort(), ['archive-a', 'archive-b']);
    assert.ok(indexed.find(project => project.id === 'archive-a')?.removedAt, 'removed projects remain recoverable from the local index');
    assert.deepEqual(nativeQueries, [], 'opening the directory performs no native snapshots scan');

    const selectedKey = archive('archive-b').id;
    const selected = await manager.listArchiveProjects(selectedKey);
    assert.deepEqual(selected.map(project => project.id), ['archive-b']);
    assert.deepEqual(nativeQueries, ['archive-b'], 'refresh is scoped to the project that owns the selected key');

    assert.deepEqual(await manager.listArchiveProjects('missing-volume-backup'), []);
    assert.deepEqual(nativeQueries, ['archive-b'], 'an unknown key does not query any native catalog');
  } finally { await manager.close(); await rm(directory, { recursive: true, force: true }); }
});
