import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { test, expect } from '../support/fixtures.mjs';
import { createThroughUI } from '../ui/fixture.mjs';
import { fileURL, finish, waitCommandStart } from '../support/agent.mjs';

test('core: real browser creates a project, sends commands and reloads an active conversation', async ({ livePage: page, environment: env }) => {
  const marker = randomUUID(), filename = `browser-${marker}.txt`;
  const submitted = [], streams = [];
  const nativeTurns = new EventEmitter();
  const nativeCommandStarts = [];
  const nativeCommandEvents = new EventEmitter();
  page.on('websocket', socket => {
    const sessionId = /^\/api\/sessions\/([^/]+)\/app-server$/.exec(new URL(socket.url()).pathname)?.[1];
    if (!sessionId) return;
    streams.push({ transport: 'WebSocket', url: socket.url() });
    socket.on('framesent', frame => {
      const message = JSON.parse(String(frame.payload));
      if (message.method === 'turn/start') submitted.push(socket.url());
    });
    socket.on('framereceived', frame => {
      const message = JSON.parse(String(frame.payload));
      if (message.method === 'turn/started' && message.params?.turn?.id)
        nativeTurns.emit('started', { sessionId, turnId: message.params.turn.id });
      if (message.method === 'item/started' && message.params?.item?.type === 'commandExecution') {
        const event = { sessionId, turnId: message.params.turnId, item: message.params.item };
        nativeCommandStarts.push(event);
        nativeCommandEvents.emit('started', event);
      }
    });
  });
  page.on('request', request => {
    if (request.method() === 'POST' && /\/api\/sessions\/[^/]+\/turns$/.test(new URL(request.url()).pathname)) submitted.push(request.url());
  });
  page.on('response', response => {
    if (response.status() === 200 && new URL(response.url()).pathname.endsWith('/events')) streams.push({ transport: 'SSE', url: response.url() });
  });
  await page.goto('/#projects');
  await createThroughUI(page, env.name('browser-agent'));
  await expect(page).toHaveURL(/\/projects\/[0-9a-f-]+$/);
  const projectId = new URL(page.url()).pathname.split('/').at(-1);
  assert(env.projects.has(projectId));
  const ready = await env.waitProject(projectId, { kind: 'create', status: 'ready' });
  const editor = page.getByRole('textbox', { name: '任务描述', exact: true });
  const send = page.getByRole('button', { name: '发送任务', exact: true });
  const appConfig = await env.json('/api/config');
  const native = appConfig.capabilities.nativeWebSocket === true;
  const waitNativeCommandStart = (sessionId, turnId) => {
    const find = () => nativeCommandStarts.find(event => event.sessionId === sessionId
      && event.turnId === turnId && event.item.command?.includes(marker));
    const existing = find();
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        nativeCommandEvents.off('started', onStarted);
        reject(new Error(`Timed out waiting for native commandExecution start for turn ${turnId}`));
      }, env.config.operationTimeout);
      const onStarted = () => {
        const event = find();
        if (!event) return;
        clearTimeout(timeout);
        nativeCommandEvents.off('started', onStarted);
        resolve(event);
      };
      nativeCommandEvents.on('started', onStarted);
    });
  };
  const nextAcceptedTurn = () => native
    ? once(nativeTurns, 'started', { signal: AbortSignal.timeout(env.config.operationTimeout) }).then(([turn]) => turn)
    : page.waitForResponse(response => response.status() === 202 && response.request().method() === 'POST'
      && /\/api\/sessions\/[^/]+\/turns$/.test(new URL(response.url()).pathname)).then(async response => ({
      sessionId: new URL(response.url()).pathname.split('/')[3], turnId: (await response.json()).turnId,
    }));
  const modelOptions = appConfig.modelOptions;
  assert(Array.isArray(modelOptions), 'API config did not provide managed model options');
  const candidates = modelOptions.filter(option => option.model === env.config.model);
  const configuredDefault = candidates.find(option => option.id === appConfig.defaults?.modelEntryId);
  const selectedModel = configuredDefault ?? (candidates.length === 1 ? candidates[0] : undefined);
  assert(selectedModel, candidates.length
    ? `Model ${env.config.model} is ambiguous across channels; configure it as the default model or provide a unique option`
    : `Model ${env.config.model} is not available in API model options`);
  await page.getByRole('combobox', { name: '切换模型', exact: true }).selectOption(selectedModel.id);
  await editor.fill(`This is a real browser integration test. Do not use subagents, credentials or external systems. Run a foreground Node command that writes ${filename} with started-${marker}, prints started-${marker}, then waits 25 seconds and replaces its content with completed-${marker}. Use exec_command yield_time_ms=1000 and poll the same command until completion. Reply exactly completed-${marker}. Do not detach the command.`);
  await expect(send).toBeEnabled({ timeout: env.config.operationTimeout });
  const accepted = nextAcceptedTurn();
  await send.click();
  const { sessionId, turnId } = await accepted;
  const session = await env.json(`/api/sessions/${sessionId}`);
  await env.step('Reload after the agent command starts; preserve the active native turn', async () => {
    if (native) await waitNativeCommandStart(sessionId, turnId);
    else await waitCommandStart(env, session, marker);
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
    const connections = streams.filter(stream => stream.transport === (native ? 'WebSocket' : 'SSE')).length;
    assert(connections >= 2, `Reload did not open a new real ${native ? 'WebSocket' : 'SSE'} connection`);
    return { sessionId, threadId: result.session.threadId, streams: connections, submissions: submitted.length };
  });
  await env.step('Send another task through the browser and persist its result across reload', async () => {
    const previous = await env.json(`/api/sessions/${sessionId}`);
    await editor.fill(`Use Node to replace ${filename} with followup-${marker}. Do not use other tools or external systems. Reply exactly followup-${marker}.`);
    await expect(send).toBeEnabled();
    const accepted = nextAcceptedTurn();
    await send.click();
    const { sessionId: continuedSessionId, turnId } = await accepted;
    assert.equal(continuedSessionId, sessionId);
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
