import { test, expect } from './fixture.mjs';

const stamp = '2026-01-01T00:00:00Z';
const version = 'a'.repeat(64);
const nativeFile = (path, content, encoding = 'utf8', scriptVersion = 0) => ({
  path, content, encoding, scriptVersion, version, size: Buffer.byteLength(content), editable: true,
});

async function credentialEditor(page, { name, roots, files, hooks = false, onSave }) {
  const state = new Map(files.map(file => [file.path, { ...file }]));
  const reads = [], writes = [];
  const scripts = hooks ? ['load', 'save'].map((kind, index) => ({
    id: `00000000-0000-4000-8000-00000000000${index + 1}`, name: `Fixture ${kind} hook`,
    language: 'typescript', source: 'return input.content;', version: 1, createdAt: stamp, updatedAt: stamp,
  })) : [];
  const definition = {
    name, enabled: true, description: '', instructions: '', executable: name, args: [], env: {},
    credentialPath: files[0].path, credentialPaths: roots, timeoutMs: 20000, version: 1,
    ...(hooks ? { credentialParseScriptId: scripts[0].id, credentialSaveScriptId: scripts[1].id } : {}),
    createdAt: stamp, updatedAt: stamp,
  };
  await page.route('**/api/tool-definitions', route => route.request().method() === 'GET'
    ? route.fulfill({ json: [definition] }) : route.fallback());
  await page.route('**/api/tool-scripts', route => route.fulfill({ json: scripts }));
  await page.route('**/api/tools', route => route.fulfill({ json: [name === 'kubectl'
    ? { name, kind: 'tool-with-credential', credentials: ['fixture'] } : { name, kind: 'tool' }] }));
  await page.route(`**/api/tools/${name}/credentials**`, async route => {
    const request = route.request(), url = new URL(request.url());
    if (!url.pathname.endsWith('/file')) return route.fulfill({ json: {
      tool: name, home: '/home/debug', roots, registrations: [], entries: [
        ...roots.filter(root => files.some(file => file.path.startsWith(root + '/'))).map(path => ({ path, type: 'directory' })),
        ...[...state.values()].map(file => ({ path: file.path, type: 'file', size: file.size })),
      ],
    } });
    const path = url.searchParams.get('path');
    if (!state.has(path)) return route.fulfill({ status: 404, json: { error: '文件不存在' } });
    if (request.method() === 'PUT') {
      const body = request.postDataJSON(); writes.push(body);
      const response = await onSave?.(body, state, writes);
      if (response) return route.fulfill(response);
      state.set(path, { ...state.get(path), ...body, version: 'b'.repeat(64) });
    } else reads.push(path);
    return route.fulfill({ json: state.get(path) });
  });
  await page.goto('/#connections');
  await page.locator('.tool-definition-list article').filter({ hasText: name }).getByRole('button', { name: '编辑', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: `编辑工具：${name}`, exact: true });
  await dialog.getByText('凭据配置', { exact: true }).click();
  const browser = dialog.getByRole('region', { name: `${name} 凭据文件`, exact: true });
  await expect(browser).toBeVisible();
  const select = path => browser.locator('.tool-credential-tree').getByTitle(path, { exact: true }).click();
  return { dialog, browser, state, reads, writes, select };
}

// The removed Secret upload/import UI is replaced by editing native files under each tool.
test('native multi-file credentials load on selection and save only the selected raw text without granting project access', async ({ page, ui }) => {
  const path = '.kube/config', certificate = '.kube/client.crt';
  const original = '# retain comments\napiVersion: v1\ncurrent-context: fixture\n';
  const fixture = await credentialEditor(page, { name: 'kubectl', roots: ['.kube'], files: [
    nativeFile(path, original), nativeFile(certificate, 'synthetic-certificate'),
  ] });
  const { browser, reads, writes, select, state } = fixture;
  await expect(browser.locator('.tool-credential-tree').getByTitle(certificate, { exact: true })).toBeVisible();
  expect(reads).toEqual([]);
  await select(path);
  const editor = browser.getByRole('textbox', { name: `${path} 文件内容`, exact: true });
  await expect(editor).toHaveValue(original);
  const edited = original.replace('fixture', 'reporting');
  await editor.fill(edited);
  await browser.getByRole('button', { name: '保存文件', exact: true }).click();
  await expect(browser.getByRole('status')).toHaveText('凭据文件已保存。');
  expect(writes).toEqual([{ path, content: edited, encoding: 'utf8', version, scriptVersion: 0 }]);
  expect(reads).toEqual([path]);
  expect(state.get(certificate).content).toBe('synthetic-certificate');
  await fixture.dialog.getByRole('button', { name: '关闭编辑窗口', exact: true }).click();
  await page.goto('/#projects');
  await page.getByRole('article', { name: '暂停项目', exact: true }).getByRole('button', { name: '工具权限', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '暂停项目 工具权限', exact: true });
  await expect(dialog.getByRole('radio', { name: '默认角色 默认角色', exact: true })).toBeChecked();
  await expect(dialog.getByText('此角色没有启用的工具。', { exact: true })).toBeVisible();
  expect(ui.calls.some(call => call.path.endsWith('/tool-permissions'))).toBe(false);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('encrypted credential editing sends parsed content and hook version while preserving companion files', async ({ page, ui }) => {
  const path = '.meegle/credentials.enc', key = '.meegle/.machine-key';
  const original = JSON.stringify({ access_token: 'synthetic-old-token', extra: 'preserve' }, null, 2);
  const fixture = await credentialEditor(page, { name: 'meegle', roots: ['.meegle'], hooks: true, files: [
    nativeFile('.meegle/config.json', '{"current_profile":"default"}'),
    nativeFile(path, original, 'parsed', 7), nativeFile(key, 'synthetic-machine-key'),
  ] });
  await expect(fixture.dialog.getByRole('combobox', { name: 'Load hook', exact: true })).toHaveValue('00000000-0000-4000-8000-000000000001');
  await expect(fixture.dialog.getByRole('combobox', { name: 'Save hook', exact: true })).toHaveValue('00000000-0000-4000-8000-000000000002');
  await fixture.select(path);
  const editor = fixture.browser.getByRole('textbox', { name: `${path} 文件内容`, exact: true });
  await expect(editor).toHaveValue(original);
  const edited = original.replace('synthetic-old-token', 'synthetic-new-token');
  await editor.fill(edited);
  await fixture.browser.getByRole('button', { name: '保存文件', exact: true }).click();
  await expect(fixture.browser.getByRole('status')).toHaveText('凭据文件已保存。');
  expect(fixture.writes).toEqual([{ path, content: edited, encoding: 'parsed', version, scriptVersion: 7 }]);
  expect(fixture.reads).toEqual([path]);
  expect(fixture.state.get(key).content).toBe('synthetic-machine-key');
  expect(fixture.state.get('.meegle/config.json').content).toBe('{"current_profile":"default"}');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('credential save conflicts retain the draft until an explicit reload and use the refreshed file and hook versions', async ({ page, ui }) => {
  const path = '.gitconfig', refreshed = '[user]\nname = CLI refresh\n';
  const fixture = await credentialEditor(page, { name: 'git', roots: [path], files: [nativeFile(path, '[user]\nname = Original\n')],
    onSave(body, state, writes) {
      if (writes.length !== 1) return;
      state.set(path, { ...state.get(path), content: refreshed, version: 'c'.repeat(64), scriptVersion: 4 });
      return { status: 409, json: { error: '文件或脚本已更新，请重新打开' } };
    },
  });
  await fixture.select(path);
  const editor = fixture.browser.getByRole('textbox', { name: `${path} 文件内容`, exact: true });
  const draft = '[user]\nname = Unsaved draft\n';
  await editor.fill(draft);
  await fixture.browser.getByRole('button', { name: '保存文件', exact: true }).click();
  await expect(fixture.browser.getByRole('alert')).toContainText('当前草稿已保留');
  await expect(editor).toHaveValue(draft);
  expect(fixture.writes).toHaveLength(1);
  expect(fixture.state.get(path).content).toBe(refreshed);
  await fixture.browser.getByRole('button', { name: '刷新', exact: true }).click();
  await expect(editor).toHaveValue(draft);
  page.once('dialog', dialog => dialog.accept());
  await fixture.select(path);
  await expect(editor).toHaveValue(refreshed);
  const edited = '[user]\nname = Updated after refresh\n';
  await editor.fill(edited);
  await fixture.browser.getByRole('button', { name: '保存文件', exact: true }).click();
  await expect(fixture.browser.getByRole('status')).toHaveText('凭据文件已保存。');
  expect(fixture.writes).toEqual([
    { path, content: draft, encoding: 'utf8', version, scriptVersion: 0 },
    { path, content: edited, encoding: 'utf8', version: 'c'.repeat(64), scriptVersion: 4 },
  ]);
});
