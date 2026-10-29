import assert from 'node:assert/strict';
import { test, expect } from '../support/fixtures.mjs';
import { createThroughUI, projectList } from '../ui/fixture.mjs';

function parseSseEvents(text) {
  const events = [];
  let event = 'message';
  let data = [];
  const dispatch = () => {
    if (data.length) events.push({ event, data: JSON.parse(data.join('\n')) });
    event = 'message';
    data = [];
  };
  for (const rawLine of text.split(/\r?\n/)) {
    if (!rawLine) { dispatch(); continue; }
    if (rawLine.startsWith(':')) continue;
    const separator = rawLine.indexOf(':');
    const field = separator < 0 ? rawLine : rawLine.slice(0, separator);
    const value = separator < 0 ? '' : rawLine.slice(separator + 1).replace(/^ /, '');
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  }
  dispatch();
  return events;
}

function compareProjectCreation(a, b) {
  const aDate = Date.parse(a.createdAt), bDate = Date.parse(b.createdAt);
  const aCreatedAt = Number.isFinite(aDate) ? aDate : Number.NEGATIVE_INFINITY;
  const bCreatedAt = Number.isFinite(bDate) ? bDate : Number.NEGATIVE_INFINITY;
  if (aCreatedAt !== bCreatedAt) return aCreatedAt > bCreatedAt ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

async function activeProjectCardIds(page) {
  return page.locator('section[aria-label="使用中项目列表"] > article').evaluateAll(cards => cards.map(card =>
    card.querySelector('[aria-label^="复制项目完整 ID "]')?.getAttribute('aria-label')?.slice('复制项目完整 ID '.length)));
}

test('real browser: read-only project entry, explicit resume, and draft retention', async ({ livePage: page, environment: env }) => {
  await page.addInitScript(() => {
    window.__resumeSseTestCapture = [];
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (...args) => {
      const request = args[0];
      const init = args[1] ?? {};
      const url = new URL(typeof request === 'string' || request instanceof URL ? request : request.url, location.href);
      const method = (init.method ?? request.method ?? 'GET').toUpperCase();
      const response = await originalFetch(...args);
      if (method === 'POST' && /\/api\/projects\/[^/]+\/sandbox\/resume$/.test(url.pathname)) {
        const capture = { url: url.pathname, status: response.status, contentType: response.headers.get('content-type'), body: null, error: null };
        window.__resumeSseTestCapture.push(capture);
        response.clone().text().then(body => { capture.body = body; }, error => { capture.error = String(error); });
      }
      return response;
    };
  });
  const editor = page.getByRole('textbox', { name: '任务描述', exact: true });
  const send = page.getByRole('button', { name: '发送任务', exact: true });
  let id, box;
  const lifecycleWrites = [];
  const projectReads = [];
  await env.step('Confirm the deployed HTTP service is healthy', async () => {
    const health = await env.request('/healthz');
    assert.equal(health.response.status, 200);
    assert.equal(health.data, 'ok');
    return { status: health.response.status };
  });
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
    assert.match(resumedResponse.headers()['content-type'] ?? '', /text\/event-stream/i);
    assert.equal(resumedResponse.request().headers()['accept'], 'text/event-stream');
    const resumePath = `/api/projects/${id}/sandbox/resume`;
    await page.waitForFunction(path => window.__resumeSseTestCapture?.some(capture =>
      capture.url === path && (capture.body !== null || capture.error !== null)), resumePath,
    { timeout: env.config.operationTimeout });
    const captured = await page.evaluate(path => window.__resumeSseTestCapture.find(capture => capture.url === path), resumePath);
    assert.equal(captured.status, 200);
    assert.match(captured.contentType ?? '', /text\/event-stream/i);
    assert.equal(captured.error, null, `Reading the cloned resume SSE response failed: ${captured.error}`);
    const events = parseSseEvents(captured.body);
    const progress = events.filter(event => event.event === 'progress').map(event => event.data);
    assert(progress.length > 0, 'Resume SSE must contain progress events');
    assert.deepEqual(progress.map(event => event.sequence), progress.map((_, index) => index + 1));
    for (const event of progress) {
      if (event.sandboxId !== undefined) assert.equal(event.sandboxId, box, 'Progress must identify the existing project Box');
    }
    for (const stage of ['submitting', 'accepted', 'ports_listening']) {
      assert(progress.some(event => event.stage === stage && event.sandboxId === box), `${stage} progress must identify the existing project Box`);
      assert(progress.find(event => event.stage === stage)?.operationId, `${stage} progress must include the project operation ID`);
    }
    const listening = progress.find(event => event.stage === 'ports_listening');
    assert(listening, 'Resume SSE must report the listener milestone');
    assert.deepEqual(listening.waitPorts, [40000, 4500]);
    assert(listening.remoteOperationId, 'Listener progress must include the Cellbox operation ID');
    assert(['warm_pool', 'standard'].includes(listening.resumePath), 'Successful listener progress must report the actual resume path');
    const complete = events.find(event => event.event === 'complete');
    assert(complete, 'Resume SSE must end with a complete project');
    const resumed = complete.data;
    assert.equal(resumed.id, id);
    assert.equal(resumed.sandboxOperation.kind, 'resume');
    assert.equal(resumed.sandboxOperation.status, 'succeeded');
    assert.equal(resumed.sandbox.id, box); assert.equal(resumed.sandbox.status, 'ready');
    assert.equal(events.some(event => event.event === 'error'), false);
    const timeline = page.getByRole('article', { name: env.name('browser'), exact: true })
      .getByRole('region', { name: '恢复时间线', exact: true });
    await expect(timeline).toBeVisible();
    await expect(timeline.locator('summary')).toContainText('恢复完成');
    await timeline.locator('summary').click();
    await expect(timeline.getByText('等待端口已就绪', { exact: true })).toBeVisible();
    await expect(timeline).toContainText('等待端口 40000、4500');
    await expect(timeline.locator('.resume-timeline-metadata')).toContainText(
      listening.resumePath === 'warm_pool' ? '本次命中预热池' : '常规恢复（未命中预热池）');
    await env.waitProject(id, { kind: 'resume', status: 'ready', operationId: resumed.sandboxOperation.id });

    await page.reload();
    const refreshedCard = page.getByRole('article', { name: env.name('browser'), exact: true });
    await expect(refreshedCard).toBeVisible();
    await expect(refreshedCard.getByRole('region', { name: '恢复时间线' })).toHaveCount(0);

    const projectsResponse = page.waitForResponse(response => response.request().method() === 'GET'
      && new URL(response.url()).pathname === '/api/projects', { timeout: env.config.operationTimeout });
    await page.getByRole('button', { name: '刷新', exact: true }).click();
    const actualProjects = await (await projectsResponse).json();
    const activeProjects = actualProjects.filter(project => (project.status ?? (project.archivedAt ? 'archived' : 'active')) === 'active')
      .sort(compareProjectCreation);
    assert(activeProjects.some(project => project.id === id), 'The self-owned active project must remain in the list snapshot');
    await expect.poll(() => activeProjectCardIds(page), { timeout: env.config.operationTimeout })
      .toEqual(activeProjects.map(project => project.id));

    const reentry = page.waitForResponse(response => response.request().method() === 'GET'
      && new URL(response.url()).pathname === `/api/projects/${id}`, { timeout: env.config.operationTimeout });
    await page.getByRole('article', { name: env.name('browser'), exact: true }).getByRole('button', { name: '进入项目' }).click();
    assert.equal((await reentry).status(), 200);
    await expect(editor).toHaveValue('创建时输入的草稿');
    await expect(send).toBeEnabled({ timeout: env.config.operationTimeout });
    assert.deepEqual(lifecycleWrites, [`/api/projects/${id}/sandbox/resume`]);
    return { projectId: id, sandboxId: box, operationId: resumed.sandboxOperation.id,
      readyMs: performance.now() - start,
      resumeProgress: progress.map(({ stage, elapsedMs, remoteStatus, remoteStage, resumePath }) => ({ stage, elapsedMs,
        ...(remoteStatus === undefined ? {} : { remoteStatus }), ...(remoteStage === undefined ? {} : { remoteStage }),
        ...(resumePath === undefined ? {} : { resumePath }) })) };
  });
});
