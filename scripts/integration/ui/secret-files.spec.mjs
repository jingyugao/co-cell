import { test, expect } from './fixture.mjs';

test('one native credential file preserves uploaded text and binds to its project tool', async ({ page, ui }) => {
  const name = '原生认证文件', original = '\uFEFFapiVersion: v1\r\ncurrent-context: fixture\r\n';
  let saved, payload, selection, enabled = false, edits = [];
  await page.route('**/api/secrets**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path.endsWith('/content')) return route.fulfill({ json: { format: 'text', content: payload.content, requiresTextImport: false, version: 1 } });
    if (request.method() === 'POST') {
      payload = request.postDataJSON();
      saved = { id: 'native-file', ...payload, enabled: true, version: 1, projectIds: [], requiresTextImport: false, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' };
      return route.fulfill({ status: 201, json: saved });
    }
    if (request.method() === 'PATCH') { const edit = request.postDataJSON(); edits.push(edit); saved = { ...saved, ...edit }; return route.fulfill({ json: saved }); }
    await route.fulfill({ json: saved ? [saved] : [] });
  });
  await page.route('**/api/projects/paused/tool-permissions', async route => {
    if (route.request().method() === 'PUT') { selection = route.request().postDataJSON(); enabled = selection.permissions[0].enabled; }
    await route.fulfill({ json: [{ tool: 'kubectl', enabled, available: true }] });
  });
  await page.goto('/#connections');
  await page.getByRole('button', { name: '新建 Secret', exact: true }).click();
  await page.getByLabel('名称', { exact: true }).fill(name);
  await page.getByLabel('工具名', { exact: true }).fill('kubectl');
  await page.getByLabel('认证文件路径', { exact: true }).fill('.kube/config');
  await page.getByLabel('上传文件', { exact: true }).setInputFiles({ name: 'config', mimeType: 'text/yaml', buffer: Buffer.from(original) });
  await expect(page.getByRole('textbox', { name: '认证内容', exact: true })).toHaveValue(original.replaceAll('\r\n', '\n'));
  await expect(page.getByRole('combobox', { name: '认证方式', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByText(name, { exact: true })).toBeVisible();
  expect(payload.format).toBe('text'); expect(payload.content).toBe(original); expect(payload.files).toBeUndefined();
  expect(payload.path).toBe('.kube/config');
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await page.getByLabel('名称', { exact: true }).fill(name + ' 改名');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByText(name + ' 改名', { exact: true })).toBeVisible();
  expect(edits[0].content).toBeUndefined(); expect(edits[0].format).toBeUndefined();
  await page.goto('/#projects');
  await page.getByRole('article', { name: '暂停项目', exact: true }).getByRole('button', { name: '工具权限', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '暂停项目 工具权限', exact: true });
  const group = dialog.getByRole('group', { name: 'kubectl', exact: true });
  await expect(group.getByRole('radio', { name: '无', exact: true })).toBeChecked();
  await expect(group.getByRole('radio')).toHaveCount(2);
  await expect(dialog.getByText(name + ' 改名', { exact: true })).toHaveCount(0);
  await group.getByRole('radio', { name: '有', exact: true }).check();
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(selection).toEqual({ permissions: [{ tool: 'kubectl', enabled: true }] });
  await page.getByRole('article', { name: '暂停项目', exact: true }).getByRole('button', { name: '工具权限', exact: true }).click();
  await expect(group.getByRole('radio', { name: '有', exact: true })).toBeChecked();
  await group.getByRole('radio', { name: '无', exact: true }).check();
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(selection).toEqual({ permissions: [{ tool: 'kubectl', enabled: false }] });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('permission load failure prevents saving, and unconfigured tools can only have no access', async ({ page, ui }) => {
  let fail = true, payload;
  await page.route('**/api/projects/paused/tool-permissions', async route => {
    if (route.request().method() === 'PUT') { payload = route.request().postDataJSON(); return route.fulfill({ json: [] }); }
    if (fail) return route.fulfill({ status: 500, json: { error: '权限读取失败' } });
    await route.fulfill({ json: [{ tool: 'kubectl', enabled: true, available: true }, { tool: 'mysql', enabled: false, available: false, reason: '请先在 Secret 管理中配置此工具的单文件凭证' }] });
  });
  await page.goto('/#projects');
  const open = page.getByRole('article', { name: '暂停项目', exact: true }).getByRole('button', { name: '工具权限', exact: true });
  await open.click();
  const dialog = page.getByRole('dialog', { name: '暂停项目 工具权限', exact: true });
  await expect(dialog.getByRole('alert')).toHaveText('权限读取失败');
  await expect(dialog.getByRole('button', { name: '保存', exact: true })).toBeDisabled();
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  fail = false; await open.click();
  const missing = dialog.getByRole('group', { name: 'mysql', exact: true });
  await expect(missing.getByRole('radio', { name: '有', exact: true })).toBeDisabled();
  await expect(missing.getByRole('radio', { name: '无', exact: true })).toBeChecked();
  await expect(dialog.getByRole('group', { name: 'kubectl', exact: true }).getByRole('radio', { name: '有', exact: true })).toBeChecked();
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(payload).toEqual({ permissions: [{ tool: 'kubectl', enabled: true }, { tool: 'mysql', enabled: false }] });
});

test('legacy file groups require explicit single-file import and binary uploads are rejected', async ({ page, ui }) => {
  const old = { id: 'legacy-group', name: '旧文件组', tool: 'custom.cli', path: 'auth.txt', format: 'files', mutable: true, enabled: true, version: 1, projectIds: [], requiresTextImport: true, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' };
  let updated;
  await page.route('**/api/secrets**', async route => {
    if (new URL(route.request().url()).pathname.endsWith('/content')) return route.fulfill({ json: { format: 'files', content: '', files: [{ path: 'auth.txt', content: 'legacy-fixture' }], requiresTextImport: true, version: 1 } });
    if (route.request().method() === 'PATCH') { updated = route.request().postDataJSON(); return route.fulfill({ json: { ...old, ...updated } }); }
    await route.fulfill({ json: [{ ...old, ...updated }] });
  });
  await page.goto('/#connections');
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await expect(page.getByText('旧格式需要重新导入一个原生文本认证文件。', { exact: true })).toBeVisible();
  await page.getByLabel('上传文件', { exact: true }).setInputFiles({ name: 'binary', mimeType: 'application/octet-stream', buffer: Buffer.from([0xff, 0x80]) });
  await expect(page.getByRole('alert')).toHaveText('请上传 UTF-8 编码的原始文本文件');
  await page.getByLabel('上传文件', { exact: true }).setInputFiles({ name: 'auth.txt', mimeType: 'text/plain', buffer: Buffer.from('native-fixture') });
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '认证内容', exact: true })).toHaveCount(0);
  expect(updated.format).toBe('text'); expect(updated.content).toBe('native-fixture'); expect(updated.files).toBeUndefined();
});
