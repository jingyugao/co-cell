import { test, expect } from './fixture.mjs';

async function openCompletedProject(page, ui) {
  ui.addCompletedProject();
  await page.goto('/#projects');
  await page.getByRole('button', { name: /^已完成 \d+$/ }).click();
  const card = page.getByRole('article', { name: '已完成项目', exact: true });
  await expect(card).toBeVisible();
  return card;
}

test('completed project card shows only restore and delete as actions', async ({ page, ui }) => {
  const card = await openCompletedProject(page, ui);
  const buttons = card.locator('.project-card-actions button');
  await expect(buttons).toHaveCount(2);
  await expect(buttons.nth(0)).toHaveText('恢复');
  await expect(buttons.nth(1)).toHaveText('删除');
  await expect(card.getByRole('button', { name: /工具权限|进入项目|恢复运行|Checkpoint|磁盘备份|归档/ })).toHaveCount(0);
  await expect(card.locator('.archive-badge')).toHaveCount(0);
});

test('restore only moves a completed project to active with PATCH', async ({ page, ui }) => {
  const card = await openCompletedProject(page, ui);
  await card.getByRole('button', { name: '恢复', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '已恢复为使用中' })).toBeVisible();
  const patch = ui.calls.filter(call => call.method === 'PATCH' && call.path === '/api/projects/completed');
  expect(patch).toHaveLength(1);
  expect(ui.projects.get('completed').status).toBe('active');
  expect(ui.calls.filter(call => call.method === 'POST' || call.method === 'DELETE')).toEqual([]);
});

test('canceling completed project deletion makes no request', async ({ page, ui }) => {
  const card = await openCompletedProject(page, ui);
  page.once('dialog', async dialog => {
    expect(dialog.message()).toContain('先将工作区磁盘数据备份到 S3');
    expect(dialog.message()).toContain('不会使用旧备份兜底');
    await dialog.dismiss();
  });
  await card.getByRole('button', { name: '删除', exact: true }).click();
  expect(ui.count('DELETE', '/api/projects/completed')).toBe(0);
  await expect(card).toBeVisible();
});

test('failed S3 backup keeps the card and sends a single delete request', async ({ page, ui }) => {
  const card = await openCompletedProject(page, ui);
  ui.failDelete('completed', 'S3 备份失败：对象存储不可用');
  page.once('dialog', dialog => dialog.accept());
  await card.getByRole('button', { name: '删除', exact: true }).click();
  await expect(card.locator('.project-operation.failed[role="alert"]').filter({ hasText: 'S3 备份失败：对象存储不可用' })).toBeVisible();
  expect(ui.count('DELETE', '/api/projects/completed')).toBe(1);
  await expect(card).toBeVisible();
  expect(ui.projects.has('completed')).toBe(true);
});

test('successful delete removes the card after the one request completes', async ({ page, ui }) => {
  const card = await openCompletedProject(page, ui);
  page.once('dialog', dialog => dialog.accept());
  await card.getByRole('button', { name: '删除', exact: true }).click();
  await expect(card).toHaveCount(0);
  expect(ui.count('DELETE', '/api/projects/completed')).toBe(1);
  expect(ui.projects.has('completed')).toBe(false);
});

test('volume snapshots show metadata without opening legacy archive browsing endpoints', async ({ page, ui }) => {
  const project = ui.projects.get('paused');
  project.archiveVersions = [
    { id: 'volume-snapshot-2', version: 2, createdAt: '2026-01-01T00:00:00Z', label: '版本 2', browsable: false, storageType: 'cellbox-volume' },
    { id: 'volume-snapshot-1', version: 1, createdAt: '2025-12-31T00:00:00Z', sizeBytes: 0, bytesAdded: 0, label: '版本 1', browsable: false, storageType: 'cellbox-volume' },
  ];
  await page.goto('/#projects');
  const card = page.getByRole('article', { name: '暂停项目', exact: true });
  const badge = card.locator('.archive-badge');
  await expect(badge).toContainText('磁盘备份');
  await expect(badge).toContainText('暂不支持文件浏览');
  await badge.hover();
  await expect(badge.locator('.archive-badge-popover')).toContainText('0 B · +0 B');
  await expect(badge.locator('button.archive-badge-entry')).toHaveCount(0);
  await badge.click();
  expect(ui.calls.filter(call => call.path.startsWith('/api/archives/'))).toEqual([]);
  await expect(page.getByRole('dialog', { name: /archive/i })).toHaveCount(0);
});

test('volume snapshot retention failure is shown on the project card', async ({ page, ui }) => {
  ui.projects.get('paused').sandboxBackup = { id: 'volume-snapshot', volumeId: 'volume-1', status: 'succeeded',
    phase: '完成', retentionError: '保留策略清理失败', updatedAt: '2026-01-01T00:00:00Z' };
  ui.projects.get('paused').backupPolicy = { enabled: true, engine: 'restic', scope: 'volume', keepLast: 2 };
  await page.goto('/#projects');
  const card = page.getByRole('article', { name: '暂停项目', exact: true });
  await expect(card.getByRole('alert').filter({ hasText: '备份已完成，但旧快照清理失败' })).toContainText('保留策略清理失败');
  await expect(card.getByText('每个磁盘保留最近 2 版', { exact: true })).toBeVisible();
});
