import { test, expect } from './fixture.mjs';

test('manual archive can be cancelled and moves a paused project into archives without opening it', async ({ page, ui }) => {
  await page.goto('/#projects');
  const card = page.getByRole('article', { name: '暂停项目', exact: true });
  page.once('dialog', async dialog => {
    expect(dialog.message()).toContain('暂停中的项目不会恢复运行');
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

test('failed sandbox manual archive requires explicit use of its dated successful backup', async ({ page, ui }) => {
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
  await page.getByRole('article', { name: '暂停项目', exact: true }).getByRole('button', { name: '手动归档', exact: true }).click();
  await expect.poll(() => input).toEqual({ useExistingBackup: true });
  await expect(page.getByText('「暂停项目」已归档，可在“归档”页查看。', { exact: true })).toBeVisible();
});

test('failed archive cleanup keeps its retry action and resumes the verified cleanup journal', async ({ page, ui }) => {
  const project = ui.projects.get('paused');
  project.status = 'completed';
  delete project.sandbox;
  project.archiveCleanupSourceId = 'paused-box';
  project.sandboxOperation = { kind: 'archive', status: 'failed', phase: '清理环境', error: '清理失败', updatedAt: '2026-01-01T00:00:00Z' };
  let attempts = 0, input;
  await page.route('**/api/projects/paused/archive', async route => {
    input = route.request().postDataJSON();
    if (++attempts === 1) await route.fulfill({ status: 503, json: { error: '归档环境尚未清理完成，请重试' } });
    else await route.fallback();
  });
  await page.goto('/#projects');
  await page.getByRole('button', { name: /^已完成 \d+$/ }).click();
  const retry = page.getByRole('article', { name: '暂停项目', exact: true }).getByRole('button', { name: '重试归档', exact: true });
  page.once('dialog', dialog => dialog.accept());
  await retry.click();
  await expect(page.getByText('归档失败：归档环境尚未清理完成，请重试', { exact: true })).toBeVisible();
  await expect(retry).toBeEnabled();
  expect(input).toEqual({});
  page.once('dialog', dialog => dialog.accept());
  await retry.click();
  await expect(page.getByText('「暂停项目」已归档，可在“归档”页查看。', { exact: true })).toBeVisible();
  expect(attempts).toBe(2);
});

test('manual archive is unavailable without a backup for a failed sandbox and during active work', async ({ page, ui }) => {
  ui.projects.get('paused').sandbox.status = 'unavailable';
  ui.projects.get('other').activeSessionId = 'running-session';
  await page.goto('/#projects');
  const broken = page.getByRole('article', { name: '暂停项目', exact: true });
  await expect(broken.getByRole('button', { name: '手动归档', exact: true })).toBeDisabled();
  await expect(broken.getByText('当前环境无法生成新备份，且没有成功备份；请先恢复环境并备份后再归档。', { exact: true })).toBeVisible();
  await expect(page.getByRole('article', { name: '另一个项目', exact: true }).getByRole('button', { name: '手动归档', exact: true })).toBeDisabled();
});
