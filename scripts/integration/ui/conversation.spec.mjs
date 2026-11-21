import { test, expect } from './fixture.mjs';

test('subagent read failures retry after readiness and clear the warning on success', async ({ page, ui }) => {
  ui.complete('paused');
  let reads = 0;
  await page.route('**/api/sessions/old-session/subagents', async route => {
    reads++;
    await route.fulfill(reads === 1 ? { status: 503, json: { error: 'Sandbox 正忙，请稍后重试' } } : { json: [] });
  });
  // Start observing the transient warning before the full-page load can outlast
  // the retry interval (for example, on a cold Vite dependency cache).
  await page.goto('/sessions/old-session', { waitUntil: 'domcontentloaded' });
  const warning = page.getByText('子代理对话暂时无法加载，正在自动重试。', { exact: true });
  await expect(warning).toBeVisible();
  await expect.poll(() => reads).toBe(2);
  await expect(warning).toHaveCount(0);
});

test('a session without a native thread does not request subagent history', async ({ page, ui }) => {
  ui.complete('paused');
  ui.sessions.get('old-session').threadId = null;
  await page.goto('/sessions/old-session');
  await expect(page.getByText('历史任务内容', { exact: true })).toBeVisible();
  expect(ui.count('GET', '/api/sessions/old-session/subagents')).toBe(0);
});

test('first message stays in one frame when native acceptance precedes its stream event', async ({ page, ui }) => {
  ui.complete('paused');
  const session = ui.sessions.get('old-session');
  const pending = { id: 'web-turn', prompt: 'hello', images: [], items: [], status: 'running',
    codexAccepted: false, startedAt: session.createdAt };
  const accepted = { ...pending, nativeTurnId: 'native-turn', codexAccepted: true };
  const answer = { id: 'answer', type: 'agent_message', text: 'Hello! How can I help?' };
  const completed = { ...accepted, status: 'completed', completedAt: session.createdAt };
  session.status = 'completed';
  session.turns = [{ ...completed, items: [answer] }];
  let opened = false;
  await page.route('**/api/sessions/old-session/events', async route => {
    const messages = opened ? [{ type: 'snapshot', session }] : [
      { type: 'snapshot', session: { ...session, status: 'running', turns: [pending] } },
      { type: 'state', session: { ...session, status: 'running', turns: [accepted] } },
      { type: 'sdk', turnId: pending.id, event: { type: 'turn.started', turn_id: accepted.nativeTurnId } },
      { type: 'sdk', turnId: pending.id, event: { type: 'item.completed', item: answer } },
      { type: 'sdk', turnId: pending.id, event: { type: 'turn.completed' } },
      { type: 'state', session: { ...session, turns: [completed] } },
    ];
    opened = true;
    await route.fulfill({ contentType: 'text/event-stream', body: messages.map(message => `data: ${JSON.stringify(message)}\n\n`).join('') });
  });
  await page.goto('/sessions/old-session');
  await expect(page.getByText(answer.text, { exact: true })).toBeVisible();
  await expect(page.locator('.turn-list > .turn')).toHaveCount(1);
  await expect(page.locator('.user-message > p')).toHaveText('hello');
  await expect(page.locator('.assistant-header')).toContainText('已完成');
  await page.reload();
  await expect(page.getByText(answer.text, { exact: true })).toBeVisible();
  await expect(page.locator('.turn-list > .turn')).toHaveCount(1);
});

test('Claude Code selection persists on creation and uses the session HTTP path', async ({ page, ui }) => {
  await ui.complete('paused');
  const project = ui.projects.get('paused');
  let createdInput;
  await page.route('**/api/config', route => route.fulfill({ json: {
    defaults: { executionMode: 'sandbox', workingDirectory: project.workingDirectory, model: 'codex-model',
      modelReasoningEffort: 'medium', sandboxMode: 'danger-full-access', webSearchMode: 'disabled', networkAccessEnabled: true },
    sandbox: { provider: 'cellbox', enabled: true, image: 'default', workingDirectory: project.workingDirectory },
    codexVersion: 'fixture',
    claudeDefaults: { model: 'claude-fixture', modelEntryId: 'claude-a' },
    claudeModelOptions: [
      { id: 'claude-a', model: 'claude-fixture', channelId: 'a', channelName: '渠道 A', label: 'claude-fixture（渠道 A）' },
      { id: 'claude-b', model: 'claude-fixture', channelId: 'b', channelName: '渠道 B', label: 'claude-fixture（渠道 B）' },
    ],
    approvalPolicy: 'never', auth: 'api-key',
    capabilities: { interactiveApprovals: false, tokenDeltas: false, nativeWebSocket: true, claudeCode: true },
  } }));
  await page.route('**/api/sessions', async route => {
    if (route.request().method() !== 'POST') return route.fallback();
    createdInput = route.request().postDataJSON();
    const now = new Date().toISOString();
    const created = { id: 'claude-session', projectId: 'paused', title: 'Claude 测试', agentKind: createdInput.agentKind,
      threadId: null, status: 'idle', settings: createdInput.settings, turns: [], archivedAt: null,
      startedAt: now, createdAt: now, updatedAt: now };
    ui.sessions.set(created.id, created);
    await route.fulfill({ status: 201, json: created });
  });
  await page.goto('/projects/paused');
  const agent = page.getByRole('combobox', { name: '执行引擎', exact: true });
  await agent.selectOption('claude-code');
  const picker = page.getByRole('button', { name: /^配置模型/ });
  await expect(picker).toHaveAccessibleName('配置模型，当前 claude-fixture，渠道 A，默认');
  await picker.click();
  const dialog = page.getByRole('dialog', { name: '配置' });
  const effort = dialog.getByLabel('推理强度');
  await expect(effort.locator('option')).toHaveText(['默认', 'Low', 'Medium', 'High', 'Extra High', 'Max']);
  await effort.selectOption('xhigh');
  await expect(dialog.getByLabel('速度')).toHaveCount(0);
  await dialog.getByLabel('模型').selectOption('claude-b');
  await dialog.getByRole('button', { name: '完成' }).click();
  await expect(picker).toHaveAccessibleName('配置模型，当前 claude-fixture，渠道 B，Extra High');
  const settingsButton = page.locator('.composer-meta button');
  if (await settingsButton.isVisible()) {
    await settingsButton.click();
    await page.getByRole('button', { name: '保存设置' }).click();
  }
  await agent.selectOption('codex');
  await expect(page.getByRole('button', { name: /^配置模型/ })).toHaveAccessibleName(/当前 codex-model/);
  await agent.selectOption('claude-code');
  await expect(picker).toHaveAccessibleName('配置模型，当前 claude-fixture，渠道 B，Extra High');
  await ui.editor.fill('检查项目结构');
  await ui.send.click();
  await expect.poll(() => createdInput?.agentKind).toBe('claude-code');
  expect(createdInput.settings.model).toBe('claude-fixture');
  expect(createdInput.settings.modelEntryId).toBe('claude-b');
  expect(createdInput.settings.claudeEffort).toBe('xhigh');
  await expect.poll(() => ui.submissions.length).toBe(1);
  expect(ui.submissions[0]).toMatchObject({ prompt: '检查项目结构', images: [] });
  expect(ui.submissions[0].clientRequestId).toMatch(/^[0-9a-f-]{36}$/);
  await expect(agent).toBeDisabled();
  await page.reload();
  await expect(page.getByRole('combobox', { name: '执行引擎', exact: true })).toHaveValue('claude-code');
  await expect(page.getByRole('button', { name: /^配置模型/ })).toHaveAccessibleName('配置模型，当前 claude-fixture，渠道 B，Extra High');
});

test('Claude Code retry after an uncertain response keeps the same submission ID across reload', async ({ page, ui }) => {
  await ui.complete('paused');
  const session = ui.sessions.get('old-session');
  session.agentKind = 'claude-code';
  const attempts = [];
  await page.route('**/api/config', route => route.fulfill({ json: {
    defaults: session.settings,
    sandbox: { provider: 'cellbox', enabled: true, image: 'default', workingDirectory: session.settings.workingDirectory },
    codexVersion: 'fixture', claudeDefaults: { model: session.settings.model, modelEntryId: 'claude-a' }, claudeModelOptions: [], approvalPolicy: 'never', auth: 'api-key',
    capabilities: { interactiveApprovals: false, tokenDeltas: false, nativeWebSocket: true, claudeCode: true },
  } }));
  await page.route('**/api/sessions/old-session/turns', async route => {
    if (route.request().method() !== 'POST') return route.fallback();
    attempts.push(route.request().postDataJSON());
    if (attempts.length === 1) await route.abort('connectionreset');
    else await route.fulfill({ status: 202, json: { turnId: attempts[1].clientRequestId } });
  });
  await page.goto('/sessions/old-session');
  await ui.editor.fill('运行一次检查');
  await ui.send.click();
  await expect.poll(() => attempts.length).toBe(1);
  await expect(page.getByText('发送未确认', { exact: true })).toBeVisible();
  await page.reload();
  await expect(ui.editor).toHaveValue('运行一次检查');
  await ui.send.click();
  await expect.poll(() => attempts.length).toBe(2);
  expect(attempts[1].clientRequestId).toBe(attempts[0].clientRequestId);
});

test('an idle Claude session can change its selected channel', async ({ page, ui }) => {
  await ui.complete('paused');
  const session = ui.sessions.get('old-session');
  session.agentKind = 'claude-code';
  session.settings.model = 'claude-sonnet';
  session.settings.modelEntryId = 'claude-a';
  let patch;
  await page.route('**/api/config', route => route.fulfill({ json: {
    defaults: session.settings,
    sandbox: { provider: 'cellbox', enabled: true, image: 'default', workingDirectory: session.settings.workingDirectory },
    codexVersion: 'fixture', claudeDefaults: { model: 'claude-sonnet', modelEntryId: 'claude-a' },
    claudeModelOptions: [
      { id: 'claude-a', model: 'claude-sonnet', channelId: 'a', channelName: '渠道 A', label: 'claude-sonnet（渠道 A）' },
      { id: 'claude-b', model: 'claude-sonnet', channelId: 'b', channelName: '渠道 B', label: 'claude-sonnet（渠道 B）' },
    ], approvalPolicy: 'never', auth: 'api-key',
    capabilities: { interactiveApprovals: false, tokenDeltas: false, nativeWebSocket: true, claudeCode: true },
  } }));
  await page.route('**/api/sessions/old-session', async route => {
    if (route.request().method() !== 'PATCH') return route.fallback();
    patch = route.request().postDataJSON();
    session.settings = { ...session.settings, ...patch.settings };
    await route.fulfill({ json: session });
  });
  await page.goto('/sessions/old-session');
  const picker = page.getByRole('button', { name: /^配置模型/ });
  await picker.click();
  const dialog = page.getByRole('dialog', { name: '配置' });
  await dialog.getByLabel('模型').selectOption('claude-b');
  await dialog.getByRole('button', { name: '完成' }).click();
  await expect.poll(() => patch?.settings).toEqual({ model: 'claude-sonnet', modelEntryId: 'claude-b' });
  await expect(picker).toHaveAccessibleName('配置模型，当前 claude-sonnet，渠道 B，默认');
  await picker.click();
  await dialog.getByLabel('推理强度').selectOption('low');
  await dialog.getByRole('button', { name: '完成' }).click();
  await expect.poll(() => patch?.settings).toEqual({ claudeEffort: 'low' });
  await expect(picker).toHaveAccessibleName('配置模型，当前 claude-sonnet，渠道 B，Low');
  await picker.click();
  await dialog.getByRole('button', { name: '恢复默认' }).click();
  await dialog.getByRole('button', { name: '完成' }).click();
  await expect.poll(() => patch?.settings).toEqual({ model: 'claude-sonnet', modelEntryId: 'claude-a', claudeEffort: 'default' });
});

test('Claude Code session does not request Codex subagent history', async ({ page, ui }) => {
  await ui.complete('paused');
  ui.sessions.get('old-session').agentKind = 'claude-code';
  await page.goto('/sessions/old-session');
  await expect(page.getByText('历史任务内容', { exact: true })).toBeVisible();
  expect(ui.count('GET', '/api/sessions/old-session/subagents')).toBe(0);
});

test('Claude host-owned running turns do not display Codex receipt warnings', async ({ page, ui }) => {
  await ui.complete('paused');
  const session = ui.sessions.get('old-session');
  session.agentKind = 'claude-code';
  session.status = 'running';
  session.turns = [{ id: 'claude-running', prompt: '执行任务', images: [], items: [],
    status: 'running', startedAt: session.createdAt }];
  await page.goto('/sessions/old-session');
  await expect(page.getByText('执行任务', { exact: true })).toBeVisible();
  await expect(page.locator('.turn-context-status')).toHaveCount(0);
  await expect(page.locator('.assistant-header')).toContainText('正在处理你的任务');
});

test('a queued Claude answer stays visible while delivery status changes', async ({ page, ui }) => {
  await ui.complete('paused');
  const session = ui.sessions.get('old-session');
  session.agentKind = 'claude-code';
  const request = { id: 'question-1', questions: [{ title: 'Which database?', options: ['Postgres', 'Redis'] }],
    status: 'queued', deliveryStatus: 'queued', answers: ['Redis'], createdAt: session.createdAt };
  session.turns = [{ id: 'question-turn', prompt: '选择数据库', images: [], status: 'completed',
    startedAt: session.createdAt, items: [], userInputRequests: [request] }];
  await page.goto('/sessions/old-session');
  const card = page.getByRole('region', { name: 'CoCell 的问题' });
  await expect(card).toContainText('回答已收到');
  await expect(card).toContainText('Redis');
  await expect(card.getByRole('button', { name: '发送回答' })).toHaveCount(0);
  request.deliveryStatus = 'unknown';
  await page.reload();
  await expect(card).toContainText('答案接收状态待确认');
  await expect(card).toContainText('Redis');
  await expect(card.getByRole('button', { name: '发送回答' })).toHaveCount(0);
});
