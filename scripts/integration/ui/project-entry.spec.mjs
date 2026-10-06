import { test, expect, createThroughUI, projectList } from './fixture.mjs';

test('marking a checkpointed project completed keeps it paused and explains automatic archiving', async ({ page, ui }) => {
  await page.goto('/#projects');
  await page.getByRole('article', { name: '暂停项目', exact: true }).getByRole('button', { name: '标记已完成', exact: true }).click();
  await page.getByRole('button', { name: /^已完成 \d+$/ }).click();
  const card = page.getByRole('article', { name: '暂停项目', exact: true });
  await expect(card.getByRole('button', { name: '恢复使用中', exact: true })).toBeVisible();
  await expect(card.getByText('有可用归档备份时，完成满 1 天后会保留已有备份并清理暂停环境，不恢复运行。', { exact: true })).toBeVisible();
  expect(ui.projects.get('paused').status).toBe('completed');
  expect(ui.projects.get('paused').sandbox.status).toBe('paused');
  expect(ui.calls.filter(call => call.method === 'POST')).toEqual([]);
});

test('paused entry permits drafting while one resume is pending', async ({ page, ui }) => {
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
  await expect.poll(() => ui.calls.filter(call => call.path === '/api/projects/paused'
    && call.waitForOperation === ui.projects.get('paused').sandboxOperation.id).length).toBe(1);
  // Runtime ready can precede unquiesce and the durable operation result.
  ui.projects.get('paused').sandbox.status = 'ready';
  await page.waitForTimeout(350);
  await expect(ui.send).toBeDisabled();
  expect(ui.count('GET', '/api/projects/paused')).toBe(1);
  ui.complete('paused');
  await expect(ui.send).toBeEnabled(); await expect(ui.editor).toHaveValue('恢复时先输入的提示词');
  expect(ui.count('GET', '/api/projects/paused')).toBe(1);
});

test('create opens before binding; failure and explicit retry preserve draft', async ({ page, ui }) => {
  await page.goto('/#projects'); await createThroughUI(page, '立即进入的新项目');
  await expect(page).toHaveURL(/\/projects\/new$/);
  await expect(ui.editor).toBeEditable(); await ui.editor.fill('创建期间写好的草稿');
  expect(ui.projects.get('new').sandbox).toBeUndefined(); await expect(ui.send).toBeDisabled();
  ui.fail('new', '创建环境失败'); await expect(page.getByText('创建环境失败', { exact: true })).toBeVisible();
  await expect(ui.editor).toHaveValue('创建期间写好的草稿');
  await page.getByRole('button', { name: '重试准备', exact: true }).click();
  await expect.poll(() => ui.count('POST', '/api/projects/new/sandbox/rebuild')).toBe(1);
  ui.complete('new'); await expect(ui.send).toBeEnabled(); await expect(ui.editor).toHaveValue('创建期间写好的草稿');
});

test('restore failure stops retries; explicit retry and reload retain draft', async ({ page, ui }) => {
  await page.goto('/projects/paused'); await ui.editor.fill('恢复失败也保留');
  await expect.poll(() => ui.count('POST', '/api/projects/paused/open')).toBe(1);
  ui.fail('paused', '恢复环境失败'); await expect(page.getByText('恢复环境失败', { exact: true })).toBeVisible();
  // A failed completion must not issue another resume or wait request.
  await page.waitForTimeout(800); expect(ui.count('POST', '/api/projects/paused/open')).toBe(1);
  await expect(ui.send).toBeDisabled(); await expect(ui.editor).toBeEditable();
  await page.getByRole('button', { name: '重试准备', exact: true }).click();
  await expect.poll(() => ui.count('POST', '/api/projects/paused/open')).toBe(2);
  ui.complete('paused'); await expect(ui.send).toBeEnabled();
  await page.reload(); await expect(ui.editor).toHaveValue('恢复失败也保留');
});

test('paused session opens SSE immediately and defers native history until ready', async ({ page, ui }) => {
  await page.goto('/sessions/old-session'); await expect(ui.editor).toBeEditable(); await ui.editor.fill('旧会话恢复时输入');
  await expect.poll(() => ui.count('GET', '/api/sessions/old-session/events')).toBeGreaterThan(0);
  await page.waitForTimeout(500); expect(ui.historyReads).toHaveLength(0); await expect(ui.send).toBeDisabled();
  ui.complete('paused'); await expect(page.getByText('历史任务内容', { exact: true })).toBeVisible();
  await expect(ui.send).toBeEnabled(); await expect(ui.editor).toHaveValue('旧会话恢复时输入');
});

test('entry joins checkpoint then resumes once after checkpoint completes', async ({ page, ui }) => {
  ui.checkpoint('paused', true); await page.goto('/projects/paused');
  await expect(ui.editor).toBeEditable(); await ui.editor.fill('Checkpoint 期间输入');
  await expect.poll(() => ui.count('POST', '/api/projects/paused/open')).toBe(1);
  await expect(ui.send).toBeDisabled(); ui.checkpoint('paused', false);
  await expect.poll(() => ui.count('POST', '/api/projects/paused/open')).toBe(2);
  expect(ui.projects.get('paused').sandboxOperation.kind).toBe('resume');
  ui.complete('paused'); await expect(ui.send).toBeEnabled(); await expect(ui.editor).toHaveValue('Checkpoint 期间输入');
});

test('leaving preparation cancels polling and keeps separate project drafts', async ({ page, ui }) => {
  await page.goto('/projects/paused'); await ui.editor.fill('第一个项目的草稿');
  await projectList(page);
  await page.getByRole('article', { name: '另一个项目', exact: true }).getByRole('button', { name: '进入项目' }).click();
  await expect(ui.editor).toHaveValue(''); await ui.editor.fill('第二个项目的草稿');
  await expect(ui.send).toBeEnabled();
  // Allow an already issued request to settle, then verify no further polling.
  await page.waitForTimeout(300); const reads = ui.count('GET', '/api/projects/paused');
  await page.waitForTimeout(600); expect(ui.count('GET', '/api/projects/paused')).toBe(reads);
  await projectList(page);
  await page.getByRole('article', { name: '暂停项目', exact: true }).getByRole('button', { name: '进入项目' }).click();
  await expect(ui.editor).toHaveValue('第一个项目的草稿'); ui.complete('paused'); await expect(ui.send).toBeEnabled();
});
