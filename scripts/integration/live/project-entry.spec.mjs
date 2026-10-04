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
    const start = performance.now();
    await card.getByRole('button', { name: '进入项目' }).click();
    await expect(editor).toBeEditable(); await expect(editor).toHaveValue('创建时输入的草稿');
    await editor.fill('恢复期间继续输入'); const inputReadyMs = performance.now() - start;
    await expect(send).toBeEnabled({ timeout: env.config.operationTimeout });
    await expect(editor).toHaveValue('恢复期间继续输入');
    const ready = await env.json(`/api/projects/${id}`);
    assert.equal(ready.sandbox.id, box); assert.equal(ready.sandboxOperation.kind, 'resume'); assert.equal(ready.sandboxOperation.status, 'succeeded');
    await page.reload(); await expect(editor).toHaveValue('恢复期间继续输入');
    return { inputReadyMs, readyMs: performance.now() - start, sandboxId: box };
  });
});
