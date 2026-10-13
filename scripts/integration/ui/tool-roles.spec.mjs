import { test, expect } from './fixture.mjs';

const stamp = '2026-01-01T00:00:00Z';
const defaultRole = { id: '00000000-0000-4000-8000-000000000001', name: '默认角色', connections: [], createdAt: stamp, updatedAt: stamp };
const secret = (id, name, tool) => ({ id, name, tool, path: tool === 'mysql' ? '.my.cnf' : '.kube/config', format: 'text', mutable: true, enabled: true, version: 1, projectIds: [], requiresTextImport: false, createdAt: stamp, updatedAt: stamp });

test('create a role with multiple MySQL and kubectl connections, set default, and assign it to a project', async ({ page, ui }) => {
  const secrets = [secret('mysql-reporting', '报表库', 'mysql'), secret('mysql-warehouse', '数仓', 'mysql'), secret('kube-staging', '测试集群', 'kubectl')];
  let catalog = { roles: [defaultRole], defaultRoleId: defaultRole.id }, roleSave, defaultSave, projectSave;
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
      catalog = { roles: [defaultRole, role], defaultRoleId: defaultRole.id };
      return route.fulfill({ status: 201, json: role });
    }
    return route.fulfill({ json: catalog });
  });
  await page.route('**/api/projects/paused/tool-role', async route => {
    if (route.request().method() === 'PUT') { projectSave = route.request().postDataJSON(); return route.fulfill({ json: { roleId: projectSave.roleId, connections: roleSave.connections } }); }
    await route.fulfill({ json: { roleId: defaultRole.id, connections: [] } });
  });
  await page.goto('/#connections');
  await page.getByRole('button', { name: '新建角色', exact: true }).click();
  const form = page.locator('.role-form');
  await form.getByLabel('角色名称', { exact: true }).fill('数据运维');
  await expect(form.getByLabel('mysql 凭证：报表库')).not.toBeChecked();
  await expect(form.getByLabel('mysql 凭证：数仓')).not.toBeChecked();
  await expect(form.getByLabel('kubectl 凭证：测试集群')).not.toBeChecked();
  await form.getByLabel('mysql 凭证：报表库').check();
  await form.getByLabel('mysql 报表库 别名').fill('reporting');
  await form.getByLabel('mysql 凭证：数仓').check();
  await form.getByLabel('mysql 数仓 别名').fill('warehouse');
  await form.getByLabel('kubectl 凭证：测试集群').check();
  await form.getByLabel('kubectl 测试集群 别名').fill('staging');
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
  await dialog.getByRole('radio', { name: '数据运维 默认角色', exact: true }).check();
  await expect(dialog.getByText('mysql --connection=reporting', { exact: true })).toBeVisible();
  await expect(dialog.getByText('kubectl --connection=staging', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  expect(projectSave).toEqual({ roleId: 'data-ops' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('editing a role preserves aliases, allows deselection, and replaces single-connection credentials', async ({ page, ui }) => {
  const secrets = [
    secret('mysql-reporting', '报表库', 'mysql'),
    secret('mysql-warehouse', '数仓', 'mysql'),
    secret('glab-old', '旧 GitLab', 'glab'),
    secret('glab-new', '新 GitLab', 'glab'),
  ];
  const existingRole = {
    id: 'data-ops', name: '数据运维', connections: [
      { tool: 'mysql', alias: 'reporting', secretId: 'mysql-reporting' },
      { tool: 'mysql', alias: 'warehouse', secretId: 'mysql-warehouse' },
      { tool: 'glab', alias: 'gitlab', secretId: 'glab-old' },
    ], createdAt: stamp, updatedAt: stamp,
  };
  let roleSave;
  await page.route('**/api/secrets', route => route.fulfill({ json: secrets }));
  await page.route('**/api/tool-roles**', async route => {
    const request = route.request();
    if (request.method() === 'PUT') {
      roleSave = request.postDataJSON();
      return route.fulfill({ json: { ...existingRole, ...roleSave } });
    }
    await route.fulfill({ json: { roles: [defaultRole, existingRole], defaultRoleId: defaultRole.id } });
  });
  await page.goto('/#connections');
  const card = page.getByRole('article').filter({ hasText: '数据运维' });
  await card.getByRole('button', { name: '编辑角色：数据运维', exact: true }).click();
  const form = page.locator('.role-form');
  await expect(form.getByLabel('mysql 报表库 别名')).toHaveValue('reporting');
  await expect(form.getByLabel('mysql 数仓 别名')).toHaveValue('warehouse');
  await expect(form.getByLabel('glab 凭证')).toHaveValue('glab-old');
  await form.getByLabel('mysql 凭证：报表库').uncheck();
  await form.getByLabel('glab 凭证').selectOption('glab-new');
  await form.getByRole('button', { name: '保存角色', exact: true }).click();
  await expect(page.locator('.role-form')).toHaveCount(0);
  expect(roleSave).toEqual({ name: '数据运维', connections: [
    { tool: 'mysql', alias: 'warehouse', secretId: 'mysql-warehouse' },
    { tool: 'glab', alias: 'gitlab', secretId: 'glab-new' },
  ] });
});

test('role catalog load failure blocks project role saves and no legacy controls or requests remain', async ({ page, ui }) => {
  let projectSave;
  await page.route('**/api/tool-roles', route => route.fulfill({ status: 500, json: { error: '角色读取失败' } }));
  await page.route('**/api/projects/paused/tool-role', async route => {
    if (route.request().method() === 'PUT') projectSave = route.request().postDataJSON();
    await route.fulfill({ json: { roleId: defaultRole.id, connections: [] } });
  });
  await page.goto('/#projects');
  await page.getByRole('article', { name: '暂停项目', exact: true }).getByRole('button', { name: '工具权限', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '暂停项目 工具权限', exact: true });
  await expect(dialog.getByRole('alert')).toHaveText('角色读取失败');
  await expect(dialog.getByRole('button', { name: '保存', exact: true })).toBeDisabled();
  await expect(page.getByRole('radio', { name: '有', exact: true })).toHaveCount(0);
  await expect(dialog.getByText('保留现有权限', { exact: true })).toHaveCount(0);
  expect(projectSave).toBeUndefined();
  expect(ui.calls.some(call => call.path.endsWith('/tool-permissions'))).toBe(false);
});
