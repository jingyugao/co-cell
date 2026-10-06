import assert from 'node:assert/strict';
import { test, expect } from '../support/fixtures.mjs';
import { createThroughUI, projectList } from '../ui/fixture.mjs';

test('real browser: immediate creation entry, draft retention and automatic resume', async ({ livePage: page, environment: env }) => {
  const editor = page.getByRole('textbox', { name: '任务描述', exact: true });
  const send = page.getByRole('button', { name: '发送任务', exact: true });
  let id, box;
  await env.step('Create through the deployed UI and type before waiting for readiness', async () => {
    await page.goto('/#projects');
    const start = performance.now();
    await createThroughUI(page, env.name('browser'));
    await expect(page).toHaveURL(/\/projects\/[0-9a-f-]+$/);
    id = new URL(page.url()).pathname.split('/').at(-1);
    assert(env.projects.has(id));
    await expect(editor).toBeEditable(); await editor.fill('创建时输入的草稿');
    const inputReadyMs = performance.now() - start;
    // A fast live cluster may already be ready. The UI suite holds preparation
    // pending deterministically to test disabled-send behavior without timing races.
    await expect(send).toBeEnabled({ timeout: env.config.operationTimeout });
    await expect(editor).toHaveValue('创建时输入的草稿');
    const ready = await env.json(`/api/projects/${id}`); box = ready.sandbox.id;
    return { projectId: id, inputReadyMs, readyMs: performance.now() - start };
  });
  await env.step('Checkpoint, enter its card, automatically resume and keep input', async () => {
    await projectList(page);
    await env.json(`/api/projects/${id}/sandbox/checkpoint`, { method: 'POST', expectedStatus: 202 });
    await env.waitProject(id, { kind: 'checkpoint', status: 'paused' });
    await page.reload();
    const card = page.getByRole('article', { name: env.name('browser'), exact: true });
    const waitRequests = [];
    const observeWait = request => {
      const url = new URL(request.url());
      if (request.method() === 'GET' && url.pathname === `/api/projects/${id}` && url.searchParams.has('waitForOperation')) {
        waitRequests.push({ operationId: url.searchParams.get('waitForOperation'), waitMs: Number(url.searchParams.get('waitMs')) });
      }
    };
    page.on('request', observeWait);
    const projectResponse = async response => {
      const path = new URL(response.url()).pathname;
      if (!response.ok() || ![`/api/projects/${id}`, `/api/projects/${id}/open`, '/api/projects'].includes(path)) return;
      const body = await response.json();
      return Array.isArray(body) ? body.find(project => project.id === id) : body;
    };
    const openedResponse = page.waitForResponse(response => response.request().method() === 'POST'
      && new URL(response.url()).pathname === `/api/projects/${id}/open`);
    // Scheduled backup can replace the latest operation immediately after resume.
    // Observe the actual resume result before checking the current project view.
    const completedResponse = page.waitForResponse(async response => {
      const project = await projectResponse(response);
      return project?.id === id && project.sandboxOperation?.kind === 'resume'
        && project.sandboxOperation.status === 'succeeded';
    }, { timeout: env.config.operationTimeout });
    const start = performance.now();
    await card.getByRole('button', { name: '进入项目' }).click();
    await expect(editor).toBeEditable(); await expect(editor).toHaveValue('创建时输入的草稿');
    await editor.fill('恢复期间继续输入'); const inputReadyMs = performance.now() - start;
    await expect(send).toBeEnabled({ timeout: env.config.operationTimeout });
    await expect(editor).toHaveValue('恢复期间继续输入');
    const opened = await projectResponse(await openedResponse);
    const resumed = await projectResponse(await completedResponse);
    assert.equal(opened.sandboxOperation.kind, 'resume');
    assert.equal(resumed.sandboxOperation.id, opened.sandboxOperation.id);
    assert.equal(resumed.sandbox.id, box); assert.equal(resumed.sandbox.status, 'ready');
    if (opened.sandboxOperation.status === 'running') {
      assert(waitRequests.some(request => request.operationId === opened.sandboxOperation.id
        && request.waitMs > 0 && request.waitMs <= 10_000), 'Pending resume must wait for its exact operation');
    }
    page.off('request', observeWait);
    const ready = await env.json(`/api/projects/${id}`);
    assert.equal(ready.sandbox.id, box); assert.equal(ready.sandbox.status, 'ready');
    await page.reload(); await expect(editor).toHaveValue('恢复期间继续输入');
    return { inputReadyMs, readyMs: performance.now() - start, sandboxId: box, operationId: resumed.sandboxOperation.id, waitRequests };
  });
});
