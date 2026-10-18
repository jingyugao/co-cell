import assert from 'node:assert/strict';
import { test } from '../support/fixtures.mjs';
import { testOwnedVolumeCleaner, testWorkspaceWriter } from '../support/kubernetes.mjs';

function workspaceHasPersistentVolume(box) {
  if (box.homeVolumeId) return true;
  const workspace = '/home/agent/workspace';
  return (box.mounts ?? []).some(({ mountPath }) => mountPath === workspace
    || workspace.startsWith(`${mountPath.replace(/\/$/, '')}/`));
}

test('release a Box and recreate it with the same independent workspace volume', async ({ environment: env }) => {
  const project = await env.createProject('volume-release');
  const originalBox = project.sandbox;
  const deleteVolumes = await testOwnedVolumeCleaner(env, project.id);
  test.skip(!deleteVolumes.supportsVolumes,
    'Cellbox does not expose GET /v1/volumes; this installation predates independent volume support.');
  assert(workspaceHasPersistentVolume(originalBox),
    'Cellbox supports independent volumes but the created Box did not report its HOME/workspace volume attachment');

  const volumeIds = [...new Set([originalBox.homeVolumeId, ...(originalBox.mounts ?? []).map(mount => mount.volumeId)]
    .filter(Boolean))];
  assert(volumeIds.length, 'Persistent workspace capability must identify at least one Cellbox volume');
  env.report.volumeCleanup ??= [];
  for (const volumeId of volumeIds) env.report.volumeCleanup.push({ projectId: project.id, volumeId, status: 'attached' });
  await env.persist();
  const filename = 'volume-release-marker.txt';
  const marker = `volume-release-${env.runId}`;
  const write = await testWorkspaceWriter(env, project.id);
  let activeBoxId = originalBox.id;
  const releaseAttempts = new Set();
  const releaseActiveBoxOnce = async () => {
    if (!activeBoxId || releaseAttempts.has(activeBoxId)) return;
    const id = activeBoxId;
    releaseAttempts.add(id);
    const released = await env.json(`/api/projects/${project.id}/sandbox/release`, {
      method: 'POST', expectedStatus: 200, timeoutMs: env.config.operationTimeout,
    });
    activeBoxId = undefined;
    return released;
  };
  try {
    return await env.step('Write a marker, release the Box, recreate it on the same volume, and verify the file', async () => {
      await write(filename, marker);

      const released = await releaseActiveBoxOnce();
      assert.equal(released.sandbox, undefined, 'Release must drop the current Box binding');
      assert.deepEqual(released.sandboxMounts, project.sandboxMounts,
        'Release must retain the independent volume attachment on the project');

      const created = await env.json(`/api/projects/${project.id}/sandbox/create`, {
        method: 'POST', expectedStatus: 200, timeoutMs: env.config.operationTimeout,
      });
      assert.equal(created.sandboxOperation.kind, 'create');
      assert.equal(created.sandboxOperation.status, 'succeeded');
      assert(created.sandbox, 'Create must bind a replacement Box');
      activeBoxId = created.sandbox.id;
      assert.notEqual(created.sandbox.id, originalBox.id, 'Release/create must use a new Box identity');
      assert.deepEqual(created.sandboxMounts, project.sandboxMounts,
        'Create must retain the same project volume attachment');
      assert(workspaceHasPersistentVolume(created.sandbox), 'Replacement Box must report a persistent workspace volume');

      const file = await env.request(`/api/projects/${project.id}/files/content?path=${encodeURIComponent(`/home/agent/workspace/${filename}`)}`);
      assert.equal(file.buffer.toString(), marker, 'Workspace file must survive Box release and recreation');
      return { projectId: project.id, oldBoxId: originalBox.id, newBoxId: created.sandbox.id,
        homeVolumeId: created.sandbox.homeVolumeId, mounts: created.sandbox.mounts };
    });
  } finally {
    await releaseActiveBoxOnce();
    const remaining = await env.json(`/api/projects/${project.id}`);
    assert.equal(remaining.sandbox, undefined, 'Do not delete volumes until all test Box bindings are released');
    await deleteVolumes(volumeIds);
  }
});
