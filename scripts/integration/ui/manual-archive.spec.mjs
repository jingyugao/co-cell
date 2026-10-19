import { test, expect } from './fixture.mjs';

test('manual archive confirms persistent disk backup and moves a paused project into archives without opening it', async ({ page, ui }) => {
  await page.goto('/#projects');
  const card = page.getByRole('article', { name: '暂停项目', exact: true });
  page.once('dialog', async dialog => {
    expect(dialog.message()).toContain('备份已暂停的工作区');
    expect(dialog.message()).toContain('不支持跳过 Checkpoint');
    await dialog.dismiss();
  });
  await card.getByRole('button', { name: '手动归档', exact: true }).click();
  expect(ui.count('POST', '/api/projects/paused/archive')).toBe(0);
  let input;
  page.on('request', request => { if (request.url().endsWith('/api/projects/paused/archive')) input = request.postDataJSON(); });
  page.once('dialog', dialog => dialog.accept());
  await card.getByRole('button', { name: '手动归档', exact: true }).click();
  await expect(page.getByText('「暂停项目」已归档，可在“归档”页查看。', { exact: true })).toBeVisible();
  expect(input).toEqual({});
  expect(ui.count('POST', '/api/projects/paused/open')).toBe(0);
  await page.getByRole('button', { name: /^归档 \d+$/ }).click();
  await expect(card.getByText('已归档', { exact: true })).toBeVisible();
  await expect(card.getByRole('button', { name: '手动归档', exact: true })).toHaveCount(0);
});

test('failed sandbox offers an explicit dated-backup archive path', async ({ page, ui }) => {
  const project = ui.projects.get('paused');
  project.sandbox.status = 'unavailable';
  project.latestBackup = { createdAt: '2026-01-01T00:00:00Z', sizeBytes: 42, sha256: 'a'.repeat(64) };
  let input;
  page.on('request', request => { if (request.url().endsWith('/api/projects/paused/archive')) input = request.postDataJSON(); });
  await page.goto('/#projects');
  page.once('dialog', async dialog => {
    expect(dialog.message()).toContain('2026');
    expect(dialog.message()).toContain('未备份的数据不会保存');
    await dialog.accept();
  });
  await page.getByRole('article', { name: '暂停项目', exact: true }).getByRole('button', { name: '使用已有备份归档', exact: true }).click();
  await expect.poll(() => input).toEqual({ useExistingBackup: true });
  await expect(page.getByText('「暂停项目」已归档，可在“归档”页查看。', { exact: true })).toBeVisible();
});

test('completed disk archive reports cleanup pending and exposes a user-controlled cleanup retry', async ({ page, ui }) => {
  const project = ui.projects.get('paused');
  project.latestBackup = { createdAt: '2026-01-01T00:00:00Z', sizeBytes: 42, sha256: 'a'.repeat(64) };
  let attempts = 0, input;
  await page.route('**/api/projects/paused/archive', async route => {
    input = route.request().postDataJSON();
    if (++attempts === 1) {
      project.status = 'archived';
      project.archivedAt = '2026-01-01T00:00:00Z';
      project.archiveCleanupSourceId = 'paused-box';
      delete project.sandbox;
      project.sandboxOperation = { kind: 'archive', status: 'succeeded', phase: '归档已完成，清理待重试', cleanupError: 'Cellbox 清理超时', updatedAt: '2026-01-01T00:00:00Z' };
      await route.fulfill({ status: 200, json: project });
    } else await route.fallback();
  });
  await page.goto('/#projects');
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('article', { name: '暂停项目', exact: true }).getByRole('button', { name: '手动归档', exact: true }).click();
  await expect(page.getByText('「暂停项目」已归档，可在“归档”页查看。', { exact: true })).toBeVisible();
  expect(input).toEqual({});
  await page.getByRole('button', { name: /^归档 \d+$/ }).click();
  await expect(page.getByText('已归档，环境清理待重试', { exact: true })).toBeVisible();
  await expect(page.getByText('Cellbox 清理超时', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '重试清理', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: '恢复项目', exact: true })).toBeDisabled();
  const retry = page.getByRole('article', { name: '暂停项目', exact: true }).getByRole('button', { name: '重试清理', exact: true });
  page.once('dialog', dialog => dialog.accept());
  await retry.click();
  await expect(page.getByText('「暂停项目」已归档，可在“归档”页查看。', { exact: true })).toBeVisible();
  await expect(page.getByText('已归档，环境清理待重试', { exact: true })).toHaveCount(0);
  await expect(retry).toHaveCount(0);
  expect(input).toEqual({});
  expect(attempts).toBe(2);
});

test('archive from a broken runtime is disabled while running work still permits project inspection', async ({ page, ui }) => {
  ui.projects.get('paused').sandbox.status = 'unavailable';
  ui.projects.get('other').activeSessionId = 'running-session';
  ui.projects.get('other').sandboxOperation = { id: 'checkpoint-op', kind: 'checkpoint', status: 'running', phase: '暂停中', updatedAt: '2026-01-01T00:00:00Z' };
  ui.projects.set('missing', { ...ui.projects.get('other'), id: 'missing', name: '无Sandbox项目', activeSessionId: null, sandbox: undefined, sandboxOperation: undefined });
  await page.goto('/#projects');
  const broken = page.getByRole('article', { name: '暂停项目', exact: true });
  await expect(broken.getByRole('button', { name: '手动归档', exact: true })).toBeDisabled();
  await expect(broken.getByRole('button', { name: '手动归档', exact: true })).toHaveAttribute('title', '请先暂停后归档，或明确选择使用已有备份');
  const active = page.getByRole('article', { name: '另一个项目', exact: true });
  await expect(active.getByRole('button', { name: '手动归档', exact: true })).toBeDisabled();
  await expect(active.getByRole('button', { name: '进入项目', exact: true })).toBeEnabled();
  await expect(active.getByRole('button', { name: '工具权限', exact: true })).toBeEnabled();
  const missing = page.getByRole('article', { name: '无Sandbox项目', exact: true });
  await expect(missing.getByRole('button', { name: '手动归档', exact: true })).toBeDisabled();
  await expect(missing.getByText('当前没有 Sandbox，也没有成功备份，暂时无法归档。', { exact: true })).toBeVisible();
});
