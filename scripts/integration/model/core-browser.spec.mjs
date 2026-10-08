import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test, expect } from '../support/fixtures.mjs';
import { createThroughUI } from '../ui/fixture.mjs';
import { fileURL, finish, waitCommandStart } from '../support/agent.mjs';

test('core: real browser creates a project, sends commands and reloads an active conversation', async ({ livePage: page, environment: env }) => {
  const marker = randomUUID(), filename = `browser-${marker}.txt`;
  const submitted = [], streams = [];
  page.on('request', request => {
    if (request.method() === 'POST' && /\/api\/sessions\/[^/]+\/turns$/.test(new URL(request.url()).pathname)) submitted.push(request.url());
  });
  page.on('response', response => {
    if (response.status() === 200 && new URL(response.url()).pathname.endsWith('/events')) streams.push(response.url());
  });
  await page.goto('/#projects');
  await createThroughUI(page, env.name('browser-agent'));
  await expect(page).toHaveURL(/\/projects\/[0-9a-f-]+$/);
  const projectId = new URL(page.url()).pathname.split('/').at(-1);
  assert(env.projects.has(projectId));
  const ready = await env.waitProject(projectId, { kind: 'create', status: 'ready' });
  const editor = page.getByRole('textbox', { name: '任务描述', exact: true });
  const send = page.getByRole('button', { name: '发送任务', exact: true });
  await page.getByRole('combobox', { name: '切换模型', exact: true }).selectOption(env.config.model);
  await editor.fill(`This is a real browser integration test. Do not use subagents, credentials or external systems. Run a foreground Node command that writes ${filename} with started-${marker}, prints started-${marker}, then waits 25 seconds and replaces its content with completed-${marker}. Use exec_command yield_time_ms=1000 and poll the same command until completion. Reply exactly completed-${marker}. Do not detach the command.`);
  await expect(send).toBeEnabled({ timeout: env.config.operationTimeout });
  const accepted = page.waitForResponse(response => response.status() === 202 && response.request().method() === 'POST'
    && /\/api\/sessions\/[^/]+\/turns$/.test(new URL(response.url()).pathname));
  await send.click();
  const response = await accepted;
  const sessionId = new URL(response.url()).pathname.split('/')[3];
  const { turnId } = await response.json();
  const session = await env.json(`/api/sessions/${sessionId}`);
  await env.step('Reload after the agent command starts; preserve the active native turn', async () => {
    await waitCommandStart(env, session, `started-${marker}`);
    const running = await env.json(`/api/sessions/${sessionId}`);
    assert.equal(running.turns.find(turn => turn.id === turnId || turn.nativeTurnId === turnId)?.status, 'running');
    await page.reload();
    await expect(page.getByRole('button', { name: '停止任务', exact: true })).toBeVisible();
    const result = await finish(env, session, turnId);
    assert(result.turn.items.some(item => item.type === 'command_execution'));
    assert.equal(result.session.turns.filter(turn => turn.prompt.includes(filename)).length, 1);
    assert.equal(submitted.length, 1, 'Browser reload submitted the task again');
    await expect(page.locator('.agent-message').filter({ hasText: `completed-${marker}` }).first()).toBeVisible();
    assert.equal((await env.json(fileURL(ready, filename))).trim(), `completed-${marker}`);
    assert(streams.length >= 2, 'Reload did not open a new real SSE connection');
    return { sessionId, threadId: result.session.threadId, streams: streams.length, submissions: submitted.length };
  });
  await env.step('Send another task through the browser and persist its result across reload', async () => {
    const previous = await env.json(`/api/sessions/${sessionId}`);
    await editor.fill(`Use Node to replace ${filename} with followup-${marker}. Do not use other tools or external systems. Reply exactly followup-${marker}.`);
    await expect(send).toBeEnabled();
    const accepted = page.waitForResponse(response => response.status() === 202 && new URL(response.url()).pathname === `/api/sessions/${sessionId}/turns`);
    await send.click();
    const { turnId } = await (await accepted).json();
    const result = await finish(env, session, turnId);
    assert.equal(result.session.threadId, previous.threadId);
    assert.equal((await env.json(fileURL(ready, filename))).trim(), `followup-${marker}`);
    await page.reload();
    await expect(page.locator('.agent-message').filter({ hasText: `followup-${marker}` }).first()).toBeVisible();
    await expect(page.locator('.error-banner')).toHaveCount(0);
    assert.equal(submitted.length, 2);
    return { sessionId, threadId: result.session.threadId, submissions: submitted.length };
  });
});
