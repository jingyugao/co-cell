import { test, expect } from './fixture.mjs';

test('one native credential file preserves uploaded text while projects use the empty default role', async ({ page, ui }) => {
  const name = '原生认证文件', original = '\uFEFFapiVersion: v1\r\ncurrent-context: fixture\r\n';
  let saved, payload, edits = [];
  await page.route('**/api/secrets**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path.endsWith('/content')) return route.fulfill({ json: { format: 'text', content: payload.content, requiresTextImport: false, version: 1 } });
    if (request.method() === 'POST') {
      payload = request.postDataJSON();
      saved = { id: 'native-file', ...payload, storage: 'native', homeDirectory: '/home/debug/credential-fixture', enabled: true, version: 1, projectIds: [], requiresTextImport: false, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' };
      return route.fulfill({ status: 201, json: saved });
    }
    if (request.method() === 'PATCH') { const edit = request.postDataJSON(); edits.push(edit); saved = { ...saved, ...edit }; return route.fulfill({ json: saved }); }
    await route.fulfill({ json: saved ? [saved] : [] });
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
  await expect(page.getByText('原生凭据目录：')).toContainText('/home/debug/credential-fixture');
  await expect(page.getByText('取消登记会撤销工具访问权限，原生配置文件保留在上述目录。', { exact: true })).toBeVisible();
  await page.getByLabel('名称', { exact: true }).fill(name + ' 改名');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByText(name + ' 改名', { exact: true })).toBeVisible();
  expect(edits[0].content).toBeUndefined(); expect(edits[0].format).toBeUndefined();
  await page.goto('/#projects');
  await page.getByRole('article', { name: '暂停项目', exact: true }).getByRole('button', { name: '工具权限', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '暂停项目 工具权限', exact: true });
  const defaultRole = dialog.getByRole('radio', { name: '默认角色 默认角色', exact: true });
  await expect(defaultRole).toBeChecked();
  await expect(dialog.getByText('此角色没有连接。', { exact: true })).toBeVisible();
  await expect(dialog.getByText(name + ' 改名', { exact: true })).toHaveCount(0);
  await expect(dialog.getByText('保留现有权限', { exact: true })).toHaveCount(0);
  expect(ui.calls.some(call => call.path.endsWith('/tool-permissions'))).toBe(false);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
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

test('project HOME references are read-only except for rename and never show legacy import warnings', async ({ page, ui }) => {
  const sourceProjectId = '00000000-0000-4000-8000-000000000123';
  let saved = { id: 'home-reference', name: '项目登录', tool: 'meegle', path: '.meegle/config.json', format: 'home', mutable: true, enabled: true,
    version: 4, projectIds: [], requiresTextImport: false, homeProjectId: sourceProjectId,
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' };
  let patchBody;
  const nativeHomeFile = { path: '.meegle/credentials.enc', content: 'refreshed-by-project-cli' };
  await page.route('**/api/secrets**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path.endsWith('/content')) return route.fulfill({ json: { format: 'home', content: '', requiresTextImport: false, version: saved.version, homeProjectId: sourceProjectId } });
    if (request.method() === 'PATCH') {
      patchBody = request.postDataJSON();
      if (patchBody.content !== undefined) nativeHomeFile.content = patchBody.content;
      saved = { ...saved, ...patchBody };
      return route.fulfill({ json: saved });
    }
    await route.fulfill({ json: [saved] });
  });
  await page.goto('/#connections');
  await expect(page.getByText('由项目 HOME 管理 · 来源项目 ' + sourceProjectId).first()).toBeVisible();
  await expect(page.getByText('需重新导入单文件', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await expect(page.getByText('由项目 HOME 管理 · 来源项目 ' + sourceProjectId).first()).toBeVisible();
  await expect(page.getByText('旧格式需要重新导入一个原生文本认证文件。', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('工具名', { exact: true })).toHaveJSProperty('readOnly', true);
  await expect(page.getByLabel('认证文件路径', { exact: true })).toHaveJSProperty('readOnly', true);
  await expect(page.getByRole('textbox', { name: '认证内容', exact: true })).toHaveCount(0);
  await expect(page.getByLabel('上传文件', { exact: true })).toHaveCount(0);
  await page.getByLabel('名称', { exact: true }).fill('项目登录改名');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByText('项目登录改名', { exact: true })).toBeVisible();
  expect(patchBody).toEqual({ name: '项目登录改名' });
  expect(nativeHomeFile).toEqual({ path: '.meegle/credentials.enc', content: 'refreshed-by-project-cli' });
  await expect(page.getByText('需重新导入单文件', { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
