import assert from 'node:assert/strict';
import test from 'node:test';
import { SandboxLifecycle } from '@co-cell/sandbox';
import type { CellboxSandboxProvider, CellboxOperation, CellboxVolumeBackup } from '../../packages/sandbox/src/providers/cellbox/index.js';
import type { CellboxVolumeBackupRef, RemoteArchiveRef } from '../../protocol/remote-archive-types.js';
import type { SandboxState } from '../../protocol/sandbox-types.js';
import { BackupCatalogUnavailable, createCellboxVolumeBackups } from './cellbox-volume-backups.js';
import type { WorkspaceTarget } from './types.js';

const backupId = 'a'.repeat(64);
const volumeBackup = (volumeId: string, id = backupId, extra: Partial<CellboxVolumeBackup> = {}): CellboxVolumeBackup => ({
  id, createdAt: '2026-10-18T00:00:00.000Z', volumeId, ownerKey: 'project:project-a', profileId: 'profile-a', ...extra,
});
const operation = (id: string, kind: string, targetId: string, result?: Record<string, string>): CellboxOperation => ({
  id, kind, targetId, status: 'succeeded', version: 1, createdAt: '2026-10-18T00:00:00.000Z', ...(result ? { result } : {}),
});
const target = (overrides: Partial<WorkspaceTarget> = {}): WorkspaceTarget => ({
  id: 'project-a', projectId: 'project-a', settings: { workingDirectory: '/workspace/project-a' },
  updatedAt: '2026-10-18T00:00:00.000Z', ...overrides,
});
const mount = (volumeId: string, mountPath = '/workspace'): { volumeId: string; mountPath: string } => ({ volumeId, mountPath });

function fakeProvider(overrides: Record<string, unknown> = {}) {
  const calls: Array<{ name: string; input?: unknown }> = [];
  const client = {
    getBackupPolicy: async () => ({ enabled: true, engine: 'restic', scope: 'volume', keepLast: 3 }),
    createVolumeBackup: async (volumeId: string) => { calls.push({ name: 'createVolumeBackup', input: volumeId }); return operation('backup-op', 'volume-backup', volumeId); },
    listVolumeBackups: async (volumeId: string) => { calls.push({ name: 'listVolumeBackups', input: volumeId }); return []; },
    getVolumeBackup: async (volumeId: string, snapshotId: string) => { calls.push({ name: 'getVolumeBackup', input: { volumeId, snapshotId } }); return volumeBackup(volumeId, snapshotId); },
    restoreVolume: async (input: unknown) => { calls.push({ name: 'restoreVolume', input }); return operation('restore-op', 'volume-restore', 'restored-volume'); },
    createBox: async (input: unknown) => { calls.push({ name: 'createBox', input }); return operation('box-op', 'create', 'restored-box'); },
    getBox: async (id: string) => { calls.push({ name: 'getBox', input: id }); return { image: 'image:stable', imageId: 'sha256:stable', phase: 'staged', mounts: [mount('restored-volume')], homeVolumeId: 'restored-volume' }; },
    deleteVolume: async (id: string) => { calls.push({ name: 'deleteVolume', input: id }); return operation('delete-op', 'volume-delete', id); },
    ...overrides,
  };
  const provider = {
    client,
    defaultSelector: { templateId: 'template-a' },
    waitForOperation: async (op: CellboxOperation) => { calls.push({ name: 'waitForOperation', input: op.id }); return op; },
  } as unknown as CellboxSandboxProvider;
  return { provider, calls };
}

test('capture backs up retained mounts without a Sandbox and returns only native snapshot metadata', async () => {
  const { provider, calls } = fakeProvider();
  provider.client.createVolumeBackup = async volumeId => { calls.push({ name: 'createVolumeBackup', input: volumeId }); return operation('backup-op', 'volume-backup', volumeId, { backupId }); };
  // The helper intentionally accepts retained mounts independently of Sandbox existence.
  const backup = createCellboxVolumeBackups(provider, 'profile-a', new SandboxLifecycle([]));
  let operationRecorded = false;
  const captured = await backup.capture(target({ sandboxMounts: [mount('volume-a', '/workspace/project-a')] }), 'request-a', {
    onOperation: async (id, volumeId) => { assert.equal(id, 'backup-op'); assert.equal(volumeId, 'volume-a'); operationRecorded = true; },
  });

  assert.equal(operationRecorded, true);
  assert.deepEqual(calls.map(call => call.name), ['createVolumeBackup', 'waitForOperation', 'getVolumeBackup']);
  assert.deepEqual(calls[0].input, 'volume-a');
  assert.deepEqual(calls[2].input, { volumeId: 'volume-a', snapshotId: backupId });
  assert.deepEqual(captured, {
    storageType: 'cellbox-volume', id: `volume:volume-a:${backupId}`, volumeId: 'volume-a', snapshotId: backupId,
    ownerKey: 'project:project-a', profileId: 'profile-a', mounts: [mount('volume-a', '/workspace/project-a')],
    createdAt: '2026-10-18T00:00:00.000Z',
  });
  assert.equal('sizeBytes' in captured, false, 'unknown size stays absent instead of becoming zero');
  assert.equal('addedBytes' in captured, false);
  assert.equal('sourceSandboxId' in captured, false);
  assert.equal('imageId' in captured, false);
  assert.equal('sha256' in captured, false);
  assert.equal('verified' in captured, false);
});

test('capture rejects multiple retained volumes before submitting any backup', async () => {
  const { provider, calls } = fakeProvider();
  const backup = createCellboxVolumeBackups(provider, 'profile-a', new SandboxLifecycle([]));
  await assert.rejects(backup.capture(target({ sandboxMounts: [mount('volume-a'), mount('volume-b', '/data')] }), 'request-a'),
    error => (error as { status?: number }).status === 422 && /尚未提交备份/.test((error as Error).message));
  assert.deepEqual(calls, []);
});

test('capture preserves a successful snapshot when Cellbox retention reports an error', async () => {
  const { provider } = fakeProvider();
  provider.client.createVolumeBackup = async volumeId => operation('backup-op', 'volume-backup', volumeId,
    { backupId, retentionError: 'failed to prune old snapshot' });
  const backup = createCellboxVolumeBackups(provider, 'profile-a', new SandboxLifecycle([]));
  const captured = await backup.capture(target({ sandboxMounts: [mount('volume-a')] }), 'request-a');
  assert.equal(captured.id, `volume:volume-a:${backupId}`);
  assert.equal((captured as CellboxVolumeBackupRef).retentionError, 'failed to prune old snapshot');
});

test('catalog read failure after backup is surfaced with native identity and never resubmits', async () => {
  const { provider, calls } = fakeProvider();
  provider.client.createVolumeBackup = async volumeId => { calls.push({ name: 'createVolumeBackup', input: volumeId }); return operation('backup-op', 'volume-backup', volumeId, { backupId }); };
  provider.client.getVolumeBackup = async () => { calls.push({ name: 'getVolumeBackup' }); throw new Error('catalog temporarily unavailable'); };
  const backup = createCellboxVolumeBackups(provider, 'profile-a', new SandboxLifecycle([]));
  await assert.rejects(backup.capture(target({ sandboxMounts: [mount('volume-a')] }), 'request-a'), error => {
    assert(error instanceof BackupCatalogUnavailable);
    assert.equal(error.volumeId, 'volume-a');
    assert.equal(error.snapshotId, backupId);
    assert.equal(error.code, 'BACKUP_CATALOG_UNAVAILABLE');
    return true;
  });
  assert.equal(calls.filter(call => call.name === 'createVolumeBackup').length, 1);
});

test('list trusts the native catalog and joins saved capture-time threads by volume and snapshot', async () => {
  const sameSnapshot = 'b'.repeat(64);
  const saved: CellboxVolumeBackupRef[] = [
    { storageType: 'cellbox-volume', id: `volume:volume-a:${sameSnapshot}`, volumeId: 'volume-a', snapshotId: sameSnapshot,
      ownerKey: 'project:project-a', profileId: 'profile-a', mounts: [mount('volume-a')], createdAt: '2026-10-17T00:00:00.000Z', threadIds: ['thread-a'] },
    { storageType: 'cellbox-volume', id: `volume:volume-b:${sameSnapshot}`, volumeId: 'volume-b', snapshotId: sameSnapshot,
      ownerKey: 'project:project-a', profileId: 'profile-a', mounts: [mount('volume-b')], createdAt: '2026-10-17T00:00:00.000Z', threadIds: ['thread-b'] },
    { storageType: 'cellbox-volume', id: `volume:volume-a:${'c'.repeat(64)}`, volumeId: 'volume-a', snapshotId: 'c'.repeat(64),
      ownerKey: 'project:project-a', profileId: 'profile-a', mounts: [mount('volume-a')], createdAt: '2026-10-16T00:00:00.000Z', threadIds: ['pruned-thread'] },
  ];
  const { provider, calls } = fakeProvider();
  provider.client.listVolumeBackups = async volumeId => {
    calls.push({ name: 'listVolumeBackups', input: volumeId });
    return [volumeBackup(volumeId, sameSnapshot), volumeBackup(volumeId, 'd'.repeat(64))];
  };
  const backup = createCellboxVolumeBackups(provider, 'profile-a', new SandboxLifecycle([]));
  const listed = await backup.list(target({ sandboxMounts: [mount('volume-a')] }), saved);
  const native = listed.filter((ref): ref is CellboxVolumeBackupRef => ref.storageType === 'cellbox-volume');

  assert.deepEqual(new Set(calls.filter(call => call.name === 'listVolumeBackups').map(call => call.input)), new Set(['volume-a', 'volume-b']));
  assert.equal(native.length, 4, 'the pruned saved reference is absent because Cellbox no longer lists it');
  assert.deepEqual(native.find(ref => ref.volumeId === 'volume-a' && ref.snapshotId === sameSnapshot)?.threadIds, ['thread-a']);
  assert.deepEqual(native.find(ref => ref.volumeId === 'volume-b' && ref.snapshotId === sameSnapshot)?.threadIds, ['thread-b']);
  assert.deepEqual(native.find(ref => ref.volumeId === 'volume-a' && ref.snapshotId === 'd'.repeat(64))?.threadIds, []);
  assert.deepEqual(native.find(ref => ref.volumeId === 'volume-b' && ref.snapshotId === 'd'.repeat(64))?.threadIds, []);
});

test('restore records new volume before waiting, mounts its copy, and never mutates source on Box failure', async () => {
  const sourceMount = mount('source-volume', '/workspace/project-a');
  const ref: CellboxVolumeBackupRef = { storageType: 'cellbox-volume', id: `volume:source-volume:${backupId}`,
    volumeId: 'source-volume', snapshotId: backupId, ownerKey: 'project:project-a', profileId: 'profile-a',
    mounts: [sourceMount], createdAt: '2026-10-18T00:00:00.000Z', threadIds: ['thread-at-capture'] };
  const { provider, calls } = fakeProvider();
  provider.client.restoreVolume = async input => { calls.push({ name: 'restoreVolume', input }); return operation('restore-op', 'volume-restore', 'restored-volume'); };
  provider.client.createBox = async input => { calls.push({ name: 'createBox', input }); throw new Error('staged Box creation failed'); };
  const backup = createCellboxVolumeBackups(provider, 'profile-a', new SandboxLifecycle([]));
  const events: string[] = [];
  provider.waitForOperation = async op => { calls.push({ name: 'waitForOperation', input: op.id }); events.push(`wait:${op.id}`); return op; };
  const onCandidate = async (_candidate: SandboxState) => { events.push('candidate'); };
  const onOperation = async (id: string) => { events.push(`operation:${id}`); };
  const onVolume = async (value: { volumeId: string; ownerKey: string; mounts: typeof sourceMount[] }) => {
    events.push('volume');
    assert.deepEqual(value, { volumeId: 'restored-volume', ownerKey: 'project:project-a', mounts: [mount('restored-volume', '/workspace/project-a')] });
  };
  await assert.rejects(backup.restore(target(), ref, 'request-a', onCandidate, { onOperation, onVolume }), /staged Box creation failed/);

  assert.deepEqual(events, ['operation:restore-op', 'volume', 'wait:restore-op']);
  assert.deepEqual(calls.map(call => call.name), ['restoreVolume', 'waitForOperation', 'createBox']);
  assert.deepEqual(calls[0].input, { sourceVolumeId: 'source-volume', backupId, ownerKey: 'project:project-a' });
  assert.equal(calls[1].input, 'restore-op', 'Cellbox restore finishes only after the volume ID is durably reported');
  const create = calls[2].input as Record<string, unknown>;
  assert.deepEqual(create, { templateId: 'template-a', ownerKey: 'project:project-a',
    mounts: [mount('restored-volume', '/workspace/project-a')], staged: true });
  assert.equal(ref.volumeId, 'source-volume');
  assert.equal(ref.mounts[0].volumeId, 'source-volume', 'the stored source reference remains immutable');
  assert.equal(calls.filter(call => call.name === 'restoreVolume').length, 1);
  assert.equal(calls.some(call => call.name === 'deleteVolume'), false, 'Box failure does not delete the restored disk');
});

test('successful restore publishes its Sandbox identity to lifecycle post hooks', async () => {
  const { provider } = fakeProvider();
  const observed: Array<string | undefined> = [];
  const lifecycle = new SandboxLifecycle([{ name: 'runtime-config', async post(context) { observed.push(context.sandboxId); } }]);
  const backups = createCellboxVolumeBackups(provider, 'profile-a', lifecycle);
  const ref: CellboxVolumeBackupRef = { storageType: 'cellbox-volume', id: `volume:source-volume:${backupId}`,
    volumeId: 'source-volume', snapshotId: backupId, ownerKey: 'project:project-a', profileId: 'profile-a',
    mounts: [mount('source-volume')], createdAt: '2026-10-18T00:00:00.000Z', threadIds: [] };
  const restored = await backups.restore(target(), ref, 'request', async () => {});
  assert.equal(restored.id, 'restored-box');
  assert.deepEqual(observed, ['restored-box']);
});
