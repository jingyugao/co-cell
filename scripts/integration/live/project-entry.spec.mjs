import assert from 'node:assert/strict';
import { test, expect } from '../support/fixtures.mjs';
import { createThroughUI, projectList } from '../ui/fixture.mjs';

test('real browser: read-only project entry, explicit resume, and draft retention', async ({ livePage: page, environment: env }) => {
  const editor = page.getByRole('textbox', { name: '任务描述', exact: true });
  const send = page.getByRole('button', { name: '发送任务', exact: true });
  let id, box;
  const lifecycleWrites = [];
  const projectReads = [];
  page.on('response', response => {
    if (response.request().method() === 'GET' && /^\/api\/projects\/[0-9a-f-]+$/.test(new URL(response.url()).pathname)) projectReads.push(response);
  });
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (request.method() === 'POST' && /\/(open|sandbox\/resume)$/.test(path)) lifecycleWrites.push(path);
  });
  await env.step('Create a ready project and enter it with a read-only request', async () => {
    await page.goto('/#projects');
    const start = performance.now();
    const creationResponse = page.waitForResponse(response => response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/api/projects', { timeout: env.config.operationTimeout });
    await createThroughUI(page, env.name('browser'));
    const createdResponse = await creationResponse;
    assert.equal(createdResponse.status(), 201);
    const created = await createdResponse.json();
    assert.equal(created.sandboxOperation.status, 'succeeded');
    assert.equal(created.sandbox.status, 'ready');
    await expect(page).toHaveURL(/\/projects\/[0-9a-f-]+$/);
    id = new URL(page.url()).pathname.split('/').at(-1);
    assert(env.projects.has(id));
    await expect.poll(() => projectReads.some(response => new URL(response.url()).pathname === `/api/projects/${id}`), { timeout: env.config.operationTimeout }).toBe(true);
    const entry = projectReads.find(response => new URL(response.url()).pathname === `/api/projects/${id}`);
    assert.equal(entry.status(), 200);
    const entered = await entry.json();
    assert.equal(entered.sandboxOperation.id, created.sandboxOperation.id);
    assert.equal(entered.sandbox.status, 'ready');
    box = entered.sandbox.id;
    await expect(editor).toBeEditable(); await editor.fill('创建时输入的草稿');
    await expect(send).toBeEnabled({ timeout: env.config.operationTimeout });
    await expect(editor).toHaveValue('创建时输入的草稿');
    assert.deepEqual(lifecycleWrites, [], 'Entering a ready project must not submit resume');
    return { projectId: id, sandboxId: box, entryMs: performance.now() - start };
  });
  await env.step('Reopen the checkpointed project without resume, then resume only after an explicit click', async () => {
    await projectList(page);
    const checkpointed = await env.json(`/api/projects/${id}/sandbox/checkpoint`, { method: 'POST', expectedStatus: 200, timeoutMs: env.config.operationTimeout });
    assert.equal(checkpointed.sandboxOperation.status, 'succeeded');
    assert.equal(checkpointed.sandbox.status, 'paused');
    assert.equal(checkpointed.sandboxBackup, undefined, 'Checkpoint must not launch disk backup');

    await page.reload();
    const card = page.getByRole('article', { name: env.name('browser'), exact: true });
    const entry = page.waitForResponse(response => response.request().method() === 'GET'
      && new URL(response.url()).pathname === `/api/projects/${id}`, { timeout: env.config.operationTimeout });
    await card.getByRole('button', { name: '进入项目' }).click();
    const paused = await entry;
    assert.equal(paused.status(), 200);
    const observed = await paused.json();
    assert.equal(observed.sandbox.status, 'paused');
    assert.equal(observed.sandboxOperation.kind, 'checkpoint');
    await expect(editor).toBeEditable(); await expect(editor).toHaveValue('创建时输入的草稿');
    await expect(send).toBeDisabled();
    assert.deepEqual(lifecycleWrites, [], 'Viewing a paused project must not resume it');

    await projectList(page);
    const resumeResponse = page.waitForResponse(response => response.request().method() === 'POST'
      && new URL(response.url()).pathname === `/api/projects/${id}/sandbox/resume`, { timeout: env.config.operationTimeout });
    const start = performance.now();
    await page.getByRole('article', { name: env.name('browser'), exact: true }).getByRole('button', { name: '恢复运行', exact: true }).click();
    const resumedResponse = await resumeResponse;
    assert.equal(resumedResponse.status(), 200);
    const resumed = await resumedResponse.json();
    assert.equal(resumed.sandboxOperation.kind, 'resume');
    assert.equal(resumed.sandboxOperation.status, 'succeeded');
    assert.equal(resumed.sandbox.id, box); assert.equal(resumed.sandbox.status, 'ready');
    await env.waitProject(id, { kind: 'resume', status: 'ready', operationId: resumed.sandboxOperation.id });

    const reentry = page.waitForResponse(response => response.request().method() === 'GET'
      && new URL(response.url()).pathname === `/api/projects/${id}`, { timeout: env.config.operationTimeout });
    await page.getByRole('article', { name: env.name('browser'), exact: true }).getByRole('button', { name: '进入项目' }).click();
    assert.equal((await reentry).status(), 200);
    await expect(editor).toHaveValue('创建时输入的草稿');
    await expect(send).toBeEnabled({ timeout: env.config.operationTimeout });
    assert.deepEqual(lifecycleWrites, [`/api/projects/${id}/sandbox/resume`]);
    return { projectId: id, sandboxId: box, operationId: resumed.sandboxOperation.id, readyMs: performance.now() - start };
  });
});
