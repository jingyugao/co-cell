import { test, expect, createThroughUI, projectList } from './fixture.mjs';

test('marking a checkpointed project completed keeps it paused and retains disk and checkpoint', async ({ page, ui }) => {
  await page.goto('/#projects');
  await page.getByRole('article', { name: '暂停项目', exact: true }).getByRole('button', { name: '标记已完成', exact: true }).click();
  await page.getByRole('button', { name: /^已完成 \d+$/ }).click();
  const card = page.getByRole('article', { name: '暂停项目', exact: true });
  await expect(card.getByRole('button', { name: '恢复使用中', exact: true })).toBeVisible();
  await expect(card.getByText('磁盘和 Checkpoint 已保留。恢复为使用中后，进入项目即可继续。', { exact: true })).toBeVisible();
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
  expect(confirmation).toContain('保留当前挂载目录中的文件和会话历史');
  expect(confirmation).not.toContain('备份');
  expect(ui.projects.get('other').sandbox.id).toBe('other-box');
  expect(ui.projects.get('other').sandboxOperation.kind).toBe('rebuild');
  ui.complete('other');
  await expect(card.locator('.project-status').getByText('就绪', { exact: true })).toBeVisible();
});

test('image version popover confirms upgrades and keeps backup actions secondary', async ({ page, ui, isMobile }) => {
  const project = ui.projects.get('other');
  project.imageSelection = { imageId: 'managed', imageName: 'mybox', versionId: 'v1', version: '1.0.2', image: 'old', importedImageId: 'old' };
  ui.images.push({ id: 'managed', name: 'mybox', category: 'test', origin: 'managed', defaultVersionId: 'v1', versions: [
    { id: 'v1', version: '1.0.2', status: 'succeeded', projectReady: true, createdAt: '2026-02-01T00:00:00Z' },
    { id: 'v2', version: '1.0.3', status: 'succeeded', projectReady: true, createdAt: '2026-01-01T00:00:00Z' },
    { id: 'bad', version: '1.0.4', status: 'failed', createdAt: '2026-03-01T00:00:00Z' },
  ] });
  await page.goto('/#projects');
  const card = page.getByRole('article', { name: '另一个项目', exact: true });
  await expect(card.getByRole('button', { name: '立即备份', exact: true })).toBeHidden();
  const trigger = card.getByRole('button', { name: 'mybox · 1.0.2，查看版本', exact: true });
  if (isMobile) await trigger.click(); else await trigger.hover();
  const versions = page.getByRole('region', { name: '镜像版本列表' });
  await expect(versions.getByRole('button').first()).toHaveText('1.0.3最新');
  await expect(versions.getByRole('button', { name: /1.0.2/ })).toBeDisabled();
  await expect(versions.getByText('1.0.4')).toHaveCount(0);
  await versions.getByRole('button', { name: /1.0.3/ }).click();
  const dialog = page.getByRole('dialog', { name: '升级项目镜像' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('保留挂载磁盘中的最新文件和会话历史');
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  expect(ui.count('POST', '/api/projects/other/sandbox/upgrade')).toBe(0);
  await trigger.click();
  await versions.getByRole('button', { name: /1.0.3/ }).click();
  await dialog.getByRole('button', { name: '确认升级', exact: true }).click();
  await expect.poll(() => ui.count('POST', '/api/projects/other/sandbox/upgrade')).toBe(1);
  expect(project.selectedUpgrade).toBe('v2');
  expect(ui.count('POST', '/api/projects/other/archive')).toBe(0);
  expect(ui.count('POST', '/api/projects/other/backup')).toBe(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('latest image version is identified independently from repository default', async ({ page, ui }) => {
  const project = ui.projects.get('other');
  project.imageSelection = { imageId: 'managed', imageName: 'mybox', versionId: 'v3', version: '1.0.10', image: 'new', importedImageId: 'new' };
  ui.images.push({ id: 'managed', name: 'mybox', category: 'test', origin: 'managed', defaultVersionId: 'v2', versions: [
    { id: 'v2', version: '1.0.9', status: 'succeeded', createdAt: '2026-02-01T00:00:00Z' },
    { id: 'v3', version: '1.0.10', status: 'succeeded', createdAt: '2026-01-01T00:00:00Z' },
  ] });
  await page.goto('/#projects');
  await page.getByRole('button', { name: 'mybox · 1.0.10，查看版本', exact: true }).click();
  const versions = page.getByRole('region', { name: '镜像版本列表' });
  await expect(versions.getByText('当前已是最新可用版本')).toBeVisible();
  await expect(versions.getByRole('button').first()).toHaveText('1.0.10当前最新');
  await expect(versions.getByRole('button').first()).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(versions).toBeHidden();
  expect(ui.count('POST', '/api/projects/other/sandbox/upgrade')).toBe(0);
});
