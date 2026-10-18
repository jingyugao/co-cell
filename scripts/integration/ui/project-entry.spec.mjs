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

test('marking a checkpointed project completed keeps it paused and explains scheduled archiving', async ({ page, ui }) => {
  await page.goto('/#projects');
  await page.getByRole('article', { name: '暂停项目', exact: true }).getByRole('button', { name: '标记已完成', exact: true }).click();
  await page.getByRole('button', { name: /^已完成 \d+$/ }).click();
  const card = page.getByRole('article', { name: '暂停项目', exact: true });
  await expect(card.getByRole('button', { name: '恢复使用中', exact: true })).toBeVisible();
  await expect(card.getByText('完成满 1 天后会从磁盘备份最新数据并清理暂停环境，不恢复运行。', { exact: true })).toBeVisible();
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
  expect(confirmation).toContain('恢复会创建新的 Sandbox');
  await ui.complete('other');
  expect(ui.projects.get('other').sandbox.id).toBe('other-restored-box');
});
