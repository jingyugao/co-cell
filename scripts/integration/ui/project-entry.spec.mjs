import { test, expect, createThroughUI, projectList } from './fixture.mjs';

test('history waits for project entry and ignores stale SSE recovery errors after a successful read', async ({ page, ui }) => {
  const session = ui.sessions.get('old-session');
  let streams = 0;
  await page.route('**/api/sessions/old-session/events', async route => {
    streams++;
    const snapshot = { ...session, historyError: '项目 Sandbox 尚未恢复，暂时无法加载历史消息。' };
    const state = { ...snapshot, status: 'completed' };
    await route.fulfill({ contentType: 'text/event-stream', body:
      `data: ${JSON.stringify({ type: 'snapshot', session: snapshot })}\n\n`
      + `data: ${JSON.stringify({ type: 'state', session: state })}\n\n` });
  });
  await page.goto('/sessions/old-session');
  await expect.poll(() => ui.count('POST', '/api/projects/paused/open')).toBe(1);
  await expect.poll(() => streams).toBeGreaterThan(0);
  await expect(page.getByText('项目 Sandbox 尚未恢复，暂时无法加载历史消息。', { exact: true })).toBeVisible();
  expect(ui.historyReads).toEqual([]);
  await ui.complete('paused');
  await expect(page.getByText('历史任务内容', { exact: true })).toBeVisible();
  await expect(page.getByText('项目 Sandbox 尚未恢复，暂时无法加载历史消息。', { exact: true })).toHaveCount(0);
  const afterRead = streams;
  await expect.poll(() => streams).toBeGreaterThan(afterRead);
  await expect(page.getByText('项目 Sandbox 尚未恢复，暂时无法加载历史消息。', { exact: true })).toHaveCount(0);
  await expect(page.getByText('历史任务内容', { exact: true })).toBeVisible();
});

test('marking a checkpointed project completed keeps it paused and explains automatic archiving', async ({ page, ui }) => {
  await page.goto('/#projects');
  await page.getByRole('article', { name: '暂停项目', exact: true }).getByRole('button', { name: '标记已完成', exact: true }).click();
  await page.getByRole('button', { name: /^已完成 \d+$/ }).click();
  const card = page.getByRole('article', { name: '暂停项目', exact: true });
  await expect(card.getByRole('button', { name: '恢复使用中', exact: true })).toBeVisible();
  await expect(card.getByText('完成满 1 天后会从磁盘备份最新数据并清理暂停环境，不恢复运行。', { exact: true })).toBeVisible();
  await expect(card.getByRole('button', { name: '立即备份', exact: true })).toHaveCount(0);
  expect(ui.projects.get('paused').status).toBe('completed');
  expect(ui.projects.get('paused').sandbox.status).toBe('paused');
  expect(ui.calls.filter(call => call.method === 'POST')).toEqual([]);
});

test('failed paused Checkpoint offers retry for its disk backup', async ({ page, ui }) => {
  ui.projects.get('paused').sandboxBackup = { id: 'backup', sandboxId: 'paused-box', status: 'failed', phase: '上传', error: '归档失败', updatedAt: '2026-01-01T00:00:00Z' };
  await page.goto('/#projects');
  const card = page.getByRole('article', { name: '暂停项目', exact: true });
  await expect(card.getByRole('button', { name: '重试磁盘备份', exact: true })).toBeVisible();
  await card.getByRole('button', { name: '重试磁盘备份', exact: true }).click();
  await expect.poll(() => ui.count('POST', '/api/projects/paused/sandbox/checkpoint')).toBe(1);
  await ui.checkpoint('paused', false);
  expect(ui.calls.find(call => call.path === '/api/projects/paused/sandbox/checkpoint')?.status).toBe(200);
  await expect(card.getByRole('button', { name: '恢复运行', exact: true })).toBeEnabled();
});

test('background disk backup does not disable paused project entry or resume', async ({ page, ui }) => {
  for (const status of ['running', 'failed']) {
    const project = ui.projects.get('paused');
    project.sandboxBackup = { id: 'backup', sandboxId: project.sandbox.id, status, phase: status === 'running' ? '上传中' : '上传', error: status === 'failed' ? '归档失败' : undefined, updatedAt: '2026-01-01T00:00:00Z' };
    await page.goto('/#projects');
    const card = page.getByRole('article', { name: '暂停项目', exact: true });
    await expect(card.getByRole('button', { name: '进入项目', exact: true })).toBeEnabled();
    await expect(card.getByRole('button', { name: '恢复运行', exact: true })).toBeEnabled();
    if (status === 'running') await expect(card.getByText('磁盘备份：上传中', { exact: true })).toBeVisible();
    else await expect(card.getByRole('alert')).toContainText('磁盘备份失败');
  }
});

test('paused entry keeps the resume request open while preserving the editable draft', async ({ page, ui }) => {
  await page.goto('/#projects');
  const enter = page.getByRole('article', { name: '暂停项目', exact: true }).getByRole('button', { name: '进入项目' });
  await expect(enter).toBeEnabled(); await enter.click();
  await expect(ui.editor).toBeEditable(); await ui.editor.fill('恢复时先输入的提示词');
  await ui.editor.press('Control+Enter');
  await expect(ui.send).toBeDisabled();
  await expect(page.getByText('正在恢复环境，可以先输入任务…', { exact: true })).toBeVisible();
  expect(ui.count('POST', '/api/projects/paused/open')).toBe(1);
  expect(ui.count('POST', '/api/sessions')).toBe(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.waitForTimeout(350);
  await expect(ui.send).toBeDisabled();
  expect(ui.calls.filter(call => call.waitForOperation)).toEqual([]);
  expect(ui.calls.find(call => call.path === '/api/projects/paused/open')?.status).toBeUndefined();
  await ui.complete('paused');
  await expect(ui.send).toBeEnabled(); await expect(ui.editor).toHaveValue('恢复时先输入的提示词');
  expect(ui.calls.find(call => call.path === '/api/projects/paused/open')?.status).toBe(200);
  expect(ui.calls.filter(call => call.waitForOperation)).toEqual([]);
});

test('project creation responds only after Sandbox preparation, then opens the ready project', async ({ page, ui }) => {
  await page.goto('/#projects'); await createThroughUI(page, '立即进入的新项目');
  await expect.poll(() => ui.count('POST', '/api/projects')).toBe(1);
  await expect(page).not.toHaveURL(/\/projects\/new$/);
  await expect(page.getByRole('form', { name: '创建项目', exact: true })).toBeVisible();
  expect(ui.calls.find(call => call.path === '/api/projects' && call.method === 'POST')?.status).toBeUndefined();
  await ui.complete('new');
  await expect(page).toHaveURL(/\/projects\/new$/);
  await expect(ui.editor).toBeEditable();
  expect(ui.projects.get('new').sandbox.status).toBe('ready');
  expect(ui.calls.find(call => call.path === '/api/projects' && call.method === 'POST')?.status).toBe(201);
  expect(ui.calls.find(call => call.path === '/api/projects/new/open')?.status).toBe(200);
});

test('restore failure stops retries; explicit retry and reload retain draft', async ({ page, ui }) => {
  await page.goto('/projects/paused'); await ui.editor.fill('恢复失败也保留');
  await expect.poll(() => ui.count('POST', '/api/projects/paused/open')).toBe(1);
  await ui.fail('paused', '恢复环境失败'); await expect(page.getByText('恢复环境失败', { exact: true })).toBeVisible();
  expect(ui.calls.find(call => call.path === '/api/projects/paused/open')?.status).toBe(500);
  // A failed completion must not issue another resume or wait request.
  await page.waitForTimeout(800); expect(ui.count('POST', '/api/projects/paused/open')).toBe(1);
  expect(ui.calls.filter(call => call.waitForOperation)).toEqual([]);
  await expect(ui.send).toBeDisabled(); await expect(ui.editor).toBeEditable();
  await page.getByRole('button', { name: '重试准备', exact: true }).click();
  await expect.poll(() => ui.count('POST', '/api/projects/paused/open')).toBe(2);
  await ui.complete('paused'); await expect(ui.send).toBeEnabled();
  await page.reload(); await expect(ui.editor).toHaveValue('恢复失败也保留');
});

test('paused session opens SSE immediately and defers native history until ready', async ({ page, ui }) => {
  await page.goto('/sessions/old-session'); await expect(ui.editor).toBeEditable(); await ui.editor.fill('旧会话恢复时输入');
  await expect.poll(() => ui.count('GET', '/api/sessions/old-session/events')).toBeGreaterThan(0);
  await page.waitForTimeout(500); expect(ui.historyReads).toHaveLength(0); await expect(ui.send).toBeDisabled();
  expect(ui.count('GET', '/api/sessions/old-session/subagents')).toBe(0);
  await expect(page.getByText('子代理对话暂时无法加载，正在自动重试。', { exact: true })).toHaveCount(0);
  await ui.complete('paused'); await expect(page.getByText('历史任务内容', { exact: true })).toBeVisible();
  await expect.poll(() => ui.count('GET', '/api/sessions/old-session/subagents')).toBeGreaterThan(0);
  await expect(ui.send).toBeEnabled(); await expect(ui.editor).toHaveValue('旧会话恢复时输入');
});

test('switching sessions inside one project does not reopen the workspace', async ({ page, ui }) => {
  await ui.complete('paused');
  await page.goto('/sessions/old-session');
  await expect.poll(() => ui.count('POST', '/api/projects/paused/open')).toBe(1);
  await expect(ui.editor).toBeEditable();

  const navigation = page.getByRole('button', { name: '打开导航', exact: true });
  if (await navigation.isVisible()) await navigation.click();
  await page.getByRole('button', { name: '同项目的另一个会话 · 暂停项目', exact: true }).click();
  await expect.poll(() => ui.count('GET', '/api/sessions/second-session/events')).toBeGreaterThan(0);
  await expect(ui.editor).toBeEditable();
  await page.waitForTimeout(300);
  expect(ui.count('POST', '/api/projects/paused/open')).toBe(1);
});

test('running conversation accepts an added message and preserves repeated input order', async ({ page, ui }) => {
  ui.setRunning();
  await ui.complete('paused');
  await page.goto('/sessions/old-session');
  await expect(page.getByText('原始任务', { exact: true })).toBeVisible();
  await expect(page.locator('.additional-user-message')).toHaveCount(2);
  await expect(page.locator('.additional-user-message').nth(0)).toContainText('相同补充');
  await expect(page.locator('.additional-user-message').nth(1)).toContainText('相同补充');
  await expect(ui.editor).toBeEditable();
  const send = page.getByRole('button', { name: '追加消息', exact: true });
  await expect(send).toBeDisabled();
  await ui.editor.fill('请同时检查这个边界情况');
  await expect(send).toBeEnabled();
  await send.click();
  await expect.poll(() => ui.submissions.length).toBe(1);
  expect(ui.submissions[0]).toEqual({ prompt: '请同时检查这个边界情况', images: [] });
  await expect(page.getByRole('button', { name: '停止任务', exact: true })).toBeVisible();
});

test('entry holds one open request through checkpoint then resume completion', async ({ page, ui }) => {
  ui.checkpoint('paused', true); await page.goto('/projects/paused');
  await expect(ui.editor).toBeEditable(); await ui.editor.fill('Checkpoint 期间输入');
  await expect.poll(() => ui.count('POST', '/api/projects/paused/open')).toBe(1);
  await expect(ui.send).toBeDisabled();
  await page.waitForTimeout(250);
  expect(ui.calls.find(call => call.path === '/api/projects/paused/open')?.status).toBeUndefined();
  expect(ui.calls.filter(call => call.waitForOperation)).toEqual([]);
  await ui.checkpoint('paused', false);
  expect(ui.count('POST', '/api/projects/paused/open')).toBe(1);
  expect(ui.projects.get('paused').sandboxOperation.kind).toBe('resume');
  expect(ui.calls.find(call => call.path === '/api/projects/paused/open')?.status).toBeUndefined();
  await ui.complete('paused'); await expect(ui.send).toBeEnabled(); await expect(ui.editor).toHaveValue('Checkpoint 期间输入');
  expect(ui.calls.find(call => call.path === '/api/projects/paused/open')?.status).toBe(200);
});

test('leaving preparation cancels only the HTTP wait and keeps separate project drafts', async ({ page, ui }) => {
  await page.goto('/projects/paused'); await ui.editor.fill('第一个项目的草稿');
  await projectList(page);
  await page.getByRole('article', { name: '另一个项目', exact: true }).getByRole('button', { name: '进入项目' }).click();
  await expect(ui.editor).toHaveValue(''); await ui.editor.fill('第二个项目的草稿');
  await expect(ui.send).toBeEnabled();
  // Cancelling the browser wait leaves the accepted durable operation intact.
  await page.waitForTimeout(300);
  expect(ui.calls.filter(call => call.waitForOperation)).toEqual([]);
  await projectList(page);
  await page.getByRole('article', { name: '暂停项目', exact: true }).getByRole('button', { name: '进入项目' }).click();
  await expect(ui.editor).toHaveValue('第一个项目的草稿'); await ui.complete('paused'); await expect(ui.send).toBeEnabled();
});

for (const withArchive of [false, true]) test(`failed mounted Sandbox rebuild explains preservation (${withArchive ? 'old archive' : 'no archive'})`, async ({ page, ui }) => {
  const project = ui.projects.get('other');
  project.sandbox.status = 'unavailable';
  if (withArchive) project.remoteArchives = [{ id: 'old-archive', createdAt: '2025-01-01T00:00:00Z', sizeBytes: 128, sha256: 'a'.repeat(64), threadIds: [] }];
  await page.goto('/#projects');
  const card = page.getByRole('article', { name: '另一个项目', exact: true });
  let confirmation;
  page.once('dialog', async dialog => { confirmation = dialog.message(); await dialog.accept(); });
  await card.getByRole('button', { name: '重建环境', exact: true }).click();
  await expect.poll(() => ui.count('POST', '/api/projects/other/sandbox/rebuild')).toBe(1);
  await ui.fail('other', '重建失败');
  expect(confirmation).toContain('保留当前挂载目录中的文件和会话历史');
  expect(confirmation).not.toContain('备份');
  expect(ui.projects.get('other').sandbox.id).toBe('other-box');
  expect(ui.projects.get('other').sandboxOperation.kind).toBe('rebuild');
  expect(ui.calls.find(call => call.path === '/api/projects/other/sandbox/rebuild')?.status).toBe(500);
  await expect(card.locator('.project-error[role="alert"]')).toContainText('重建环境失败：重建失败');

  page.once('dialog', dialog => dialog.accept());
  await card.getByRole('button', { name: '重建环境', exact: true }).click();
  await expect.poll(() => ui.count('POST', '/api/projects/other/sandbox/rebuild')).toBe(2);
  await ui.complete('other');
  await expect(card.locator('.project-status').getByText('就绪', { exact: true })).toBeVisible();
  expect(ui.calls.filter(call => call.path === '/api/projects/other/sandbox/rebuild').at(-1)?.status).toBe(200);
});
