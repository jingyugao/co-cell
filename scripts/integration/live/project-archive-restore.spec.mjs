import assert from 'node:assert/strict';
import { test } from '../support/fixtures.mjs';
import { testWorkspaceWriter } from '../support/kubernetes.mjs';

test('real archive restores files into a new sandbox and can be archived again', async ({ environment: env }) => {
  const project = await env.createProject('archive-restore');
  const sourceId = project.sandbox.id;
  const sourceVolumeId = project.sandboxMounts?.[0]?.volumeId;
  const filename = 'archive-restore-marker.txt';
  const marker = `archive-restore-${env.runId}`;
  const write = await testWorkspaceWriter(env, project.id);
  await write(filename, marker);
  await env.json(`/api/projects/${project.id}/sandbox/checkpoint`, { method: 'POST', timeoutMs: env.config.operationTimeout });
  const backedUp = await env.json(`/api/projects/${project.id}/backup`, { method: 'POST', timeoutMs: env.config.operationTimeout });
  assert.equal(backedUp.sandboxOperation.kind, 'backup');
  assert.equal(backedUp.sandboxOperation.status, 'succeeded');
  assert.equal(backedUp.sandboxBackup.status, 'succeeded');
  const snapshot = backedUp.remoteArchives?.[0];
  assert(snapshot, 'Backup did not publish a Cellbox Volume snapshot');
  assert.equal(snapshot.storageType, 'cellbox-volume');
  assert(snapshot.volumeId);
  assert.match(snapshot.snapshotId, /^[a-f0-9]{64}$/);
  assert.equal(snapshot.sha256, undefined);
  assert.equal(snapshot.imageId, undefined);
  const browsing = await env.request(`/api/archives/${encodeURIComponent(snapshot.id)}/files`, { expectedStatus: 422 });
  assert.equal(browsing.response.status, 422, 'Cellbox Volume snapshots must not use the legacy file browser');
  const archived = await env.json(`/api/projects/${project.id}/archive`, {
    method: 'POST', body: { useExistingBackup: true }, timeoutMs: env.config.operationTimeout,
  });
  assert.equal(archived.status, 'archived');
  assert(!archived.sandbox);
  const restored = await env.json(`/api/projects/${project.id}/sandbox/restore`, {
    method: 'POST', body: {}, timeoutMs: env.config.operationTimeout,
  });
  assert.equal(restored.sandboxOperation.status, 'succeeded');
  assert.equal(restored.sandbox.status, 'ready');
  assert.notEqual(restored.sandbox.id, sourceId);
  assert.notEqual(restored.sandboxMounts?.[0]?.volumeId, snapshot.volumeId, 'Native restore must create a new Volume');
  if (sourceVolumeId) assert.equal(snapshot.volumeId, sourceVolumeId, 'Snapshot must belong to the source Volume');
  const file = await env.request(`/api/projects/${project.id}/files/content?path=${encodeURIComponent(`/home/agent/workspace/${filename}`)}`);
  assert.equal(file.buffer.toString(), marker);
  // Fixture cleanup DELETEs this test-owned project, retaining the recovery index and S3 snapshots.
});
