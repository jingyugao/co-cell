import assert from 'node:assert/strict';
import test from 'node:test';
import type { ProjectImageSelection } from '../../protocol/image-types.js';
import type { Project } from '../../protocol/types.js';
import type { SandboxState } from '../../protocol/sandbox-types.js';
import type { RemoteArchiveRef } from '../../protocol/remote-archive-types.js';
import type { SandboxRuntime } from '../execution/container-runtime.js';
import { MemoryWebStateStore } from '../testing/memory-web-state.js';
import { ProjectService } from './service.js';
import { ProjectSandboxOperations } from './sandbox-operations.js';
import { CellboxError } from '../../packages/sandbox/src/providers/cellbox/client.js';

const workspace = '/home/agent/workspace';
const box = (status: SandboxState['status'] = 'ready', id = 'box-old'): SandboxState => ({ id, status, template: 'test', workingDirectory: workspace });
const archive: RemoteArchiveRef = { id: 'archive-one', sourceSandboxId: 'box-old', imageId: 'image-one', createdAt: new Date(0).toISOString(), sizeBytes: 10, sha256: 'a'.repeat(64), threadIds: ['thread-one'], portable: true };
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
async function fixture(overrides: Partial<Project> = {}, changes: Partial<SandboxRuntime> = {}, selection?: ProjectImageSelection) {
  const store = new MemoryWebStateStore();
  const project: Project = { id: 'project-one', name: 'One', type: 1, status: 'active', requirementUrl: null,
    executionMode: 'sandbox', workingDirectory: workspace, sandbox: box(), createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(), ...overrides };
  await store.saveProject(project);
  const projects = new ProjectService(store); await projects.init();
  const calls: string[] = [];
  let observed: SandboxState['status'] = overrides.sandbox?.status ?? 'ready';
  const runtime = {
    async close() {}, async *run() {}, async *recover() {}, detach() {},
    async file() { throw new Error('unused'); }, async history() { throw new Error('unused'); },
    async delete() {}, async rebuild() {},
    async querySandbox(value) { return { ...value, status: observed }; },
    async resume(value) { calls.push('resume'); observed = 'ready'; return { ...value.sandbox!, status: 'ready' }; },
    async checkpoint(value) { calls.push('checkpoint'); observed = 'paused'; return { ...value.sandbox!, status: 'paused' }; },
    async verifySandbox() { calls.push('verify'); }, async verifyHistory() { calls.push('history'); },
    async fenceSandbox(value) { calls.push('fence:' + value.id); }, async detachSandbox() { calls.push('detach'); },
    async deleteDanglingSandbox(id) { calls.push('delete:' + id); },
    remoteArchives: {
      async capture() { calls.push('capture'); return archive; },
      async inspect() { calls.push('inspect-archive'); return archive; },
      async restore(_target, _archive, _requestId, candidate) { const next = box('starting', 'box-new'); await candidate(next); return next; },
      async activate() { calls.push('activate'); },
      async download() {}, async remove() { calls.push('remove-archive'); },
    },
    ...changes,
  } satisfies SandboxRuntime;
  const operations = new ProjectSandboxOperations({ projects, runtime, threadIds: () => ['thread-one'],
    ...(selection ? { selectRestoreImage: async () => ({ selection, release() {} }) } : {}),
    async saveSandbox(id, value, restore, image, expectedId) {
      if (!await projects.updateSandbox(id, value, restore, image, expectedId)) throw new Error('Project binding changed');
    }, detached: async () => { calls.push('detached'); } });
  return { store, projects, operations, calls, runtime, async close() { await operations.close(); await projects.close(); await store.close(); } };
}

test('an explicit resume submits once and reports its runtime result', async () => {
  const f = await fixture({ sandbox: box('paused') });
  try {
    await f.operations.run('project-one', 'resume');
    assert.deepEqual(f.calls, ['resume']);
    assert.equal(f.projects.get('project-one').sandboxOperation?.result?.sandbox.status, 'ready');
    assert.equal(f.projects.get('project-one').sandbox?.id, 'box-old');
  } finally { await f.close(); }
});

test('a lost response remains unknown; only another explicit request submits again', async () => {
  let calls = 0;
  const f = await fixture({ sandbox: box('paused') }, { async resume() { calls++; throw new CellboxError('UNKNOWN_OUTCOME', 'connection lost after submission password=hidden'); } });
  try {
    await assert.rejects(f.operations.run('project-one', 'resume'), /connection lost/);
    const prior = f.projects.get('project-one').sandboxOperation!;
    assert.equal(prior.status, 'unknown'); assert.equal(prior.errorCode, 'UNKNOWN_OUTCOME');
    assert.equal(prior.error?.includes('hidden'), false);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 1);
    await assert.rejects(f.operations.run('project-one', 'resume'), /connection lost/);
    assert.equal(calls, 2);
    assert.notEqual(f.projects.get('project-one').sandboxOperation?.id, prior.id);
  } finally { await f.close(); }
});

test('Cellbox conflict is returned without retry, fallback create or rebuild', async () => {
  let calls = 0;
  const f = await fixture({}, { async resume() { calls++; throw new CellboxError('STALE_GENERATION', 'generation changed', 409); }, async rebuild() { assert.fail('no fallback'); } });
  try {
    await assert.rejects(f.operations.run('project-one', 'resume'), error => error instanceof CellboxError && error.code === 'STALE_GENERATION');
    assert.equal(calls, 1);
    assert.equal(f.projects.get('project-one').sandboxOperation?.errorCode, 'STALE_GENERATION');
  } finally { await f.close(); }
});

test('project reads and metadata edits remain available during remote resume', async () => {
  const entered = deferred(), release = deferred();
  const f = await fixture({}, { async resume(value) { entered.resolve(); await release.promise; return { ...value.sandbox!, status: 'ready' }; } });
  try {
    const request = f.operations.run('project-one', 'resume'); await entered.promise;
    assert.equal(f.projects.get('project-one').id, 'project-one');
    await f.projects.update('project-one', { name: 'Edited while waiting' });
    release.resolve(); await request;
    assert.equal(f.projects.get('project-one').name, 'Edited while waiting');
  } finally { release.resolve(); await f.close(); }
});

test('an older completion does not overwrite a newer request record', async () => {
  const entered = deferred(), release = deferred(); let calls = 0;
  const f = await fixture({}, { async resume(value) { if (++calls === 1) { entered.resolve(); await release.promise; } return { ...value.sandbox!, status: 'ready' }; } });
  try {
    const older = f.operations.run('project-one', 'resume'); await entered.promise;
    await f.operations.run('project-one', 'resume');
    const newerId = f.projects.get('project-one').sandboxOperation!.id;
    release.resolve(); await older;
    assert.equal(f.projects.get('project-one').sandboxOperation?.id, newerId);
    assert.equal(calls, 2, 'CoCell does not deduplicate distinct user requests');
  } finally { release.resolve(); await f.close(); }
});

test('checkpoint publishes pause separately from a pending disk backup', async () => {
  const captured = deferred(), release = deferred();
  const f = await fixture();
  f.runtime.remoteArchives.capture = async () => { captured.resolve(); await release.promise; return archive; };
  try {
    const accepted = await f.operations.start('project-one', 'checkpoint');
    await accepted.done; await captured.promise;
    assert.equal(f.projects.get('project-one').sandboxOperation?.status, 'succeeded');
    assert.equal(f.projects.get('project-one').sandboxBackup?.status, 'running');
    await f.projects.update('project-one', { name: 'Still editable' });
    release.resolve(); await accepted.settled;
    assert.equal(f.projects.get('project-one').sandboxBackup?.status, 'succeeded');
  } finally { release.resolve(); await f.close(); }
});

test('a failed background backup keeps pause success and its actual error', async () => {
  const f = await fixture();
  f.runtime.remoteArchives.capture = async () => { throw new CellboxError('UNKNOWN_OUTCOME', 'archive result unknown'); };
  try {
    const accepted = await f.operations.start('project-one', 'checkpoint');
    await accepted.done; await accepted.settled;
    assert.equal(f.projects.get('project-one').sandboxOperation?.status, 'succeeded');
    assert.equal(f.projects.get('project-one').sandboxBackup?.status, 'unknown');
    assert.match(f.projects.get('project-one').sandboxBackup?.error ?? '', /archive result unknown/);
  } finally { await f.close(); }
});

test('running disk-only archive is explicitly unsupported without implicit checkpoint', async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.operations.run('project-one', 'archive'), /不支持无 Checkpoint/);
    assert.deepEqual(f.calls, []);
    assert.equal(f.projects.get('project-one').status, 'active');
  } finally { await f.close(); }
});

test('a paused archive is verified and stored before source destruction', async () => {
  const f = await fixture({ sandbox: box('paused') });
  f.runtime.deleteDanglingSandbox = async id => {
    assert.equal(f.projects.get('project-one').remoteArchives?.[0]?.id, archive.id);
    f.calls.push('delete:' + id);
  };
  try {
    await f.operations.run('project-one', 'archive');
    assert.equal(f.projects.get('project-one').status, 'archived');
    assert.equal(f.projects.get('project-one').sandbox, undefined);
    assert.equal(f.calls.filter(v => v === 'capture').length, 1);
    assert.equal(f.calls.filter(v => v === 'delete:box-old').length, 1);
  } finally { await f.close(); }
});

test('explicit use of an existing backup does not capture or checkpoint', async () => {
  const f = await fixture({ remoteArchives: [archive] });
  try {
    await f.operations.run('project-one', 'archive', { useExistingBackup: true });
    assert.equal(f.projects.get('project-one').status, 'archived');
    assert.equal(f.calls.includes('capture'), false); assert.equal(f.calls.includes('checkpoint'), false);
  } finally { await f.close(); }
});

test('cleanup failure is visible and is not automatically repeated', async () => {
  let deletes = 0;
  const f = await fixture({ sandbox: box('paused') }, { async deleteDanglingSandbox() { deletes++; throw new CellboxError('UNKNOWN_OUTCOME', 'delete outcome unknown'); } });
  try {
    await f.operations.run('project-one', 'archive');
    assert.equal(f.projects.get('project-one').status, 'archived');
    assert.equal(f.projects.get('project-one').pendingSandboxCleanup?.length, 1);
    assert.ok(f.projects.get('project-one').sandboxOperation?.cleanupError);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(deletes, 1);
  } finally { await f.close(); }
});

test('archiving a restored box does not delete purged sources from archive history', async () => {
  const f = await fixture({ sandbox: box('paused', 'box-restored'), remoteArchives: [archive],
    lifecycleHistory: [{ id: 'past-archive', action: 'archived', at: new Date(0).toISOString(), sandboxId: 'box-old' }] });
  f.runtime.remoteArchives.capture = async () => ({ ...archive, id: 'archive-restored', sourceSandboxId: 'box-restored' });
  f.runtime.remoteArchives.inspect = async value => value;
  f.runtime.deleteDanglingSandbox = async id => {
    f.calls.push('delete:' + id);
    if (id === 'box-old') throw new CellboxError('NOT_FOUND', 'Box not found', 404);
  };
  try {
    await f.operations.run('project-one', 'archive');
    const project = f.projects.get('project-one');
    assert.deepEqual(f.calls.filter(value => value.startsWith('delete:')), ['delete:box-restored']);
    assert.equal(project.sandboxOperation?.cleanupError, undefined);
    assert.equal(project.pendingSandboxCleanup?.length ?? 0, 0);
    assert.equal(project.remoteArchives?.length, 2);
  } finally { await f.close(); }
});

test('same-ID rebuild is unsupported without invoking a fallback', async () => {
  const f = await fixture({}, { async rebuildPersistent() { assert.fail('removed API'); } });
  try { await assert.rejects(f.operations.run('project-one', 'rebuild'), /不支持同 ID/); }
  finally { await f.close(); }
});

test('restore verification failure leaves both source and failed candidate visible', async () => {
  const f = await fixture({ status: 'archived', sandbox: undefined, remoteArchives: [archive] }, {
    async verifyHistory() { throw new Error('history mismatch'); },
  });
  try {
    await assert.rejects(f.operations.run('project-one', 'restore'), /history mismatch/);
    assert.equal(f.calls.some(call => call.startsWith('delete:')), false);
    assert.equal(f.projects.get('project-one').status, 'archived');
    assert.equal(f.projects.get('project-one').pendingSandboxCleanup?.[0]?.id, 'box-new');
  } finally { await f.close(); }
});


test('restoring a completed project saves its selected revision and only cleans its own old source', async () => {
  const selection: ProjectImageSelection = { imageId: 'repo', imageName: 'Runtime', category: '系统', versionId: 'new', version: '2',
    templateId: 'template-one', revisionId: 'revision-new', image: 'image-new' };
  const f = await fixture({ status: 'completed', sandbox: box('unavailable'), remoteArchives: [archive],
    pendingSandboxCleanup: [box('unknown', 'unconfirmed-candidate')],
    imageSelection: { ...selection, versionId: 'old', revisionId: 'revision-old', image: 'image-one' } }, {}, selection);
  f.runtime.remoteArchives.restore = async (_target, _archive, _requestId, candidate) => {
    const next = { ...box('starting', 'box-new'), image: { reference: 'image-new', id: 'image-new', repoDigests: [] } };
    await candidate(next); return next;
  };
  try {
    await f.operations.run('project-one', 'restore');
    const project = f.projects.get('project-one');
    assert.equal(project.status, 'completed');
    assert.equal(project.sandbox?.id, 'box-new');
    assert.equal(project.imageSelection?.revisionId, 'revision-new');
    assert.ok(f.calls.includes('delete:box-old'));
    assert.equal(f.calls.includes('delete:unconfirmed-candidate'), false);
    assert.ok(project.pendingSandboxCleanup?.some(value => value.id === 'unconfirmed-candidate'));
  } finally { await f.close(); }
});

test('late archive cleanup keeps a newer request result and newly discovered residual resources', async () => {
  const entered = deferred(), release = deferred();
  const f = await fixture({ sandbox: box('paused'), remoteArchives: [archive] }, {
    async deleteDanglingSandbox() { entered.resolve(); await release.promise; throw new CellboxError('UNKNOWN_OUTCOME', 'cleanup response lost'); },
  });
  try {
    const older = f.operations.run('project-one', 'archive', { useExistingBackup: true });
    await entered.promise;
    await f.projects.mergePendingSandboxCleanup('project-one', [box('unknown', 'late-candidate')]);
    await assert.rejects(f.operations.run('project-one', 'rebuild'), /不支持同 ID/);
    const newer = f.projects.get('project-one').sandboxOperation!;
    release.resolve(); await older;
    const current = f.projects.get('project-one');
    assert.equal(current.sandboxOperation?.id, newer.id);
    assert.equal(current.sandboxOperation?.kind, 'rebuild');
    assert.equal(current.sandboxOperation?.cleanupError, undefined);
    assert.ok(current.pendingSandboxCleanup?.some(value => value.id === 'late-candidate'));
    assert.ok(current.pendingSandboxCleanup?.some(value => value.id === 'box-old'));
  } finally { release.resolve(); await f.close(); }
});
