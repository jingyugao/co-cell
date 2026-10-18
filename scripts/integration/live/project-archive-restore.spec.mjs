import assert from 'node:assert/strict';
import { test } from '../support/fixtures.mjs';
import { testWorkspaceWriter } from '../support/kubernetes.mjs';

test('real archive restores files into a new sandbox and can be archived again', async ({ environment: env }) => {
  const project = await env.createProject('archive-restore');
  const sourceId = project.sandbox.id;
  const filename = 'archive-restore-marker.txt';
  const marker = `archive-restore-${env.runId}`;
  const write = await testWorkspaceWriter(env, project.id);
  await write(filename, marker);
  await env.json(`/api/projects/${project.id}/sandbox/checkpoint`, { method: 'POST', timeoutMs: env.config.operationTimeout });
  await env.waitProject(project.id, { kind: 'checkpoint', status: 'paused', waitForBackup: true });
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
  const file = await env.request(`/api/projects/${project.id}/files/content?path=${encodeURIComponent(`/home/agent/workspace/${filename}`)}`);
  assert.equal(file.buffer.toString(), marker);
  // Fixture cleanup checkpoints, archives, and deletes the restored project.
  // Its older archive source has already been purged and must not be deleted again.
});
