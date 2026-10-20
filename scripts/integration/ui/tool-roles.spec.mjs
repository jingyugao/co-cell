import { test, expect } from './fixture.mjs';

const stamp = '2026-01-01T00:00:00Z';
const defaultRole = { id: '00000000-0000-4000-8000-000000000001', name: '默认角色', permissions: [], createdAt: stamp, updatedAt: stamp };
const tool = (name, credentials, defaultCredential) => credentials
  ? { name, kind: 'tool-with-credential', credentials, ...(defaultCredential ? { defaultCredential } : {}) }
  : { name, kind: 'tool' };

test('roles configure generic tool switches and named credentials from the catalog', async ({ page, ui }) => {
  const tools = [
    tool('mysql', ['reporting', "warehouse's"], 'reporting'),
    tool('kubectl', ['staging']),
    tool('git', null),
    tool('vault-cli', ['team-a']),
  ];
  let catalog = { roles: [defaultRole], defaultRoleId: defaultRole.id }, roleSave, savedRole, projectSave;
  await page.route('**/api/secrets', route => route.fulfill({ json: [] }));
  await page.route('**/api/tools', route => route.fulfill({ json: tools }));
  await page.route('**/api/tool-roles**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path.endsWith('/default')) {
      const body = request.postDataJSON(); catalog = { ...catalog, defaultRoleId: body.roleId };
      return route.fulfill({ json: catalog });
    }
    if (request.method() === 'POST') {
      roleSave = request.postDataJSON();
      savedRole = { id: 'data-ops', name: roleSave.name, permissions: roleSave.permissions, createdAt: stamp, updatedAt: stamp };
      catalog = { roles: [defaultRole, savedRole], defaultRoleId: defaultRole.id };
      return route.fulfill({ status: 201, json: savedRole });
    }
    return route.fulfill({ json: catalog });
  });
  await page.route('**/api/projects/paused/tool-role', async route => {
    if (route.request().method() === 'PUT') { projectSave = route.request().postDataJSON(); return route.fulfill({ json: { roleId: projectSave.roleId, permissions: savedRole.permissions } }); }
    await route.fulfill({ json: { roleId: defaultRole.id, permissions: [] } });
  });
  await page.goto('/#connections');
  await page.getByRole('button', { name: '新建角色', exact: true }).click();
  const form = page.locator('.role-form');
  await form.getByLabel('角色名称', { exact: true }).fill('数据运维');
  await expect(form.locator('.role-connections-heading')).toContainText(/共享 HOME/);
  await expect(page.locator('.role-manager>.connections-heading')).toContainText(/调用时会按角色所选名称校验权限/);
  await expect(form.getByLabel('mysql 连接：reporting')).not.toBeChecked();
  await expect(form.getByLabel("mysql 连接：warehouse's")).not.toBeChecked();
  await expect(form.getByLabel('kubectl 连接：staging')).not.toBeChecked();
  await form.getByLabel('mysql 连接：reporting').check();
  await form.getByLabel("mysql 连接：warehouse's").check();
  await form.getByLabel('kubectl 连接：staging').check();
  await form.getByLabel('git 工具权限').check();
  await form.getByLabel('vault-cli 连接：team-a').check();
  await form.getByRole('button', { name: '保存角色', exact: true }).click();
  const roleCard = page.getByRole('article').filter({ hasText: '数据运维' });
  await expect(roleCard).toBeVisible();
  await expect(roleCard.getByText('reporting', { exact: true })).toBeVisible();
  await expect(roleCard.getByText("warehouse's", { exact: true })).toBeVisible();
  await expect(roleCard.getByText('team-a', { exact: true })).toBeVisible();
  expect(roleSave).toEqual({ name: '数据运维', permissions: [
    { tool: 'mysql', enabled: true, credentials: ['reporting', "warehouse's"] },
    { tool: 'kubectl', enabled: true, credentials: ['staging'] },
    { tool: 'git', enabled: true },
    { tool: 'vault-cli', enabled: true, credentials: ['team-a'] },
  ] });
  await roleCard.getByRole('button', { name: '设为默认', exact: true }).click();
  await page.goto('/#projects');
  await page.getByRole('article', { name: '暂停项目', exact: true }).getByRole('button', { name: '工具权限', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '暂停项目 工具权限', exact: true });
  await dialog.getByRole('radio', { name: '数据运维 默认角色', exact: true }).check();
  await expect(dialog.getByText('vault-cli', { exact: true })).toBeVisible();
  await expect(dialog.getByText("warehouse's", { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  expect(projectSave).toEqual({ roleId: 'data-ops' });
  await page.setViewportSize({ width: 375, height: 812 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(ui.calls.some(call => call.path.endsWith('/tool-permissions'))).toBe(false);
});

test('editing removes vanished credentials explicitly and disables a credential tool when selection is empty', async ({ page }) => {
  const tools = [tool('mysql', ['reporting', 'warehouse']), tool('git', null), tool('vault-cli', ['team-a'])];
  const existingRole = { id: 'data-ops', name: '数据运维', permissions: [
    { tool: 'mysql', enabled: true, credentials: ['reporting', 'retired-db'] },
    { tool: 'git', enabled: true },
    { tool: 'vault-cli', enabled: true, credentials: ['team-a'] },
    { tool: 'retired-tool', enabled: true },
  ], createdAt: stamp, updatedAt: stamp };
  let roleSave;
  let catalog = { roles: [defaultRole, existingRole], defaultRoleId: defaultRole.id };
  await page.route('**/api/secrets', route => route.fulfill({ json: [] }));
  await page.route('**/api/tools', route => route.fulfill({ json: tools }));
  await page.route('**/api/tool-roles**', async route => {
    if (route.request().method() === 'PUT') {
      roleSave = route.request().postDataJSON();
      const saved = { ...existingRole, ...roleSave, updatedAt: '2026-01-02T00:00:00Z' };
      catalog = { ...catalog, roles: [defaultRole, saved] };
      return route.fulfill({ json: saved });
    }
    await route.fulfill({ json: catalog });
  });
  await page.goto('/#connections');
  const card = page.getByRole('article').filter({ hasText: '数据运维' });
  await card.getByRole('button', { name: '编辑角色：数据运维', exact: true }).click();
  const form = page.locator('.role-form');
  await expect(form.getByLabel('mysql 连接：reporting')).toBeChecked();
  await expect(form.getByText('retired-db · 连接已不存在', { exact: true })).toBeVisible();
  await expect(form.getByLabel('vault-cli 连接：team-a')).toBeChecked();
  await expect(form.getByLabel('保留原有权限')).toBeChecked();
  await form.getByRole('button', { name: '移除 mysql 连接：retired-db', exact: true }).click();
  await expect(form.getByText('retired-db · 连接已不存在', { exact: true })).toHaveCount(0);
  await form.getByLabel('mysql 连接：reporting').uncheck();
  await form.getByLabel('git 工具权限').uncheck();
  await form.getByLabel('保留原有权限').uncheck();
  await form.getByRole('button', { name: '保存角色', exact: true }).click();
  expect(roleSave).toEqual({ name: '数据运维', permissions: [
    { tool: 'mysql', enabled: false, credentials: [] },
    { tool: 'git', enabled: false },
    { tool: 'vault-cli', enabled: true, credentials: ['team-a'] },
  ] });
});

test('role and tool catalog failures block saves in both role and project permission editors', async ({ page, ui }) => {
  let failRoleCatalog = false, failToolCatalog = true, saveCalls = 0;
  await page.route('**/api/secrets', route => route.fulfill({ json: [] }));
  await page.route('**/api/tools', route => failToolCatalog
    ? route.fulfill({ status: 500, json: { error: '工具目录读取失败' } })
    : route.fulfill({ json: [tool('git', null)] }));
  await page.route('**/api/tool-roles', route => failRoleCatalog
    ? route.fulfill({ status: 500, json: { error: '角色读取失败' } })
    : route.fulfill({ json: { roles: [defaultRole], defaultRoleId: defaultRole.id } }));
  await page.route('**/api/tool-roles/**', async route => {
    if (route.request().method() !== 'GET') saveCalls++;
    await route.fulfill({ status: 500, json: { error: '不应保存' } });
  });
  await page.route('**/api/projects/paused/tool-role', async route => {
    if (route.request().method() === 'PUT') saveCalls++;
    await route.fulfill({ status: 200, json: { roleId: defaultRole.id, permissions: [] } });
  });
  await page.goto('/#connections');
  await expect(page.getByRole('alert')).toHaveText('工具目录读取失败');
  await expect(page.getByRole('button', { name: '新建角色', exact: true })).toBeDisabled();
  expect(saveCalls).toBe(0);

  failToolCatalog = false; failRoleCatalog = true;
  await page.goto('/#connections');
  await expect(page.getByRole('alert')).toHaveText('角色读取失败');
  await expect(page.getByRole('button', { name: '新建角色', exact: true })).toBeDisabled();
  expect(saveCalls).toBe(0);

  await page.goto('/#projects');
  await page.getByRole('article', { name: '暂停项目', exact: true }).getByRole('button', { name: '工具权限', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: '暂停项目 工具权限', exact: true });
  await expect(dialog.getByRole('alert')).toHaveText('角色读取失败');
  await expect(dialog.getByRole('button', { name: '保存', exact: true })).toBeDisabled();
  await expect(dialog.getByRole('radio')).toHaveCount(0);
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();

  failRoleCatalog = false; failToolCatalog = true;
  await page.getByRole('article', { name: '暂停项目', exact: true }).getByRole('button', { name: '工具权限', exact: true }).click();
  dialog = page.getByRole('dialog', { name: '暂停项目 工具权限', exact: true });
  await expect(dialog.getByRole('alert')).toHaveText('工具目录读取失败');
  await expect(dialog.getByRole('button', { name: '保存', exact: true })).toBeDisabled();
  expect(saveCalls).toBe(0);
  expect(ui.calls.some(call => call.path.endsWith('/tool-permissions'))).toBe(false);
});
