import { test, expect } from './fixture.mjs';

const stamp = '2026-01-01T00:00:00Z';
const secret = (id, name, tool) => ({ id, name, tool, path: tool === 'mysql' ? '.my.cnf' : '.kube/config', format: 'text', mutable: true, enabled: true, version: 1, projectIds: [], requiresTextImport: false, createdAt: stamp, updatedAt: stamp });

test('create a role with multiple MySQL and kubectl connections, set default, and assign it to a project', async ({ page, ui }) => {
  const secrets = [secret('mysql-reporting', '报表库', 'mysql'), secret('mysql-warehouse', '数仓', 'mysql'), secret('kube-staging', '测试集群', 'kubectl')];
  let catalog = { roles: [], defaultRoleId: null }, roleSave, defaultSave, projectSave;
  await page.route('**/api/secrets', route => route.fulfill({ json: secrets }));
  await page.route('**/api/tool-roles**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path.endsWith('/default')) {
      defaultSave = request.postDataJSON(); catalog = { ...catalog, defaultRoleId: defaultSave.roleId };
      return route.fulfill({ json: catalog });
    }
    if (request.method() === 'POST') {
      roleSave = request.postDataJSON();
      const role = { id: 'data-ops', ...roleSave, createdAt: stamp, updatedAt: stamp };
      catalog = { roles: [role], defaultRoleId: null };
      return route.fulfill({ status: 201, json: role });
    }
    return route.fulfill({ json: catalog });
  });
  await page.route('**/api/projects/paused/tool-role', async route => {
    if (route.request().method() === 'PUT') { projectSave = route.request().postDataJSON(); return route.fulfill({ json: { roleId: projectSave.roleId, legacy: false, connections: roleSave.connections } }); }
    await route.fulfill({ json: { roleId: null, legacy: false, connections: [] } });
  });
  await page.goto('/#connections');
  await page.getByRole('button', { name: '新建角色', exact: true }).click();
  const form = page.locator('.role-form');
  await form.getByLabel('角色名称', { exact: true }).fill('数据运维');
  await form.getByLabel('连接 1 工具').selectOption('mysql');
  await form.getByLabel('连接 1 别名').fill('reporting');
  await form.getByLabel('连接 1 认证 Secret').selectOption('mysql-reporting');
  await form.getByRole('button', { name: '添加连接', exact: true }).click();
  await form.getByLabel('连接 2 工具').selectOption('mysql');
  await form.getByLabel('连接 2 别名').fill('warehouse');
  await form.getByLabel('连接 2 认证 Secret').selectOption('mysql-warehouse');
  await form.getByRole('button', { name: '添加连接', exact: true }).click();
  await form.getByLabel('连接 3 工具').selectOption('kubectl');
  await form.getByLabel('连接 3 别名').fill('staging');
  await form.getByLabel('连接 3 认证 Secret').selectOption('kube-staging');
  await form.getByRole('button', { name: '保存角色', exact: true }).click();
  await expect(page.getByRole('article').filter({ hasText: '数据运维' })).toBeVisible();
  expect(roleSave).toEqual({ name: '数据运维', connections: [
    { tool: 'mysql', alias: 'reporting', secretId: 'mysql-reporting' },
    { tool: 'mysql', alias: 'warehouse', secretId: 'mysql-warehouse' },
    { tool: 'kubectl', alias: 'staging', secretId: 'kube-staging' },
  ] });
  await page.getByRole('article').filter({ hasText: '数据运维' }).getByRole('button', { name: '设为默认', exact: true }).click();
  expect(defaultSave).toEqual({ roleId: 'data-ops' });
  await page.goto('/#projects');
  await page.getByRole('article', { name: '暂停项目', exact: true }).getByRole('button', { name: '工具权限', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '暂停项目 工具权限', exact: true });
  await dialog.getByRole('radio', { name: '数据运维 仅新项目默认', exact: true }).check();
  await expect(dialog.getByText('mysql --connection=reporting', { exact: true })).toBeVisible();
  await expect(dialog.getByText('kubectl --connection=staging', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  expect(projectSave).toEqual({ roleId: 'data-ops' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('role catalog load failure blocks project permission saves without falling back to legacy grants', async ({ page, ui }) => {
  let projectSave;
  await page.route('**/api/tool-roles', route => route.fulfill({ status: 500, json: { error: '角色读取失败' } }));
  await page.route('**/api/projects/paused/tool-role', async route => {
    if (route.request().method() === 'PUT') projectSave = route.request().postDataJSON();
    await route.fulfill({ json: { roleId: null, legacy: false, connections: [] } });
  });
  await page.goto('/#projects');
  await page.getByRole('article', { name: '暂停项目', exact: true }).getByRole('button', { name: '工具权限', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '暂停项目 工具权限', exact: true });
  await expect(dialog.getByRole('alert')).toHaveText('角色读取失败');
  await expect(dialog.getByRole('button', { name: '保存', exact: true })).toBeDisabled();
  await expect(page.getByRole('radio', { name: '有', exact: true })).toHaveCount(0);
  expect(projectSave).toBeUndefined();
});
