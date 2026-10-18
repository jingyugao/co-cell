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
import { BackupCatalogUnavailable } from '../sandboxes/cellbox-volume-backups.js';

const workspace = '/home/agent/workspace';
const box = (status: SandboxState['status'] = 'ready', id = 'box-old'): SandboxState => ({ id, status, template: 'test', workingDirectory: workspace });
const archive: RemoteArchiveRef = { id: 'archive-one', sourceSandboxId: 'box-old', imageId: 'image-one', createdAt: new Date(0).toISOString(), sizeBytes: 10, sha256: 'a'.repeat(64), threadIds: ['thread-one'], portable: true };
const volumeArchive: RemoteArchiveRef = { storageType: 'cellbox-volume', id: `volume:volume-one:${'b'.repeat(64)}`,
  volumeId: 'volume-one', snapshotId: 'b'.repeat(64), ownerKey: 'project:project-one', profileId: 'profile-one',
  mounts: [{ volumeId: 'volume-one', mountPath: `${workspace}/project-one` }], createdAt: '2026-10-18T00:00:00.000Z',
  sizeBytes: 4096, addedBytes: 512, threadIds: ['thread-one'] };
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
async function fixture(overrides: Partial<Project> = {}, changes: Partial<SandboxRuntime> = {}, selection?: ProjectImageSelection) {
  const store = new MemoryWebStateStore();
  const project: Project = { id: 'project-one', name: 'One', type: 1, status: 'active', requirementUrl: null,
    executionMode: 'sandbox', workingDirectory: workspace, sandbox: box(), createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(), ...overrides };
  await store.saveProject(project);
  const projects = new ProjectService(store); await projects.init();
  const calls: string[] = [];
  const threadIds = ['thread-one'];
  const logs: Record<string, unknown>[] = [];
  let observed: SandboxState['status'] = overrides.sandbox?.status ?? 'ready';
  const runtime = {
    async close() {}, async *run() {}, async *recover() {}, detach() {},
    async file() { throw new Error('unused'); }, async history() { throw new Error('unused'); },
    async delete() {}, async rebuild() {},
    async querySandbox(value) { return { ...value, status: observed }; },
    async resume() { calls.push('resume'); observed = 'ready'; },
    async checkpoint() { calls.push('checkpoint'); observed = 'paused'; },
    async verifySandbox() { calls.push('verify'); }, async verifyHistory() { calls.push('history'); },
    async fenceSandbox(value) { calls.push('fence:' + value.id); }, async detachSandbox() { calls.push('detach'); },
    async deleteDanglingSandbox(id) { calls.push('delete:' + id); },
    remoteArchives: {
      async capture() { calls.push('capture'); return archive; },
      async inspect() { calls.push('inspect-archive'); return archive; },
      async restore(_target, _archive, _requestId, candidate) { const next = box('starting', 'box-new'); await candidate(next); return next; },
      async activate() { calls.push('activate'); },
      async download() {},
    },
    ...changes,
  } satisfies SandboxRuntime;
  const operations = new ProjectSandboxOperations({ projects, runtime, logger: { async write(record) { logs.push(record); } }, threadIds: () => [...threadIds],
    ...(selection ? { selectRestoreImage: async () => ({ selection, release() {} }) } : {}),
    async saveSandbox(id, value, restore, image, expectedId) {
      if (!await projects.updateSandbox(id, value, restore, image, expectedId)) throw new Error('Project binding changed');
    }, detached: async () => { calls.push('detached'); } });
  return { store, projects, operations, calls, runtime, logs, threadIds, async close() { await operations.close(); await projects.close(); await store.close(); } };
}

test('backup records threads known before submission rather than threads created while waiting', async () => {
  const captured = deferred(), release = deferred();
  const f = await fixture({ sandbox: undefined, sandboxMounts: volumeArchive.mounts });
  f.runtime.remoteArchives.capture = async () => { captured.resolve(); await release.promise; return volumeArchive; };
  try {
    const request = f.operations.run('project-one', 'backup');
    await captured.promise;
    f.threadIds.push('thread-after-capture');
    release.resolve(); await request;
    assert.deepEqual(f.projects.get('project-one').remoteArchives?.[0].threadIds, ['thread-one']);
  } finally { release.resolve(); await f.close(); }
});

test('an explicit resume submits once and reports its runtime result', async () => {
  const f = await fixture({ sandbox: box('paused') });
  try {
    await f.operations.run('project-one', 'resume');
    assert.deepEqual(f.calls, ['resume']);
    assert.equal(f.projects.get('project-one').sandboxOperation?.status, 'succeeded');
    assert.equal(f.projects.get('project-one').sandboxOperation?.result, undefined);
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
  const f = await fixture({}, { async resume() { entered.resolve(); await release.promise; } });
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
  const f = await fixture({}, { async resume() { if (++calls === 1) { entered.resolve(); await release.promise; } } });
  try {
    const older = f.operations.run('project-one', 'resume'); await entered.promise;
    await f.operations.run('project-one', 'resume');
    const newerId = f.projects.get('project-one').sandboxOperation!.id;
    release.resolve(); await older;
    assert.equal(f.projects.get('project-one').sandboxOperation?.id, newerId);
    assert.equal(calls, 2, 'CoCell does not deduplicate distinct user requests');
  } finally { release.resolve(); await f.close(); }
});

test('checkpoint only pauses and permits the first explicit resume without capturing disk', async () => {
  const f = await fixture();
  try {
    await f.operations.run('project-one', 'checkpoint');
    assert.equal((await f.runtime.querySandbox(f.projects.get('project-one').sandbox!)).status, 'paused');
    assert.equal(f.projects.get('project-one').sandboxOperation?.status, 'succeeded');
    assert.equal(f.projects.get('project-one').sandboxBackup, undefined);
    assert.equal(f.calls.includes('capture'), false);
    await f.operations.run('project-one', 'resume');
    assert.equal(f.calls.filter(call => call === 'resume').length, 1);
    assert.equal((await f.runtime.querySandbox(f.projects.get('project-one').sandbox!)).status, 'ready');
  } finally { await f.close(); }
});

test('explicit backup supports retained mounts with no Sandbox and stores native optional measurements', async () => {
  const captured = deferred(), release = deferred();
  const f = await fixture({ sandbox: undefined, sandboxMounts: volumeArchive.storageType === 'cellbox-volume' ? volumeArchive.mounts : [] });
  f.runtime.remoteArchives.capture = async (_target, _key, options) => {
    f.calls.push('capture');
    await options?.onOperation?.('cellbox-op-backup', 'volume-one');
    captured.resolve(); await release.promise; return volumeArchive;
  };
  try {
    const accepted = await f.operations.start('project-one', 'backup');
    await captured.promise;
    assert.equal(f.projects.get('project-one').sandboxBackup?.status, 'running');
    assert.equal(f.projects.get('project-one').sandboxBackup?.remoteOperationId, 'cellbox-op-backup');
    assert.equal(f.projects.get('project-one').sandboxBackup?.volumeId, 'volume-one');
    await f.projects.update('project-one', { name: 'Still editable' });
    release.resolve(); await accepted.done;
    const project = f.projects.get('project-one');
    assert.equal(project.sandboxOperation?.kind, 'backup');
    assert.equal(project.sandboxOperation?.status, 'succeeded');
    assert.equal(project.sandboxBackup?.status, 'succeeded');
    assert.equal(project.sandboxBackup?.id, project.sandboxOperation?.id);
    assert.equal(project.sandboxBackup?.snapshotId, volumeArchive.storageType === 'cellbox-volume' ? volumeArchive.snapshotId : undefined);
    assert.equal(project.sandboxBackup?.sizeBytes, 4096);
    assert.equal(project.sandboxBackup?.addedBytes, 512);
    assert.equal(project.remoteArchives?.[0].id, volumeArchive.id);
    assert.equal(project.sandbox, undefined);
    assert.deepEqual(f.calls, ['capture']);
  } finally { release.resolve(); await f.close(); }
});

for (const code of ['BUSY', 'UNKNOWN_OUTCOME'] as const) test(`backup ${code} comes from capture, is visible, and is never retried`, async () => {
  const f = await fixture({ sandbox: undefined, sandboxMounts: volumeArchive.storageType === 'cellbox-volume' ? volumeArchive.mounts : [] });
  let captures = 0;
  f.runtime.remoteArchives.capture = async (_target, _key, options) => {
    captures++;
    await options?.onOperation?.('cellbox-op-backup', 'volume-one');
    throw new CellboxError(code, `capture returned ${code}`);
  };
  try {
    await assert.rejects(f.operations.run('project-one', 'backup'), error => error instanceof CellboxError && error.code === code);
    const project = f.projects.get('project-one');
    assert.equal(project.sandboxOperation?.status, code === 'UNKNOWN_OUTCOME' ? 'unknown' : 'failed');
    assert.equal(project.sandboxBackup?.status, code === 'UNKNOWN_OUTCOME' ? 'unknown' : 'failed');
    assert.equal(project.sandboxOperation?.remoteOperationId, 'cellbox-op-backup');
    assert.equal(project.sandboxBackup?.remoteOperationId, 'cellbox-op-backup');
    assert.match(project.sandboxBackup?.error ?? '', new RegExp(`capture returned ${code}`));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(captures, 1);
  } finally { await f.close(); }
});

test('native retention warning keeps the successful backup successful', async () => {
  const f = await fixture({ sandbox: undefined, sandboxMounts: volumeArchive.storageType === 'cellbox-volume' ? volumeArchive.mounts : [] });
  f.runtime.remoteArchives.capture = async () => ({ ...volumeArchive, retentionError: 'retention pruning failed' });
  try {
    await f.operations.run('project-one', 'backup');
    const project = f.projects.get('project-one');
    assert.equal(project.sandboxOperation?.status, 'succeeded');
    assert.equal(project.sandboxBackup?.status, 'succeeded');
    assert.equal(project.sandboxBackup?.retentionError, 'retention pruning failed');
    assert.equal(project.remoteArchives?.[0].id, volumeArchive.id);
    assert.equal('retentionError' in (project.remoteArchives?.[0] ?? {}), false, 'operation warning is not stored in the native archive pointer');
  } finally { await f.close(); }
});

test('catalog failure records the native snapshot identity as successful data and does not clean it up', async () => {
  const f = await fixture({ sandbox: undefined, sandboxMounts: volumeArchive.storageType === 'cellbox-volume' ? volumeArchive.mounts : [] });
  f.runtime.remoteArchives.capture = async (_target, _key, options) => {
    await options?.onOperation?.('cellbox-op-backup', 'volume-one');
    throw new BackupCatalogUnavailable('volume-one', 'c'.repeat(64), new Error('catalog read failed'));
  };
  f.runtime.remoteArchives.removeVolume = async id => { f.calls.push(`delete-volume:${id}`); };
  try {
    await assert.rejects(f.operations.run('project-one', 'backup'), BackupCatalogUnavailable);
    const project = f.projects.get('project-one');
    assert.equal(project.sandboxOperation?.status, 'failed');
    assert.equal(project.sandboxOperation?.volumeId, 'volume-one');
    assert.equal(project.sandboxOperation?.snapshotId, 'c'.repeat(64));
    assert.equal(project.sandboxBackup?.status, 'succeeded');
    assert.equal(project.sandboxBackup?.volumeId, 'volume-one');
    assert.equal(project.sandboxBackup?.snapshotId, 'c'.repeat(64));
    assert.match(project.sandboxBackup?.catalogError ?? '', /暂时无法读取备份详情/);
    assert.deepEqual(f.calls, []);
    assert.equal(project.sandboxMounts?.[0]?.volumeId, 'volume-one');
  } finally { await f.close(); }
});

test('a concurrent BUSY resume does not turn a completed backup into a metadata conflict', async () => {
  const captured = deferred(), release = deferred();
  const f = await fixture({ sandbox: box('paused') }, {
    async resume() { throw new CellboxError('BUSY', 'Box has an active operation', 409); },
  });
  f.runtime.remoteArchives.capture = async () => { f.calls.push('capture'); captured.resolve(); await release.promise; return archive; };
  try {
    const request = f.operations.run('project-one', 'backup');
    await captured.promise;
    await assert.rejects(f.operations.run('project-one', 'resume'), error => error instanceof CellboxError && error.code === 'BUSY');
    const resumeId = f.projects.get('project-one').sandboxOperation!.id;
    release.resolve(); await request;
    const project = f.projects.get('project-one');
    assert.equal(project.sandboxOperation?.id, resumeId);
    assert.equal(project.sandboxOperation?.errorCode, 'BUSY');
    assert.equal(project.sandboxBackup?.status, 'succeeded');
    assert.equal(project.remoteArchives?.[0].id, archive.id);
    assert.deepEqual(f.calls, ['capture']);
    const finished = f.logs.filter(record => record.event === 'sandbox.operation_phase' && record.status !== 'running');
    assert.deepEqual(finished.map(record => [record.operation, record.status]), [['resume', 'failed'], ['backup', 'succeeded']]);
    assert.equal(new Set(finished.map(record => record.operationId)).size, 2);
  } finally { release.resolve(); await f.close(); }
});

test('checkpoint delegates even when local state is paused and status/App Server checks would fail', async () => {
  let submissions = 0;
  const f = await fixture({ status: 'archived', sandbox: box('paused') }, {
    async querySandbox() { assert.fail('no preflight state query'); },
    async verifySandbox() { assert.fail('no App Server preflight'); },
    async checkpoint() { submissions++; throw new CellboxError('CONFLICT', 'Only a running box can suspend', 409); },
  });
  try {
    await assert.rejects(f.operations.run('project-one', 'checkpoint'), error => error instanceof CellboxError && error.code === 'CONFLICT');
    assert.equal(submissions, 1);
    assert.equal(f.projects.get('project-one').sandboxOperation?.errorCode, 'CONFLICT');
  } finally { await f.close(); }
});

test('backup delegates live Sandbox consistency to Cellbox without local status preflight', async () => {
  const f = await fixture({ sandbox: { ...box('ready'), phase: 'running' }, sandboxMounts: volumeArchive.storageType === 'cellbox-volume' ? volumeArchive.mounts : [] });
  try {
    f.runtime.querySandbox = async () => { assert.fail('backup must not preflight Sandbox state'); };
    f.runtime.remoteArchives.capture = async () => { f.calls.push('capture'); return volumeArchive; };
    await f.operations.run('project-one', 'backup');
    assert.equal(f.projects.get('project-one').sandboxBackup?.status, 'succeeded');
    assert.deepEqual(f.calls, ['capture']);
  } finally { await f.close(); }
});

test('archive captures a native volume without checkpointing or relying on Sandbox survival', async () => {
  const f = await fixture({ sandbox: box('ready'), sandboxMounts: volumeArchive.storageType === 'cellbox-volume' ? volumeArchive.mounts : [] });
  f.runtime.remoteArchives.capture = async () => { f.calls.push('capture'); return volumeArchive; };
  try {
    await f.operations.run('project-one', 'archive');
    assert.equal(f.projects.get('project-one').status, 'archived');
    assert.equal(f.projects.get('project-one').remoteArchives?.[0].id, volumeArchive.id);
    assert.equal(f.calls.includes('checkpoint'), false);
    assert.equal(f.calls.filter(call => call === 'capture').length, 1);
  } finally { await f.close(); }
});

test('delete releases the Box, records a native backup, then deletes the retained volume', async () => {
  const retainedMount = { volumeId: 'volume-one', mountPath: `${workspace}/project-one` };
  const f = await fixture({ sandbox: { ...box('ready'), mounts: [retainedMount] }, sandboxMounts: [retainedMount] });
  f.runtime.release = async () => { f.calls.push('release'); return { ...box('paused'), mounts: [retainedMount] }; };
  f.runtime.remoteArchives.capture = async (_target, _key, options) => {
    f.calls.push('capture'); await options?.onOperation?.('backup-op', 'volume-one'); return volumeArchive;
  };
  f.runtime.remoteArchives.removeVolume = async id => {
    assert.equal(id, 'volume-one');
    const project = f.projects.get('project-one');
    assert.equal(project.remoteArchives?.[0].id, volumeArchive.id, 'the native snapshot is committed before volume deletion');
    assert.ok(project.pendingVolumeCleanup?.includes(id));
    f.calls.push('delete-volume');
  };
  try {
    await f.operations.run('project-one', 'delete');
    assert.deepEqual(f.calls.filter(call => ['release', 'capture', 'delete-volume'].includes(call)), ['release', 'capture', 'delete-volume']);
    const project = f.projects.get('project-one');
    assert.equal(project.status, 'archived');
    assert.equal(project.sandbox, undefined);
    assert.equal(project.pendingVolumeCleanup?.includes('volume-one'), false);
    assert.ok(project.sandboxArtifactsCleanedAt);
  } finally { await f.close(); }
});

for (const code of ['BUSY', 'UNKNOWN_OUTCOME'] as const) test(`delete stops after ${code} backup result and preserves the volume`, async () => {
  const retainedMount = { volumeId: 'volume-one', mountPath: `${workspace}/project-one` };
  const f = await fixture({ sandbox: { ...box('ready'), mounts: [retainedMount] }, sandboxMounts: [retainedMount] });
  f.runtime.release = async () => { f.calls.push('release'); return { ...box('paused'), mounts: [retainedMount] }; };
  f.runtime.remoteArchives.capture = async () => { f.calls.push('capture'); throw new CellboxError(code, `backup ${code}`); };
  f.runtime.remoteArchives.removeVolume = async () => { f.calls.push('delete-volume'); };
  try {
    await assert.rejects(f.operations.run('project-one', 'delete'), error => error instanceof CellboxError && error.code === code);
    assert.deepEqual(f.calls, ['release', 'capture']);
    const project = f.projects.get('project-one');
    assert.equal(project.sandbox, undefined, 'release completed before the backup was attempted');
    assert.equal(project.sandboxMounts?.[0]?.volumeId, 'volume-one');
    assert.notEqual(project.status, 'archived');
    assert.equal(project.pendingVolumeCleanup?.includes('volume-one') ?? false, false);
  } finally { await f.close(); }
});

test('delete does not re-delete a restored Box already confirmed by release', async () => {
  const retainedMount = { volumeId: 'volume-one', mountPath: `${workspace}/project-one` };
  const restoredBox = { ...box('ready', 'restored-box'), mounts: [retainedMount] };
  const f = await fixture({ sandbox: restoredBox, sandboxMounts: [retainedMount], pendingSandboxCleanup: [box('unknown', 'restored-box')] });
  f.runtime.release = async () => { f.calls.push('release'); return { ...restoredBox, status: 'paused' }; };
  f.runtime.remoteArchives.capture = async (_target, _key, options) => {
    f.calls.push('capture'); await options?.onOperation?.('backup-op', 'volume-one'); return volumeArchive;
  };
  f.runtime.remoteArchives.removeVolume = async () => { f.calls.push('delete-volume'); };
  try {
    await f.operations.run('project-one', 'delete');
    assert.equal(f.calls.filter(call => call === 'release').length, 1);
    assert.equal(f.calls.filter(call => call === 'capture').length, 1);
    assert.equal(f.calls.filter(call => call === 'delete-volume').length, 1);
    assert.equal(f.calls.includes('delete:restored-box'), false, 'release already confirmed the Box is gone');
  } finally { await f.close(); }
});

test('archive prunes an absent Box journal before cleanup and still deletes the backed-up volume', async () => {
  const retainedMount = { volumeId: 'volume-one', mountPath: `${workspace}/project-one` };
  const f = await fixture({ sandbox: undefined, sandboxMounts: [retainedMount], remoteArchives: [volumeArchive],
    pendingSandboxCleanup: [box('unknown', 'already-gone-box')] }, {
    async listProjectSandboxes() { f.calls.push('list-boxes'); return []; },
  });
  f.runtime.remoteArchives.removeVolume = async id => { assert.equal(id, 'volume-one'); f.calls.push('delete-volume'); };
  try {
    await f.operations.run('project-one', 'archive', { useExistingBackup: true });
    const project = f.projects.get('project-one');
    assert.deepEqual(f.calls, ['list-boxes', 'delete-volume', 'detached']);
    assert.equal(project.pendingSandboxCleanup?.length ?? 0, 0);
    assert.equal(project.pendingVolumeCleanup?.includes('volume-one'), false);
    assert.ok(project.sandboxArtifactsCleanedAt);
    assert.equal(project.remoteArchives?.[0].id, volumeArchive.id);
  } finally { await f.close(); }
});

test('archive does not delete a backed-up volume when Box inventory cannot be read', async () => {
  const retainedMount = { volumeId: 'volume-one', mountPath: `${workspace}/project-one` };
  const f = await fixture({ sandbox: undefined, sandboxMounts: [retainedMount], remoteArchives: [volumeArchive],
    pendingSandboxCleanup: [box('unknown', 'possibly-existing-box')] }, {
    async listProjectSandboxes() { f.calls.push('list-boxes'); throw new Error('Cellbox inventory unavailable'); },
  });
  f.runtime.remoteArchives.removeVolume = async () => { f.calls.push('delete-volume'); };
  try {
    await f.operations.run('project-one', 'archive', { useExistingBackup: true });
    const project = f.projects.get('project-one');
    assert.deepEqual(f.calls, ['list-boxes']);
    assert.ok(project.sandboxOperation?.cleanupError);
    assert.deepEqual(project.pendingVolumeCleanup, ['volume-one']);
    assert.equal(project.sandboxArtifactsCleanedAt, undefined);
    assert.equal(project.remoteArchives?.[0].id, volumeArchive.id);
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

test('volume restore failure keeps the new volume cleanup identity after Box creation fails', async () => {
  const f = await fixture({ status: 'archived', sandbox: undefined, remoteArchives: [volumeArchive] });
  f.runtime.remoteArchives.restore = async (_target, _reference, _requestId, _candidate, options) => {
    await options?.onOperation?.('restore-op');
    await options?.onVolume?.({ volumeId: 'restored-volume', ownerKey: 'project:project-one',
      mounts: [{ volumeId: 'restored-volume', mountPath: `${workspace}/project-one` }] });
    throw new Error('staged Box creation failed');
  };
  f.runtime.remoteArchives.removeVolume = async id => { f.calls.push(`delete-volume:${id}`); };
  try {
    await assert.rejects(f.operations.run('project-one', 'restore'), /staged Box creation failed/);
    const project = f.projects.get('project-one');
    assert.equal(project.sandboxOperation?.status, 'failed');
    assert.equal(project.sandboxOperation?.remoteOperationId, 'restore-op');
    assert.equal(project.sandboxOperation?.candidateVolumeId, 'restored-volume');
    assert.deepEqual(project.pendingVolumeCleanup, ['restored-volume']);
    assert.equal(project.status, 'archived');
    assert.deepEqual(f.calls, [], 'failed staged restore does not automatically delete the disk');
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
