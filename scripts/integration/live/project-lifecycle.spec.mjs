import assert from 'node:assert/strict';
import { test } from '../support/fixtures.mjs';

test('real projects: create, read-only pause, idempotent entry and two concurrent resumes', async ({ environment: env }) => {
  const projects = [];
  await env.step('Create two isolated projects and join their preparation', async () => {
    for (let i = 0; i < 2; i++) {
      const created = await env.createProject(`concurrency-${i}`);
      assert.equal(created.sandboxOperation.kind, 'create');
      const opened = await env.json(`/api/projects/${created.id}/open`, { method: 'POST', expectedStatus: 202 });
      assert.equal(opened.sandboxOperation.id, created.sandboxOperation.id);
      projects.push(await env.waitProject(created.id, { kind: 'create', status: 'ready', operationId: created.sandboxOperation.id }));
    }
    return projects.map(project => ({ projectId: project.id, sandboxId: project.sandbox.id }));
  });
  await env.step('Checkpoint both projects; reads and rejected task submissions must not resume them', async () => {
    await Promise.all(projects.map(async project => {
      await env.json(`/api/projects/${project.id}/sandbox/checkpoint`, { method: 'POST', expectedStatus: 202 });
      await env.waitProject(project.id, { kind: 'checkpoint', status: 'paused' });
      // An empty conversation is metadata and may be created while paused.
      // Executing a turn is the readiness boundary.
      const session = await env.json('/api/sessions', { method: 'POST', expectedStatus: 201, body: { projectId: project.id } });
      assert.equal(session.threadId, null);
      await env.request(`/api/sessions/${session.id}/turns`, { method: 'POST', expectedStatus: 409,
        body: { prompt: 'Integration readiness guard: this request must be rejected.', images: [] } });
      for (let i = 0; i < 3; i++) assert.equal((await env.json(`/api/projects/${project.id}`)).sandbox.status, 'paused');
    }));
  });
  await env.step('Two entries into the same project share one operation and keep the sandbox ID', async () => {
    const project = projects[0];
    const entries = await Promise.all([0, 1].map(() => env.json(`/api/projects/${project.id}/open`, { method: 'POST', expectedStatus: 202 })));
    assert.equal(entries[0].sandboxOperation.kind, 'resume'); assert.equal(entries[0].sandboxOperation.id, entries[1].sandboxOperation.id);
    const ready = await env.waitProject(project.id, { kind: 'resume', status: 'ready', operationId: entries[0].sandboxOperation.id });
    assert.equal(ready.sandbox.id, project.sandbox.id);
    const reopened = await env.json(`/api/projects/${project.id}/open`, { method: 'POST', expectedStatus: 202 });
    assert.equal(reopened.sandboxOperation.id, ready.sandboxOperation.id);
    await env.json(`/api/projects/${project.id}/sandbox/checkpoint`, { method: 'POST', expectedStatus: 202 });
    await env.waitProject(project.id, { kind: 'checkpoint', status: 'paused' });
    return { operationId: ready.sandboxOperation.id, sandboxId: ready.sandbox.id };
  });
  await env.step('Simultaneous entry into two paused projects completes both restores', async () => {
    return Promise.all(projects.map(async project => {
      const start = performance.now();
      const opened = await env.json(`/api/projects/${project.id}/open`, { method: 'POST', expectedStatus: 202 });
      const ready = await env.waitProject(project.id, { kind: 'resume', status: 'ready', operationId: opened.sandboxOperation.id });
      assert.equal(ready.sandbox.id, project.sandbox.id);
      return { projectId: project.id, durationMs: performance.now() - start, operationId: ready.sandboxOperation.id };
    }));
  });
  await env.step('Restored App Servers can complete another checkpoint', async () => {
    for (const project of projects) {
      await env.json(`/api/projects/${project.id}/sandbox/checkpoint`, { method: 'POST', expectedStatus: 202 });
      await env.waitProject(project.id, { kind: 'checkpoint', status: 'paused' });
    }
  });
});
