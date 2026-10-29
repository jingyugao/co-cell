import { test, expect, createThroughUI, projectList } from './fixture.mjs';

test('opening a project is read-only, keeps history visible during an operation, and preserves SSE recovery', async ({ page, ui }) => {
  const project = ui.projects.get('paused');
  project.sandbox.status = 'ready';
  project.sandboxOperation = { id: 'checkpoint-op', kind: 'checkpoint', status: 'running', phase: '暂停中', updatedAt: '2026-01-01T00:00:00Z' };
  const session = ui.sessions.get('old-session');
  let streams = 0;
  await page.route('**/api/sessions/old-session/events', async route => {
    streams++;
    const snapshot = { ...session, historyError: '历史同步暂时失败' };
    const state = { ...snapshot, status: 'completed' };
    await route.fulfill({ contentType: 'text/event-stream', body:
      `data: ${JSON.stringify({ type: 'snapshot', session: snapshot })}\n\n`
      + `data: ${JSON.stringify({ type: 'state', session: state })}\n\n` });
  });
  await page.goto('/sessions/old-session');
  await expect.poll(() => ui.count('GET', '/api/projects/paused')).toBe(1);
  await expect.poll(() => streams).toBeGreaterThan(0);
  await expect(page.getByText('历史任务内容', { exact: true })).toBeVisible();
  expect(ui.count('POST', '/api/projects/paused/open')).toBe(0);
  expect(ui.count('POST', '/api/projects/paused/sandbox/resume')).toBe(0);
  expect(ui.calls.filter(call => call.waitForOperation)).toEqual([]);
  const afterRead = streams;
  await expect.poll(() => streams).toBeGreaterThan(afterRead);
  await expect(page.getByText('历史任务内容', { exact: true })).toBeVisible();
});

test('marking a checkpointed project completed keeps it paused for explicit restore or deletion', async ({ page, ui }) => {
  await page.goto('/#projects');
  await page.getByRole('article', { name: '暂停项目', exact: true }).getByRole('button', { name: '标记已完成', exact: true }).click();
  await page.getByRole('button', { name: /^已完成 \d+$/ }).click();
  const card = page.getByRole('article', { name: '暂停项目', exact: true });
  await expect(card.getByRole('button', { name: '恢复', exact: true })).toBeVisible();
  await expect(card.getByRole('button', { name: '删除', exact: true })).toBeVisible();
  expect(ui.projects.get('paused').status).toBe('completed');
  expect(ui.projects.get('paused').sandbox.status).toBe('paused');
  expect(ui.calls.filter(call => call.method === 'POST')).toEqual([]);
});

test('failed paused disk backup offers an explicit backup retry', async ({ page, ui }) => {
  ui.projects.get('paused').sandboxBackup = { id: 'backup', sandboxId: 'paused-box', status: 'failed', phase: '上传', error: '归档失败', updatedAt: '2026-01-01T00:00:00Z' };
  await page.goto('/#projects');
  const card = page.getByRole('article', { name: '暂停项目', exact: true });
  await expect(card.getByRole('button', { name: '重试磁盘备份', exact: true })).toBeVisible();
  await card.getByRole('button', { name: '重试磁盘备份', exact: true }).click();
  await expect.poll(() => ui.count('POST', '/api/projects/paused/backup')).toBe(1);
  expect(ui.calls.find(call => call.path === '/api/projects/paused/backup')?.status).toBe(200);
});

test('an existing disk backup does not block explicit resume; project viewing remains available', async ({ page, ui }) => {
  ui.projects.get('paused').sandboxBackup = { id: 'backup', sandboxId: 'paused-box', status: 'running', phase: '上传中', updatedAt: '2026-01-01T00:00:00Z' };
  await page.goto('/projects/paused');
  await expect.poll(() => ui.count('GET', '/api/projects/paused')).toBe(1);
  await expect(ui.editor).toBeEditable();
  await ui.editor.fill('备份期间仍可查看并编辑草稿');
  await expect(ui.editor).toHaveValue('备份期间仍可查看并编辑草稿');
  expect(ui.count('POST', '/api/projects/paused/open')).toBe(0);
  expect(ui.count('POST', '/api/projects/paused/sandbox/resume')).toBe(0);
  expect(ui.calls.filter(call => call.waitForOperation)).toEqual([]);

  await projectList(page);
  const card = page.getByRole('article', { name: '暂停项目', exact: true });
  await expect(card.getByText('磁盘备份：上传中', { exact: true })).toBeVisible();
  await expect(card.getByRole('button', { name: '进入项目', exact: true })).toBeEnabled();
  await expect(card.getByRole('button', { name: '标记已完成', exact: true })).toBeEnabled();
  await expect(card.getByRole('button', { name: '恢复运行', exact: true })).toBeEnabled();
  expect(ui.count('POST', '/api/projects/paused/sandbox/resume')).toBe(0);

  await card.getByRole('button', { name: '恢复运行', exact: true }).click();
  await expect.poll(() => ui.count('POST', '/api/projects/paused/sandbox/resume')).toBe(1);
  expect(ui.count('POST', '/api/projects/paused/sandbox/resume')).toBe(1);
  await ui.complete('paused');
  await projectList(page);
  await card.getByRole('button', { name: '进入项目', exact: true }).click();
  await expect(ui.editor).toHaveValue('备份期间仍可查看并编辑草稿');
  await expect(ui.send).toBeEnabled();
  expect(ui.count('POST', '/api/projects/paused/open')).toBe(0);
});

test('active projects keep creation order after status updates, resume, and refresh', async ({ page, ui }) => {
  const paused = ui.projects.get('paused');
  const other = ui.projects.get('other');
  paused.createdAt = '2026-01-02T00:00:00Z';
  other.createdAt = '2026-01-02T00:00:00Z';
  other.sandbox.status = 'paused';
  const newest = { ...other, id: 'newest', name: '最新项目', createdAt: '2026-01-03T00:00:00Z', sandbox: { ...other.sandbox, id: 'newest-box' } };
  ui.projects.set(newest.id, newest);
  const restored = ui.addCompletedProject('restored');
  restored.name = '恢复后项目';
  restored.createdAt = '2026-01-01T00:00:00Z';
  const otherCompleted = ui.addCompletedProject('completed-newer');
  otherCompleted.name = '另一个已完成项目';
  otherCompleted.createdAt = '2026-01-04T00:00:00Z';

  const cardOrder = (label) => page.locator(`section[aria-label="${label}"] > article`).evaluateAll(cards => cards.map(card => card.getAttribute('aria-label')));
  const expectActiveOrder = names => expect.poll(() => cardOrder('使用中项目列表')).toEqual(names);
  await page.goto('/#projects');
  await expectActiveOrder(['最新项目', '另一个项目', '暂停项目']);

  await page.getByRole('button', { name: /^已完成 \d+$/ }).click();
  await expect.poll(() => cardOrder('已完成项目列表')).toEqual(['恢复后项目', '另一个已完成项目']);
  await page.getByRole('article', { name: '恢复后项目', exact: true }).getByRole('button', { name: '恢复', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '已恢复为使用中' })).toBeVisible();
  restored.updatedAt = '2030-01-01T00:00:00Z';
  await page.getByRole('button', { name: /^使用中 \d+$/ }).click();
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await expectActiveOrder(['最新项目', '另一个项目', '暂停项目', '恢复后项目']);

  const otherCard = page.getByRole('article', { name: '另一个项目', exact: true });
  await otherCard.getByRole('button', { name: '恢复运行', exact: true }).click();
  await expect.poll(() => ui.count('POST', '/api/projects/other/sandbox/resume')).toBe(1);
  await ui.complete('other');
  await expect(otherCard.getByRole('region', { name: '恢复时间线', exact: true }).locator('summary').getByText('恢复完成', { exact: true })).toBeVisible();
  other.updatedAt = '2040-01-01T00:00:00Z';
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await expectActiveOrder(['最新项目', '另一个项目', '暂停项目', '恢复后项目']);

  await page.reload();
  await expectActiveOrder(['最新项目', '另一个项目', '暂停项目', '恢复后项目']);
});

for (const viewport of [{ name: 'desktop', width: 1280 }, { name: 'mobile', width: 390 }]) {
  test(`explicit resume shows a transient progress timeline on ${viewport.name}`, async ({ page, ui }) => {
    await page.setViewportSize({ width: viewport.width, height: 900 });
    ui.setResumePath('paused', viewport.name === 'desktop' ? 'warm_pool' : 'standard');
    await page.goto('/#projects');
    const card = page.getByRole('article', { name: '暂停项目', exact: true });
    await card.getByRole('button', { name: '恢复运行', exact: true }).click();

    const timeline = card.getByRole('region', { name: '恢复时间线', exact: true });
    await expect(timeline.getByText('正在恢复', { exact: true })).toBeVisible();
    await expect(timeline.getByText('提交恢复操作', { exact: true })).toBeVisible();
    expect(ui.count('POST', '/api/projects/paused/sandbox/resume')).toBe(1);
    expect(ui.calls.find(call => call.path === '/api/projects/paused/sandbox/resume')?.status).toBeUndefined();

    await ui.complete('paused');
    await expect(timeline.locator('summary').getByText('恢复完成', { exact: true })).toBeVisible();
    await timeline.locator('summary').click();
    await expect(timeline.getByText('等待端口已就绪', { exact: true })).toBeVisible();
    await expect(timeline.locator('.resume-timeline-metadata')).toContainText(viewport.name === 'desktop' ? '本次命中预热池' : '常规恢复（未命中预热池）');
    expect(ui.count('POST', '/api/projects/paused/sandbox/resume')).toBe(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.reload();
    await expect(page.getByRole('article', { name: '暂停项目', exact: true }).getByRole('region', { name: '恢复时间线' })).toHaveCount(0);
    expect(ui.count('POST', '/api/projects/paused/sandbox/resume')).toBe(1);
  });
}

test('a completed resume without path metadata stays explicitly unknown and clears on reload', async ({ page, ui }) => {
  await page.goto('/#projects');
  const card = page.getByRole('article', { name: '暂停项目', exact: true });
  await card.getByRole('button', { name: '恢复运行', exact: true }).click();
  await ui.complete('paused');
  const timeline = card.getByRole('region', { name: '恢复时间线', exact: true });
  await expect(timeline.locator('summary').getByText('恢复完成', { exact: true })).toBeVisible();
  await timeline.locator('summary').click();
  await expect(timeline.locator('.resume-timeline-metadata')).toContainText('预热信息未上报');

  await page.reload();
  await expect(page.getByRole('article', { name: '暂停项目', exact: true }).getByRole('region', { name: '恢复时间线' })).toHaveCount(0);
});

test('a dropped resume progress stream is unknown and is never replayed', async ({ page, ui }) => {
  ui.disconnectResume('paused');
  await page.goto('/#projects');
  const card = page.getByRole('article', { name: '暂停项目', exact: true });
  await card.getByRole('button', { name: '恢复运行', exact: true }).click();

  const timeline = card.getByRole('region', { name: '恢复时间线', exact: true });
  await expect(timeline.locator('summary').getByText('结果未知', { exact: true })).toBeVisible();
  await timeline.locator('summary').click();
  await expect(timeline.getByText('请刷新项目状态确认结果；不会自动重试恢复请求。', { exact: true })).toBeVisible();
  await page.waitForTimeout(300);
  expect(ui.count('POST', '/api/projects/paused/sandbox/resume')).toBe(1);
});

test('paused project submits disk backup only after the explicit backup action', async ({ page, ui }) => {
  await page.goto('/#projects');
  const card = page.getByRole('article', { name: '暂停项目', exact: true });
  await expect(card.getByRole('button', { name: '恢复运行', exact: true })).toBeEnabled();
  await expect(card.getByRole('button', { name: '磁盘备份', exact: true })).toBeEnabled();
  expect(ui.count('POST', '/api/projects/paused/backup')).toBe(0);

  await card.getByRole('button', { name: '磁盘备份', exact: true }).click();
  await expect.poll(() => ui.count('POST', '/api/projects/paused/backup')).toBe(1);
  expect(ui.count('POST', '/api/projects/paused/backup')).toBe(1);
  expect(ui.count('POST', '/api/projects/paused/sandbox/checkpoint')).toBe(0);
  expect(ui.count('POST', '/api/projects/paused/sandbox/resume')).toBe(0);
});

test('project creation waits for Sandbox creation, then opens the project', async ({ page, ui }) => {
  await page.goto('/#projects');
  await createThroughUI(page, '创建完成后进入项目');
  await expect.poll(() => ui.count('POST', '/api/projects')).toBe(1);
  await expect(page).not.toHaveURL(/\/projects\/new$/);
  await expect(page.getByRole('form', { name: '创建项目', exact: true })).toBeVisible();
  expect(ui.calls.find(call => call.path === '/api/projects' && call.method === 'POST')?.status).toBeUndefined();
  await ui.complete('new');
  await expect(page).toHaveURL(/\/projects\/new$/);
  await expect(ui.editor).toBeEditable();
  expect(ui.projects.get('new').sandbox.status).toBe('ready');
  expect(ui.calls.find(call => call.path === '/api/projects' && call.method === 'POST')?.status).toBe(201);
  expect(ui.count('POST', '/api/projects/new/open')).toBe(0);
});

test('opening a project with a failed create only rereads status and never creates', async ({ page, ui }) => {
  const project = ui.projects.get('other');
  delete project.sandbox;
  project.sandboxOperation = { id: 'failed-create', kind: 'create', status: 'failed', error: 'Box creation failed', updatedAt: '2026-01-01T00:00:00Z' };
  await page.goto('/#projects');
  const card = page.getByRole('article', { name: '另一个项目', exact: true });
  await expect(card.locator('.project-card-statuses .project-status')).toHaveText('尚未创建');
  await expect(card.getByRole('button', { name: '新建 Sandbox', exact: true })).toBeEnabled();
  await expect(card.getByRole('button', { name: '从备份恢复', exact: true })).toHaveCount(0);
  await card.getByRole('button', { name: '进入项目', exact: true }).click();
  await expect(page.getByRole('button', { name: '重新读取状态', exact: true })).toBeVisible();
  expect(ui.count('GET', '/api/projects/other')).toBeGreaterThan(0);
  expect(ui.count('POST', '/api/projects/other/sandbox/create')).toBe(0);
});

test('a released project backs up retained volume without creating a Sandbox', async ({ page, ui }) => {
  const project = ui.projects.get('other');
  delete project.sandbox;
  project.sandboxMounts = [{ volumeId: 'released-volume', mountPath: '/workspace' }];
  project.sandboxReclaimedAt = '2026-01-01T00:00:00Z';
  project.latestBackup = { createdAt: '2025-12-31T00:00:00Z', sizeBytes: 128, checksum: 'a'.repeat(64) };
  project.remoteArchives = [{ id: 'released-archive', createdAt: project.latestBackup.createdAt, sizeBytes: 128, sha256: 'a'.repeat(64), threadIds: [] }];
  await page.goto('/#projects');
  const card = page.getByRole('article', { name: '另一个项目', exact: true });
  await expect(card.locator('.project-card-statuses .project-status')).toHaveText('已释放');
  await expect(card.getByRole('button', { name: '新建 Sandbox', exact: true })).toBeEnabled();
  await expect(card.getByRole('button', { name: '磁盘备份', exact: true })).toBeEnabled();
  await expect(card.getByText(/可直接备份保留的挂载盘/)).toBeVisible();
  await expect(card.getByRole('button', { name: '从备份恢复', exact: true })).toBeEnabled();
  await card.getByRole('button', { name: '磁盘备份', exact: true }).click();
  await expect.poll(() => ui.count('POST', '/api/projects/other/backup')).toBe(1);
  expect(ui.count('POST', '/api/projects/other/sandbox/create')).toBe(0);
  expect(ui.count('POST', '/api/projects/other/sandbox/restore')).toBe(0);
  expect(ui.count('POST', '/api/projects/other/sandbox/checkpoint')).toBe(0);
});

test('a processing project refreshes through GET only and exposes no lifecycle mutation', async ({ page, ui }) => {
  const project = ui.projects.get('other');
  project.sandbox = { ...project.sandbox, status: 'ready' };
  project.sandboxOperation = { id: 'checkpoint-running', kind: 'checkpoint', status: 'running', phase: 'Cellbox 正在暂停', updatedAt: '2026-01-01T00:00:00Z' };
  await page.goto('/#projects');
  const card = page.getByRole('article', { name: '另一个项目', exact: true });
  await expect(card.locator('.project-card-statuses .project-status')).toHaveText('处理中');
  await expect(card.locator('section[aria-label="Sandbox 操作"]').getByRole('button')).toHaveText(['刷新状态']);
  const before = ui.calls.length;
  await card.getByRole('button', { name: '刷新状态', exact: true }).click();
  await expect.poll(() => ui.calls.length).toBeGreaterThan(before);
  expect(ui.calls.slice(before).every(call => call.method === 'GET')).toBe(true);
  expect(ui.calls.filter(call => call.method === 'POST' && /^\/api\/projects\/other\/(sandbox\/create|sandbox\/restore|sandbox\/resume|sandbox\/checkpoint|sandbox\/release|backup)$/.test(call.path))).toEqual([]);
});

test('an unknown Box allows status refresh and release, never create', async ({ page, ui }) => {
  const project = ui.projects.get('other');
  project.sandbox.status = 'unknown';
  project.sandboxOperation = { id: 'resume-unknown', kind: 'resume', status: 'unknown', phase: '请求结果未知', error: 'Cellbox response lost', updatedAt: '2026-01-01T00:00:00Z' };
  await page.goto('/#projects');
  const card = page.getByRole('article', { name: '另一个项目', exact: true });
  await expect(card.locator('.project-card-statuses .project-status')).toHaveText('状态未知');
  await expect(card.getByRole('button', { name: '刷新状态', exact: true })).toBeEnabled();
  await expect(card.getByRole('button', { name: '释放运行环境', exact: true })).toBeEnabled();
  await expect(card.getByRole('button', { name: '新建 Sandbox', exact: true })).toHaveCount(0);
  const before = ui.calls.length;
  await card.getByRole('button', { name: '刷新状态', exact: true }).click();
  await expect.poll(() => ui.calls.length).toBeGreaterThan(before);
  expect(ui.calls.slice(before).every(call => call.method === 'GET')).toBe(true);
  expect(ui.count('POST', '/api/projects/other/sandbox/create')).toBe(0);

  let confirmation;
  page.once('dialog', async dialog => { confirmation = dialog.message(); await dialog.accept(); });
  await card.getByRole('button', { name: '释放运行环境', exact: true }).click();
  await expect.poll(() => ui.count('POST', '/api/projects/other/sandbox/release')).toBe(1);
  expect(confirmation).toContain('结束其中的进程');
  expect(ui.count('POST', '/api/projects/other/sandbox/create')).toBe(0);
});

test('a paused session does not trigger resume; history loads after an explicit resume', async ({ page, ui }) => {
  await page.goto('/sessions/old-session');
  await expect(ui.editor).toBeEditable();
  await ui.editor.fill('恢复之前保留的会话草稿');
  await expect(ui.editor).toHaveValue('恢复之前保留的会话草稿');
  expect(ui.count('POST', '/api/projects/paused/open')).toBe(0);
  expect(ui.count('POST', '/api/projects/paused/sandbox/resume')).toBe(0);
  expect(ui.historyReads).toHaveLength(0);
  expect(ui.count('GET', '/api/sessions/old-session/events')).toBeGreaterThan(0);
  await projectList(page);
  await page.getByRole('article', { name: '暂停项目', exact: true }).getByRole('button', { name: '恢复运行', exact: true }).click();
  await expect.poll(() => ui.count('POST', '/api/projects/paused/sandbox/resume')).toBe(1);
  await ui.complete('paused');
  await expect.poll(() => ui.count('GET', '/api/projects/paused')).toBeGreaterThan(0);
  await page.goto('/sessions/old-session');
  await expect(page.getByText('历史任务内容', { exact: true })).toBeVisible();
  await expect(ui.editor).toHaveValue('恢复之前保留的会话草稿');
  expect(ui.count('POST', '/api/projects/paused/open')).toBe(0);
});

test('switching sessions only reads project state and does not reopen or resume the workspace', async ({ page, ui }) => {
  ui.projects.get('paused').sandbox.status = 'ready';
  await page.goto('/sessions/old-session');
  await expect(ui.editor).toBeEditable();
  const navigation = page.getByRole('button', { name: '打开导航', exact: true });
  if (await navigation.isVisible()) await navigation.click();
  await page.getByRole('button', { name: '同项目的另一个会话 · 暂停项目', exact: true }).click();
  await expect.poll(() => ui.count('GET', '/api/sessions/second-session/events')).toBeGreaterThan(0);
  await expect(ui.editor).toBeEditable();
  expect(ui.count('POST', '/api/projects/paused/open')).toBe(0);
  expect(ui.count('POST', '/api/projects/paused/sandbox/resume')).toBe(0);
  expect(ui.calls.filter(call => call.waitForOperation)).toEqual([]);
});

test('a running conversation can be viewed and receive additional input', async ({ page, ui }) => {
  const project = ui.projects.get('paused');
  project.sandbox.status = 'ready';
  project.sandboxOperation = { id: 'checkpoint-op', kind: 'checkpoint', status: 'running', phase: '检查状态', updatedAt: '2026-01-01T00:00:00Z' };
  ui.setRunning();
  await page.goto('/sessions/old-session');
  await expect(page.getByText('原始任务', { exact: true })).toBeVisible();
  await expect(page.locator('.additional-user-message')).toHaveCount(2);
  await expect(ui.editor).toBeEditable();
  const send = page.getByRole('button', { name: '追加消息', exact: true });
  await ui.editor.fill('请同时检查这个边界情况');
  await expect(send).toBeEnabled();
  await send.click();
  await expect.poll(() => ui.submissions.length).toBe(1);
  expect(ui.submissions[0]).toEqual({ prompt: '请同时检查这个边界情况', images: [] });
  expect(ui.count('POST', '/api/projects/paused/open')).toBe(0);
  await expect(page.getByRole('button', { name: '停止任务', exact: true })).toBeVisible();
});

test('project drafts remain separate while navigating without a preparation wait', async ({ page, ui }) => {
  ui.projects.get('paused').sandbox.status = 'ready';
  await page.goto('/projects/paused');
  await expect(ui.editor).toBeEditable();
  await ui.editor.fill('第一个项目的草稿');
  await projectList(page);
  await page.getByRole('article', { name: '另一个项目', exact: true }).getByRole('button', { name: '进入项目' }).click();
  await expect(ui.editor).toHaveValue('');
  await ui.editor.fill('第二个项目的草稿');
  expect(ui.calls.filter(call => call.waitForOperation)).toEqual([]);
  await projectList(page);
  await page.getByRole('article', { name: '暂停项目', exact: true }).getByRole('button', { name: '进入项目' }).click();
  await expect(ui.editor).toHaveValue('第一个项目的草稿');
  expect(ui.count('POST', '/api/projects/paused/open')).toBe(0);
});

test('a broken Sandbox does not offer same-ID rebuild and labels backup restore as explicit', async ({ page, ui }) => {
  const project = ui.projects.get('other');
  project.sandbox.status = 'unavailable';
  project.latestBackup = { createdAt: '2025-01-01T00:00:00Z', sizeBytes: 128, checksum: 'a'.repeat(64) };
  project.remoteArchives = [{ id: 'existing-archive', createdAt: project.latestBackup.createdAt, sizeBytes: 128, sha256: 'a'.repeat(64), threadIds: [] }];
  await page.goto('/#projects');
  const card = page.getByRole('article', { name: '另一个项目', exact: true });
  await expect(card.getByRole('button', { name: '重建环境', exact: true })).toHaveCount(0);
  await expect(card.getByRole('button', { name: '从备份恢复', exact: true })).toBeEnabled();
  let confirmation;
  page.once('dialog', async dialog => { confirmation = dialog.message(); await dialog.accept(); });
  await card.getByRole('button', { name: '从备份恢复', exact: true }).click();
  await expect.poll(() => ui.count('POST', '/api/projects/other/sandbox/restore')).toBe(1);
  expect(confirmation).toContain('新的 Sandbox');
  expect(confirmation).toContain('新的挂载盘');
  expect(confirmation).toContain('原挂载盘保留');
  await ui.complete('other');
  expect(ui.projects.get('other').sandbox.id).toBe('other-restored-box');
});

test('creating a Sandbox is independent from restoring an available backup', async ({ page, ui }) => {
  const project = ui.projects.get('other');
  delete project.sandbox;
  project.latestBackup = { createdAt: '2025-01-01T00:00:00Z', sizeBytes: 128, checksum: 'a'.repeat(64) };
  project.remoteArchives = [{ id: 'existing-archive', createdAt: project.latestBackup.createdAt, sizeBytes: 128, sha256: 'a'.repeat(64), threadIds: [] }];
  await page.goto('/#projects');
  const card = page.getByRole('article', { name: '另一个项目', exact: true });
  await card.getByRole('button', { name: '新建 Sandbox', exact: true }).click();
  await expect.poll(() => ui.count('POST', '/api/projects/other/sandbox/create')).toBe(1);
  expect(ui.count('POST', '/api/projects/other/sandbox/restore')).toBe(0);
  await ui.complete('other');
});

test('releasing a runtime confirms process termination and keeps project mounts visible', async ({ page, ui }) => {
  const project = ui.projects.get('paused');
  project.sandboxMounts = [{ volumeId: 'project-volume', mountPath: '/workspace', readOnly: false }];
  await page.goto('/#projects');
  const card = page.getByRole('article', { name: '暂停项目', exact: true });
  let confirmation;
  page.once('dialog', async dialog => { confirmation = dialog.message(); await dialog.accept(); });
  await card.getByRole('button', { name: '释放运行环境', exact: true }).click();
  await expect.poll(() => ui.count('POST', '/api/projects/paused/sandbox/release')).toBe(1);
  expect(confirmation).toContain('结束其中的进程');
  expect(confirmation).toContain('挂载盘');
  await expect(card.getByText('project-volume')).toBeVisible();
  await expect(card.getByText('/workspace')).toBeVisible();
  await expect(card.locator('.project-card-statuses .project-status')).toHaveText('已释放');
  expect(project.sandbox).toBeUndefined();
});
