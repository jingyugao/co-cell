import assert from 'node:assert/strict';
import test from 'node:test';
import type { Project } from '../../protocol/types.js';
import type { SandboxState } from '../../protocol/sandbox-types.js';
import type { RemoteArchiveRef } from '../../protocol/remote-archive-types.js';
import type { SandboxRuntime } from '../execution/container-runtime.js';
import { MemoryWebStateStore } from '../testing/memory-web-state.js';
import { ProjectService } from './service.js';
import { ProjectSandboxOperations } from './sandbox-operations.js';
import type { ProjectImageSelection } from '../../protocol/image-types.js';

const workdir = '/home/agent/workspace';
const sandbox = (id = 'sandbox-old', status: SandboxState['status'] = 'ready'): SandboxState =>
  ({ id, status, template: 'base', workingDirectory: workdir });
const project = (id: string, overrides: Partial<Project> = {}): Project => ({
  id, name: 'sandbox operation', type: 1, requirementUrl: null, executionMode: 'sandbox', workingDirectory: workdir,
  status: 'active', completedAt: null, archivedAt: null, sandbox: sandbox(),
  createdAt: '2026-09-20T00:00:00.000Z', updatedAt: '2026-09-20T00:00:00.000Z', ...overrides,
});
const runtime = (control: { status?: SandboxState['status'] }, calls: string[]): SandboxRuntime => ({
  async close() {}, async *run() {}, async *recover() {}, detach() {},
  async file() { throw new Error('unused'); }, async history() { throw new Error('unused'); },
  async delete() {}, async rebuild() {},
  async inspect() { calls.push('inspect'); },
  async querySandbox(value) { calls.push('inspect'); return { ...value, status: control.status ?? 'ready' }; },
  async fenceSandbox(value) { calls.push(`fence:${value.id}`); },
  async detachSandbox() { calls.push('detach'); },
  async verifySandbox() { calls.push('verify'); },
  async deleteDanglingSandbox(id) { calls.push(`delete:${id}`); },
});
async function fixture(value: Project) {
  const state = new MemoryWebStateStore();
  await state.init(); await state.saveProject(value);
  const projects = new ProjectService(state); await projects.init();
  return { projects, async close() { await projects.close(); await state.close(); } };
}

test('resume reconnects a paused Sandbox without replacing its binding', async () => {
  const id = 'e1e1e1e1-e1e1-4e1e-8e1e-e1e1e1e1e1e1';
  const f = await fixture(project(id, { sandbox: sandbox('same-sandbox', 'paused') }));
  const calls: string[] = [];
  const control: { status: SandboxState['status'] } = { status: 'paused' };
  const sandboxRuntime: SandboxRuntime = {
    ...runtime(control, calls),
    async resume(value, save) {
      calls.push(`resume:${value.sandbox?.id}`);
      control.status = 'ready';
      await save({ ...value.sandbox!, status: 'ready' });
    },
  };
  const operations = new ProjectSandboxOperations({ projects: f.projects, runtime: sandboxRuntime,
    threadIds: () => [], saveSandbox: async (projectId, value) => { await f.projects.updateSandbox(projectId, value, false); },
    detached: async () => {} });
  try {
    await operations.run(id, 'resume');
    assert.deepEqual(calls, ['inspect', 'resume:same-sandbox']);
    assert.equal(f.projects.get(id).sandbox?.id, 'same-sandbox');
    assert.equal(f.projects.get(id).sandbox?.status, 'unknown');
    assert.equal(f.projects.get(id).sandboxOperation?.status, 'succeeded');
    await assert.rejects(operations.run(id, 'resume'), /Sandbox 未暂停/);
    assert.equal(f.projects.get(id).sandbox?.id, 'same-sandbox');
  } finally { await operations.close(); await f.close(); }
});

for (const outcome of ['succeeded', 'failed'] as const) test(`operation waits observe ${outcome} after timeout/disconnect without cancelling resume or following another operation`, async () => {
  const id = 'wait-resume';
  const f = await fixture(project(id, { sandbox: sandbox('same-sandbox', 'paused') }));
  let finishResume!: () => void;
  const barrier = new Promise<void>(resolve => { finishResume = resolve; });
  const operations = new ProjectSandboxOperations({ projects: f.projects,
    runtime: { ...runtime({ status: 'paused' }, []), async resume() {
      await barrier;
      if (outcome === 'failed') throw new Error('restore failed');
    } },
    threadIds: () => [], saveSandbox: async (projectId, value) => { await f.projects.updateSandbox(projectId, value, false); },
    detached: async () => {} });
  try {
    const { done } = await operations.start(id, 'resume');
    const operationId = f.projects.get(id).sandboxOperation!.id!;
    const controller = new AbortController();
    const disconnected = operations.wait(id, operationId, 10_000, controller.signal);
    controller.abort();
    await assert.rejects(disconnected, { name: 'AbortError' });
    await operations.wait(id, operationId, 1);
    assert.equal(f.projects.get(id).sandboxOperation?.status, 'running');
    assert.equal(f.projects.isMaintaining(id), true);
    for (const [projectId, token] of [[id, 'stale-operation'], ['another-project', operationId]]) {
      const immediate = await Promise.race([
        operations.wait(projectId, token, 10_000).then(() => true),
        new Promise<boolean>(resolve => setImmediate(() => resolve(false))),
      ]);
      assert.equal(immediate, true, 'a different operation/project must not inherit this wait');
    }
    const completion = operations.wait(id, operationId, 10_000);
    finishResume();
    if (outcome === 'failed') await assert.rejects(done, /restore failed/);
    else await done;
    await completion;
    await operations.wait(id, operationId, 10_000);
    assert.equal(f.projects.get(id).sandboxOperation?.status, outcome);
    assert.equal(f.projects.isMaintaining(id), false);
  } finally { finishResume(); await operations.close(); await f.close(); }
});

const remoteReference: RemoteArchiveRef = {
  id: 'arc-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', createdAt: '2026-09-20T01:00:00.000Z',
  sizeBytes: 128, sha256: 'b'.repeat(64), imageId: `registry.example/cellbox@sha256:${'a'.repeat(64)}`,
  sourceSandboxId: 'sandbox-old', threadIds: ['thread-1'],
};

for (const status of ['ready', 'paused'] as const) test(`cleanup uses an existing backup without capturing or resuming a ${status} box`, async () => {
  const id = 'checkpoint-existing-backup';
  const f = await fixture(project(id, { sandbox: sandbox('sandbox-old', status), remoteArchives: [remoteReference] }));
  const operations = new ProjectSandboxOperations({ projects: f.projects,
    runtime: { ...runtime({ status }, []), async resume() { assert.fail('must not resume'); },
      remoteArchives: { async capture() { assert.fail('must not capture'); }, async inspect() { return remoteReference; },
        async restore() { throw new Error('unused'); }, async activate() {} } },
    threadIds: () => [], saveSandbox: async () => {}, detached: async () => {} });
  try {
    await operations.run(id, 'archive', { useExistingBackup: true });
    assert.equal(f.projects.get(id).status, 'archived');
    assert.equal(f.projects.get(id).remoteArchives?.[0].id, remoteReference.id);
  } finally { await operations.close(); await f.close(); }
});

test('cleanup without a usable existing archive preserves the completed project and checkpoint', async () => {
  const id = 'checkpoint-no-backup';
  const f = await fixture(project(id, { status: 'completed', sandbox: sandbox('sandbox-old', 'paused') }));
  const operations = new ProjectSandboxOperations({ projects: f.projects,
    runtime: { ...runtime({ status: 'paused' }, []), async resume() { assert.fail('must not resume'); },
      async fenceSandbox() { assert.fail('must not fence'); }, async deleteDanglingSandbox() { assert.fail('must not delete'); },
      remoteArchives: { async capture() { assert.fail('must not capture'); }, async inspect() { throw new Error('archive missing'); },
        async restore() { throw new Error('unused'); }, async activate() {} } },
    threadIds: () => [], saveSandbox: async () => {}, detached: async () => { assert.fail('must not detach'); } });
  try {
    await assert.rejects(operations.run(id, 'archive', { useExistingBackup: true }), /未找到可恢复/);
    await f.projects.saveRemoteArchive(id, remoteReference);
    await assert.rejects(operations.run(id, 'archive', { useExistingBackup: true }), /最新 Cellbox 归档不可用/);
    assert.equal(f.projects.get(id).status, 'completed');
    assert.equal(f.projects.get(id).sandbox?.id, 'sandbox-old');
    assert.equal(f.projects.get(id).archiveCleanupSourceId, undefined);
    assert.equal(f.projects.get(id).sandboxOperation?.status, 'failed');
  } finally { await operations.close(); await f.close(); }
});

test('a failed backup health check preserves the reference and a later retry uses live Cellbox state', async () => {
  const id = 'backup-health';
  const f = await fixture(project(id));
  let failHealth = true;
  let captures = 0;
  const remoteRuntime: SandboxRuntime = {
    ...runtime({}, []),
    async verifySandbox() { if (failHealth) throw new Error('App Server temporarily unreachable'); },
    remoteArchives: {
      async capture() { captures++; return remoteReference; },
      async inspect() { return remoteReference; },
      async restore() { throw new Error('unused'); }, async activate() {},
    },
  };
  const operations = new ProjectSandboxOperations({ projects: f.projects, runtime: remoteRuntime, threadIds: () => [],
    saveSandbox: async () => { assert.fail('verification must not save a Sandbox status'); }, detached: async () => {} });
  try {
    await assert.rejects(operations.run(id, 'backup'), /App Server temporarily unreachable/);
    assert.equal(captures, 0);
    assert.equal(f.projects.get(id).sandbox?.id, 'sandbox-old');
    assert.equal(f.projects.get(id).sandbox?.status, 'unknown');
    assert.equal(f.projects.get(id).sandboxOperation?.status, 'failed');
    assert.equal((await remoteRuntime.querySandbox!(f.projects.get(id).sandbox!)).status, 'ready');
    failHealth = false;
    await operations.run(id, 'backup');
    assert.equal(captures, 1);
    assert.equal(f.projects.get(id).sandboxOperation?.status, 'succeeded');
    assert.equal(f.projects.get(id).remoteArchives?.[0].id, remoteReference.id);
  } finally { await operations.close(); await f.close(); }
});

test('Cellbox archive persists its verified reference before fencing the source', async () => {
  const id = 'd1d1d1d1-d1d1-4d1d-8d1d-d1d1d1d1d1d1';
  const f = await fixture(project(id));
  const calls: string[] = [];
  let failCapture = true;
  const remoteRuntime: SandboxRuntime = {
    ...runtime({}, calls),
    remoteArchives: {
      async capture(_target, key) {
        calls.push(`capture:${key}`);
        if (failCapture) throw new Error('Cellbox capture failed');
        return (({ threadIds: _threads, ...metadata }) => metadata)(remoteReference);
      },
      async inspect(reference) { calls.push('inspect-archive'); assert.equal(reference.id, remoteReference.id);
        return (({ threadIds: _threads, ...metadata }) => metadata)(remoteReference); },
      async restore() { throw new Error('unused'); }, async activate() { throw new Error('unused'); },
    },
    async fenceSandbox(value) {
      assert.equal(f.projects.get(id).remoteArchives?.[0]?.id, remoteReference.id);
      calls.push(`fence:${value.id}`);
    },
  };
  const operations = new ProjectSandboxOperations({ projects: f.projects, runtime: remoteRuntime,
    threadIds: () => ['thread-1'],
    saveSandbox: async () => {}, detached: async () => {} });
  try {
    await assert.rejects(operations.run(id, 'archive'), /Cellbox capture failed/);
    assert.equal(f.projects.get(id).sandbox?.id, 'sandbox-old');
    assert.equal(f.projects.get(id).remoteArchives, undefined);
    assert.equal(calls.some(call => call.startsWith('fence:')), false);
    failCapture = false;
    await operations.run(id, 'archive');
    assert.equal(f.projects.get(id).status, 'archived');
    assert.equal(f.projects.get(id).remoteArchives?.[0]?.id, remoteReference.id);
    assert.equal(f.projects.get(id).remoteArchives?.[0]?.threadIds[0], 'thread-1');
    assert.match(calls.find(call => call.startsWith('capture:'))!, /^capture:[0-9a-f-]+:capture$/);
    assert.ok(calls.indexOf('inspect-archive') < calls.indexOf('fence:sandbox-old'));
  } finally { await operations.close(); await f.close(); }
});

test('archive reports deletion failures and resumes its verified cleanup journal without recapturing', async () => {
  const id = 'archive-cleanup';
  const f = await fixture(project(id, { status: 'completed', completedAt: new Date(0).toISOString(), pendingSandboxCleanup: [sandbox('retired')] }));
  const control: { status?: SandboxState['status'] } = {};
  let failDelete = true, failLocalCleanup = false, captures = 0, detached = 0;
  const remoteRuntime: SandboxRuntime = { ...runtime(control, []),
    async fenceSandbox() { control.status = 'paused'; },
    async deleteDanglingSandbox(boxId) {
      if (failDelete && boxId === 'sandbox-old') throw new Error('provider deletion failed');
    },
    remoteArchives: {
      async capture() { captures++; return remoteReference; },
      async inspect() { return remoteReference; },
      async restore() { throw new Error('unused'); }, async activate() {},
    },
  };
  const createOperations = () => new ProjectSandboxOperations({ projects: f.projects, runtime: remoteRuntime, threadIds: () => ['thread-1'],
    saveSandbox: async () => {}, detached: async () => { detached++; if (failLocalCleanup) throw new Error('cache deletion failed'); } });
  let operations = createOperations();
  try {
    await assert.rejects(operations.run(id, 'archive'), /尚未清理完成/);
    let value = f.projects.get(id);
    assert.equal(value.status, 'completed');
    assert.equal(value.sandboxOperation?.status, 'failed');
    assert.equal(value.archiveCleanupSourceId, 'sandbox-old');
    assert.deepEqual(value.pendingSandboxCleanup?.map(box => box.id), ['sandbox-old']);
    assert.equal(detached, 0);
    await assert.rejects(operations.run(id, 'restore'), /归档清理尚未完成/);
    // Reload persisted project state to exercise recovery after a service restart.
    await operations.close(); await f.projects.init(); operations = createOperations();
    failDelete = false; failLocalCleanup = true;
    await assert.rejects(operations.run(id, 'archive'), /cache deletion failed/);
    assert.equal(f.projects.get(id).status, 'completed');
    assert.equal(f.projects.get(id).archiveCleanupSourceId, 'sandbox-old');
    failLocalCleanup = false;
    await operations.run(id, 'archive');
    value = f.projects.get(id);
    assert.equal(captures, 1, 'retries use the verified archive even after the source is stopped/deleted');
    assert.equal(value.status, 'archived');
    assert.equal(value.sandbox, undefined);
    assert.equal(value.pendingSandboxCleanup, undefined);
    assert.equal(value.archiveCleanupSourceId, undefined);
    assert.equal(value.sandboxOperation?.status, 'succeeded');
    assert.equal(value.remoteArchives?.[0].id, remoteReference.id);
  } finally { await operations.close(); await f.close(); }
});

test('legacy archives reconcile all known retired boxes and preserve their archive history', async () => {
  const id = 'legacy-artifacts';
  const archivedAt = '2026-09-20T00:00:00.000Z';
  const history = [{ id: 'record', action: 'archived' as const, at: archivedAt, sandboxId: 'older-source' }];
  const f = await fixture(project(id, { status: 'archived', archivedAt, sandbox: undefined, remoteArchives: [remoteReference], lifecycleHistory: history }));
  let failure = true;
  const deleted: string[] = [];
  const operations = new ProjectSandboxOperations({ projects: f.projects,
    runtime: { ...runtime({}, []), async listProjectSandboxes() { return [sandbox('lost-response-candidate')]; },
      async deleteDanglingSandbox(boxId) { deleted.push(boxId); if (failure && boxId === 'older-source') throw new Error('purge unavailable'); } },
    threadIds: () => [], saveSandbox: async () => { throw new Error('must not restore'); }, detached: async () => {} });
  try {
    await assert.rejects(operations.run(id, 'archive'), /尚未清理完成/);
    assert.equal(f.projects.get(id).sandboxArtifactsCleanedAt, undefined);
    assert.equal(f.projects.get(id).sandboxOperation?.status, 'failed');
    failure = false;
    await operations.run(id, 'archive');
    const value = f.projects.get(id);
    assert.ok(value.sandboxArtifactsCleanedAt);
    assert.equal(value.pendingSandboxCleanup, undefined);
    assert.equal(value.archivedAt, archivedAt);
    assert.deepEqual(value.lifecycleHistory, history);
    assert.deepEqual(value.remoteArchives, [remoteReference]);
    assert.ok(deleted.includes(remoteReference.sourceSandboxId));
    assert.ok(deleted.includes('older-source'));
    assert.ok(deleted.includes('lost-response-candidate'));
  } finally { await operations.close(); await f.close(); }
});

test('Cellbox backup keeps the configured number of owned references', async () => {
  const id = 'd4d4d4d4-d4d4-4d4d-8d4d-d4d4d4d4d4d4';
  const f = await fixture(project(id, { backupRetentionCount: 2 }));
  let count = 0;
  let latest = remoteReference;
  const removed: string[] = [];
  const remoteRuntime: SandboxRuntime = { ...runtime({}, []), remoteArchives: {
    async capture() {
      count++;
      latest = { ...remoteReference, id: `arc-${String(count).padStart(32, '0')}` };
      const { threadIds: _threads, ...metadata } = latest;
      return metadata;
    },
    async inspect() { const { threadIds: _threads, ...metadata } = latest; return metadata; },
    async restore() { throw new Error('unused'); }, async activate() { throw new Error('unused'); },
    async remove(reference) { removed.push(reference.id); },
  } };
  const operations = new ProjectSandboxOperations({ projects: f.projects, runtime: remoteRuntime,
    threadIds: () => [],
    saveSandbox: async () => {}, detached: async () => {} });
  try {
    for (let index = 0; index < 3; index++) await operations.run(id, 'backup');
    assert.deepEqual(f.projects.get(id).remoteArchives?.map(value => value.id), [
      'arc-00000000000000000000000000000003', 'arc-00000000000000000000000000000002',
    ]);
    assert.deepEqual(removed, ['arc-00000000000000000000000000000001']);
  } finally { await operations.close(); await f.close(); }
});

test('Cellbox staged restore failure leaves the old binding intact and retries latest reference', async () => {
  const id = 'd2d2d2d2-d2d2-4d2d-8d2d-d2d2d2d2d2d2';
  const f = await fixture(project(id, { sandbox: sandbox('old', 'unavailable'), remoteArchives: [remoteReference] }));
  const calls: string[] = [];
  let failRestore = true;
  let failActivation = true;
  const remoteRuntime: SandboxRuntime = {
    ...runtime({ status: 'unavailable' }, calls),
    async currentImageIdentity() { return { id: remoteReference.imageId, reference: 'cellbox:test', repoDigests: [] }; },
    remoteArchives: {
      async capture() { throw new Error('unused'); },
      async inspect(reference) { calls.push(`inspect:${reference.id}`);
        return (({ threadIds: _threads, ...metadata }) => metadata)(remoteReference); },
      async restore(_target, reference, key, onCandidate) {
        calls.push(`restore:${reference.id}:${key}`);
        const candidate = { ...sandbox('new', 'starting'), workingDirectory: '/workspace' };
        await onCandidate(candidate);
        if (failRestore) throw new Error('staged restore failed');
        return candidate;
      },
      async activate() { calls.push('activate'); if (failActivation) throw new Error('candidate setup failed'); },
    },
  };
  const operations = new ProjectSandboxOperations({ projects: f.projects, runtime: remoteRuntime,
    threadIds: () => ['thread-1'],
    saveSandbox: async (projectId, value, restore) => { await f.projects.updateSandbox(projectId, value, restore); },
    detached: async () => {} });
  try {
    await assert.rejects(operations.run(id, 'restore'), /staged restore failed/);
    assert.equal(f.projects.get(id).sandbox?.id, 'old');
    assert.equal(f.projects.get(id).workingDirectory, workdir);
    assert.equal(calls.includes('fence:new'), true);
    assert.equal(calls.includes('fence:old'), false);
    failRestore = false;
    await assert.rejects(operations.run(id, 'restore'), /candidate setup failed/);
    assert.equal(f.projects.get(id).sandbox?.id, 'old');
    assert.equal(f.projects.get(id).workingDirectory, workdir);
    assert.equal(calls.includes('fence:old'), false);
    assert.equal(calls.includes('detach'), false);
    assert.equal(f.projects.get(id).pendingSandboxCleanup?.some(item => item.id === 'new'), true);
    failActivation = false;
    await operations.run(id, 'restore');
    assert.equal(f.projects.get(id).sandbox?.id, 'new');
    assert.equal(f.projects.get(id).workingDirectory, '/workspace');
    assert.ok(calls.lastIndexOf('verify') < calls.lastIndexOf('fence:old'));
  } finally { await operations.close(); await f.close(); }
});

test('archived portable restore switches image only after history verification and preserves backup on failure', async () => {
  const selection = (version: string): ProjectImageSelection => ({ imageId: 'go', imageName: 'Go', category: '开发', versionId: version,
    version, importedImageId: `image-${version}`, image: `registry.example/cellbox@sha256:${(version === 'v1' ? 'a' : 'c').repeat(64)}` });
  const old = { ...selection('v1'), image: remoteReference.imageId }, next = selection('v2');
  const ref = { ...remoteReference, portable: true };
  const f = await fixture(project('archived', { status: 'archived', sandbox: undefined, remoteArchives: [ref], imageSelection: old }));
  const calls: string[] = [];
  let failHistory = true, releases = 0;
  const remoteRuntime: SandboxRuntime = { ...runtime({}, calls),
    async currentImageIdentity(target) { return { id: target!.imageSelection!.image, reference: target!.imageSelection!.image, repoDigests: [] }; },
    async verifyHistory(_box, threads) { assert.deepEqual(threads, ref.threadIds); if (failHistory) throw new Error('history not ready'); },
    remoteArchives: {
      async capture() { throw new Error('unused'); }, async inspect() { return ref; }, async activate() {},
      async restore(target, archive, _key, onCandidate) {
        assert.equal(target.imageSelection?.versionId, next.versionId); assert.equal(archive.id, ref.id);
        const candidate = { ...sandbox('new', 'starting'), image: { id: next.image, reference: next.image, repoDigests: [] } };
        await onCandidate(candidate); return candidate;
      },
    },
  };
  const operations = new ProjectSandboxOperations({ projects: f.projects, runtime: remoteRuntime,
    threadIds: () => ref.threadIds, detached: async () => {},
    selectRestoreImage: async () => ({ selection: next, release() { releases++; } }),
    saveSandbox: async (id, box, restored, image) => {
      assert.equal(f.projects.get(id).imageSelection?.versionId, old.versionId);
      await f.projects.updateSandbox(id, box, restored, image);
    },
  });
  try {
    await assert.rejects(operations.run('archived', 'restore'), /history not ready/);
    assert.equal(f.projects.get('archived').status, 'archived'); assert.equal(f.projects.get('archived').sandbox, undefined);
    assert.deepEqual(f.projects.get('archived').imageSelection, old); assert.deepEqual(f.projects.get('archived').remoteArchives, [ref]);
    assert.equal(releases, 1);
    failHistory = false;
    await operations.run('archived', 'restore');
    assert.equal(f.projects.get('archived').status, 'active'); assert.deepEqual(f.projects.get('archived').imageSelection, next);
    assert.equal(f.projects.get('archived').sandbox?.id, 'new'); assert.equal(releases, 2);
    await assert.rejects(operations.run('archived', 'restore', { imageVersionId: 'v1' }), /仅归档项目/);
  } finally { await operations.close(); await f.close(); }
});

for (const fails of [false, true]) test(`mounted HOME rebuild ${fails ? 'failure retains the binding' : 'ignores an older archive'}`, async () => {
  const id = `mounted-rebuild-${fails}`;
  const f = await fixture(project(id, { sandbox: sandbox('same-box', 'unavailable'), remoteArchives: [remoteReference] }));
  const calls: string[] = [];
  const control: { status: SandboxState['status'] } = { status: 'unavailable' };
  const operations = new ProjectSandboxOperations({ projects: f.projects,
    runtime: { ...runtime(control, calls),
      async rebuildPersistent(value, key, save) {
        assert.equal(value.sandbox?.id, 'same-box');
        assert.match(key, /:rebuild$/);
        calls.push('rebuild');
        if (fails) throw new Error('persistent HOME missing');
        control.status = 'ready';
        await save(sandbox('same-box', 'ready'));
      },
      async verifyHistory(value, threads) {
        assert.equal(value.id, 'same-box');
        assert.deepEqual(threads, ['latest-thread']);
        calls.push('history');
      },
      async deleteDanglingSandbox() { assert.fail('must retain HOME owner'); },
      remoteArchives: {
        async capture() { assert.fail('must not archive'); },
        async inspect() { assert.fail('must not inspect archive'); },
        async restore() { assert.fail('must not restore archive'); }, async activate() { assert.fail('must not activate archive'); },
      },
    }, threadIds: () => ['latest-thread'],
    saveSandbox: async (projectId, value) => { await f.projects.updateSandbox(projectId, value, false); },
    detached: async () => { assert.fail('must retain binding'); } });
  try {
    if (fails) await assert.rejects(operations.run(id, 'rebuild'), /persistent HOME missing/);
    else await operations.run(id, 'rebuild');
    assert.equal(f.projects.get(id).sandbox?.id, 'same-box');
    assert.equal(f.projects.get(id).remoteArchives?.[0].id, remoteReference.id);
    assert.deepEqual(calls, fails ? ['inspect', 'rebuild'] : ['inspect', 'rebuild', 'verify', 'history']);
    assert.equal(f.projects.get(id).sandboxOperation?.status, fails ? 'failed' : 'succeeded');
  } finally { await operations.close(); await f.close(); }
});

test('retry after a cold rebuild prepares the ready execution without rebuilding it again', async () => {
  const id = 'rebuild-prepare-retry';
  const f = await fixture(project(id, { sandbox: sandbox('same-box', 'unavailable') }));
  const control: { status: SandboxState['status'] } = { status: 'unavailable' };
  let rebuilds = 0, preparations = 0;
  const operations = new ProjectSandboxOperations({ projects: f.projects,
    runtime: { ...runtime(control, []),
      async rebuildPersistent(value, _key, save) {
        if (control.status === 'ready') { preparations++; await save({ ...value.sandbox!, status: 'ready' }); return; }
        rebuilds++; control.status = 'ready'; await save({ ...value.sandbox!, status: 'ready' });
        throw new Error('configuration temporarily failed');
      },
      async resume(value, save) { preparations++; await save({ ...value.sandbox!, status: 'ready' }); },
    }, threadIds: () => [], saveSandbox: async (projectId, value) => { await f.projects.updateSandbox(projectId, value, false); },
    detached: async () => { assert.fail('must retain binding'); } });
  try {
    await assert.rejects(operations.run(id, 'rebuild'), /configuration temporarily failed/);
    await operations.run(id, 'rebuild');
    assert.equal(rebuilds, 1); assert.equal(preparations, 1);
    assert.equal(f.projects.get(id).sandbox?.id, 'same-box');
    assert.equal(f.projects.get(id).sandboxOperation?.status, 'succeeded');
  } finally { await operations.close(); await f.close(); }
});
