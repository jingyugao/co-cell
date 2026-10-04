import { test, expect } from './fixture.mjs';

test('a file group preserves uploaded text and binds as one project Secret', async ({ page, ui }) => {
  const name = '完整认证文件组', original = '\uFEFF{"access_token":"fixture"}\r\n';
  let saved, payload, selection, edits = [];
  await page.route('**/api/secrets**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path.endsWith('/content')) return route.fulfill({ json: { format: 'files', files: payload.files, content: '', requiresTextImport: false, version: 1 } });
    if (request.method() === 'POST') {
      payload = request.postDataJSON();
      saved = { id: 'file-group', ...payload, filePaths: payload.files.map(file => file.path), enabled: true, version: 1, projectIds: [], requiresTextImport: false, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' };
      return route.fulfill({ status: 201, json: saved });
    }
    if (request.method() === 'PATCH') { const edit = request.postDataJSON(); edits.push(edit); saved = { ...saved, ...edit }; return route.fulfill({ json: saved }); }
    await route.fulfill({ json: saved ? [saved] : [] });
  });
  await page.route('**/api/projects/paused/tool-grants', async route => {
    if (route.request().method() === 'PUT') { selection = route.request().postDataJSON(); return route.fulfill({ json: [] }); }
    await route.fulfill({ json: [] });
  });
  await page.goto('/#connections');
  await page.getByRole('button', { name: '新建 Secret', exact: true }).click();
  await page.getByLabel('名称', { exact: true }).fill(name);
  await page.getByLabel('工具名', { exact: true }).fill('custom.cli');
  await page.getByRole('combobox', { name: '认证方式', exact: true }).selectOption('files');
  const first = page.getByRole('group', { name: '文件 1 · 主配置', exact: true });
  await first.getByLabel('文件路径', { exact: true }).fill('.config/custom/auth.json');
  await first.getByLabel('上传文件', { exact: true }).setInputFiles({ name: 'auth.json', mimeType: 'application/json', buffer: Buffer.from(original) });
  await expect(first.getByRole('textbox', { name: '文件内容', exact: true })).toHaveValue('\uFEFF{"access_token":"fixture"}\n');
  await page.getByRole('button', { name: '添加文件', exact: true }).click();
  const second = page.getByRole('group', { name: '文件 2', exact: true });
  await second.getByLabel('文件路径', { exact: true }).fill('.config/custom/key');
  await second.getByRole('textbox', { name: '文件内容', exact: true }).fill('fixture-machine-key');
  await page.getByLabel('允许工具更新整组文件', { exact: true }).check();
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByText(name, { exact: true })).toBeVisible();
  expect(payload.format).toBe('files'); expect(payload.files).toHaveLength(2);
  expect(payload.files[0].content).toBe(original);
  expect(payload.path).toBe('.config/custom/auth.json');
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await page.getByLabel('名称', { exact: true }).fill(name + ' 改名');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByText(name + ' 改名', { exact: true })).toBeVisible();
  expect(edits[0].files).toBeUndefined(); expect(edits[0].format).toBeUndefined();
  await page.goto('/#projects');
  await page.getByRole('article', { name: '暂停项目', exact: true }).getByRole('button', { name: '工具权限', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '暂停项目 工具密钥', exact: true });
  await dialog.getByRole('checkbox', { name: name + ' 改名', exact: true }).check();
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  expect(selection).toEqual({ selections: [{ tool: 'custom.cli', secretId: 'file-group' }] });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
