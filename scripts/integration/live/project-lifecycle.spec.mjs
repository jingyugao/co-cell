import assert from 'node:assert/strict';
import { test } from '../support/fixtures.mjs';

test('real projects: read-only entry, explicit resume, checkpoint and independent concurrent resumes', async ({ environment: env }) => {
  const projects = [];
  await env.step('Create two ready projects and enter their existing sandboxes', async () => {
    for (let i = 0; i < 2; i++) {
      const created = await env.createProject(`concurrency-${i}`);
      assert.equal(created.sandboxOperation.kind, 'create');
      assert.equal(created.sandboxOperation.status, 'succeeded');
      assert.equal(created.sandbox.status, 'ready');
      const opened = await env.json(`/api/projects/${created.id}/open`, { method: 'POST', expectedStatus: 200, timeoutMs: env.config.operationTimeout });
      assert.equal(opened.sandboxOperation.id, created.sandboxOperation.id, 'Read-only entry must not submit a lifecycle operation');
      assert.equal(opened.sandbox.id, created.sandbox.id, 'Entry must keep the sandbox prepared by creation');
      projects.push(opened);
    }
    return projects.map(project => ({ projectId: project.id, sandboxId: project.sandbox.id }));
  });
  await env.step('Checkpoint both projects; reads and rejected task submissions must not resume them', async () => {
    await Promise.all(projects.map(async (project, index) => {
      await env.request(`/api/projects/${project.id}/backup`, { method: 'POST', expectedStatus: 409 });
      const checkpointResponse = await env.json(`/api/projects/${project.id}/sandbox/checkpoint`, { method: 'POST', expectedStatus: 200, timeoutMs: env.config.operationTimeout });
      assert.equal(checkpointResponse.sandboxOperation.status, 'succeeded');
      assert.equal(checkpointResponse.sandbox.status, 'paused');
      const checkpointed = await env.waitProject(project.id, { kind: 'checkpoint', status: 'paused', waitForBackup: true });
      const archive = checkpointed.remoteArchives?.[0];
      assert(archive && archive.sizeBytes > 0 && /^[a-f0-9]{64}$/.test(archive.sha256), 'Checkpoint did not publish a verified archive reference');
      assert.equal(archive.sourceSandboxId, project.sandbox.id);
      assert(Array.isArray(archive.threadIds));
      project.checkpointArchiveId = archive.id;
      projects[index] = checkpointed;
      // An empty conversation is metadata and may be created while paused.
      // Executing a turn is the readiness boundary.
      const session = await env.json('/api/sessions', { method: 'POST', expectedStatus: 201, body: { projectId: project.id } });
      assert.equal(session.threadId, null);
      await env.request(`/api/sessions/${session.id}/turns`, { method: 'POST', expectedStatus: 409,
        body: { prompt: 'Integration readiness guard: this request must be rejected.', images: [] } });
      for (let i = 0; i < 3; i++) assert.equal((await env.json(`/api/projects/${project.id}`)).sandbox.status, 'paused');
    }));
  });
  await env.step('Concurrent read-only entries preserve paused state and do not submit resume', async () => {
    const project = projects[0];
    const entries = await Promise.all([0, 1].map(() => env.json(`/api/projects/${project.id}/open`, {
      method: 'POST', expectedStatus: 200,
    })));
    for (const entry of entries) {
      assert.equal(entry.sandboxOperation.id, project.sandboxOperation.id);
      assert.equal(entry.sandbox.status, 'paused', 'Opening a paused project must leave its sandbox paused');
      assert.equal(entry.sandbox.id, project.sandbox.id);
    }
    const name = `${env.name('concurrency-0')} renamed`;
    await env.json(`/api/projects/${project.id}`, { method: 'PATCH', body: { name } });
    const readyToResume = await env.json(`/api/projects/${project.id}`);
    assert.equal(readyToResume.name, name);
    assert.equal(readyToResume.sandbox.status, 'paused');
    const resumed = await env.json(`/api/projects/${project.id}/sandbox/resume`, { method: 'POST', expectedStatus: 200, timeoutMs: env.config.operationTimeout });
    assert.equal(resumed.sandboxOperation.kind, 'resume');
    assert.equal(resumed.sandboxOperation.status, 'succeeded');
    assert.equal(resumed.sandbox.id, project.sandbox.id);
    const ready = await env.waitProject(project.id, { kind: 'resume', status: 'ready', operationId: resumed.sandboxOperation.id });
    assert.equal(ready.name, name, 'Resume completion must preserve an unrelated metadata edit');
    const checkpointed = await env.json(`/api/projects/${project.id}/sandbox/checkpoint`, { method: 'POST', expectedStatus: 200, timeoutMs: env.config.operationTimeout });
    assert.equal(checkpointed.sandboxOperation.status, 'succeeded');
    assert.equal(checkpointed.sandbox.status, 'paused');
    const archived = await env.waitProject(project.id, { kind: 'checkpoint', status: 'paused', waitForBackup: true });
    assert.notEqual(archived.remoteArchives?.[0]?.id, project.checkpointArchiveId, 'A later Checkpoint must publish a new archive reference');
    assert.equal(archived.remoteArchives?.[0]?.sourceSandboxId, project.sandbox.id);
    return { operationId: ready.sandboxOperation.id, sandboxId: ready.sandbox.id };
  });
  await env.step('Explicit resume of two paused projects completes both independent restores', async () => {
    return Promise.all(projects.map(async project => {
      const start = performance.now();
      const resumed = await env.json(`/api/projects/${project.id}/sandbox/resume`, { method: 'POST', expectedStatus: 200, timeoutMs: env.config.operationTimeout });
      assert.equal(resumed.sandboxOperation.kind, 'resume');
      assert.equal(resumed.sandboxOperation.status, 'succeeded');
      assert.equal(resumed.sandbox.status, 'ready');
      const ready = await env.waitProject(project.id, { kind: 'resume', status: 'ready', operationId: resumed.sandboxOperation.id });
      assert.equal(ready.sandbox.id, project.sandbox.id);
      return { projectId: project.id, durationMs: performance.now() - start, operationId: ready.sandboxOperation.id };
    }));
  });
  await env.step('Restored App Servers can complete another checkpoint', async () => {
    for (const project of projects) {
      const checkpointed = await env.json(`/api/projects/${project.id}/sandbox/checkpoint`, { method: 'POST', expectedStatus: 200, timeoutMs: env.config.operationTimeout });
      assert.equal(checkpointed.sandboxOperation.status, 'succeeded');
      assert.equal(checkpointed.sandbox.status, 'paused');
    }
  });
});
