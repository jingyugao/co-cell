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

const scriptId = '00000000-0000-4000-8000-000000000091';
const sharedScript = { id: scriptId, name: 'Shared authorization hook', language: 'typescript',
  source: 'return { allow: true, credential: input.args[0] };', version: 3, createdAt: stamp, updatedAt: stamp };
const dynamicTool = (name, fields = {}) => ({ name, description: '', instructions: '', enabled: true, executable: name,
  args: [], env: {}, timeoutMs: 20000, version: 1, createdAt: stamp, updatedAt: stamp, ...fields });

async function toolScriptPage(page, { tools, scripts = [sharedScript], definitionsStatus = 200, onDefinitionWrite } = {}) {
  const requests = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/api/')) requests.push({ path: url.pathname, method: request.method() });
  });
  await page.route('**/api/tool-definitions', route => route.request().method() === 'GET'
    ? route.fulfill({ status: definitionsStatus, json: definitionsStatus === 200 ? tools : { error: 'tool reference unavailable' } })
    : route.fallback());
  await page.route('**/api/tool-definitions/**', async route => {
    const request = route.request();
    if (request.method() === 'PUT') {
      const body = request.postDataJSON();
      await onDefinitionWrite?.(body);
      return route.fulfill({ json: { ...tools.find(tool => tool.name === decodeURIComponent(new URL(request.url()).pathname.split('/').at(-1))), ...body } });
    }
    return route.fallback();
  });
  await page.route('**/api/tool-scripts', route => route.request().method() === 'GET'
    ? route.fulfill({ json: scripts }) : route.fallback());
  await page.route('**/api/tools', route => route.request().method() === 'GET' ? route.fulfill({ json: [] }) : route.fallback());
  for (const tool of tools) await page.route(`**/api/tools/${tool.name}/credentials**`, route => route.fulfill({ json: {
    tool: tool.name, home: '/home/debug', roots: tool.credentialPaths ?? [], entries: [], version,
  } }));
  await page.goto('/#connections');
  return requests;
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

test('tool script preview shows the source and permission context without mutating tool or script definitions', async ({ page, ui }) => {
  const tool = dynamicTool('fixture-tool', { permissionScriptId: scriptId });
  const requests = await toolScriptPage(page, { tools: [tool] });
  const card = page.getByRole('article', { name: tool.name, exact: true });
  const summary = card.getByRole('region', { name: `${tool.name} 脚本`, exact: true });
  await summary.getByRole('button', { name: sharedScript.name, exact: true }).click();

  const preview = page.getByRole('dialog', { name: `查看脚本：${sharedScript.name}`, exact: true });
  await expect(preview.getByRole('region', { name: '当前脚本用途', exact: true })).toContainText('fixture-tool · 权限检查');
  await expect(preview.getByText('每次调用工具时', { exact: true })).toBeVisible();
  await expect(preview.getByRole('region', { name: '脚本引用关系', exact: true })).toContainText('fixture-tool');
  await expect(preview.getByRole('region', { name: '脚本源码', exact: true })).toHaveText(sharedScript.source);
  await page.screenshot({ path: test.info().outputPath('tool-script-source-preview.png'), fullPage: true });
  await preview.getByRole('button', { name: '关闭预览', exact: true }).click();
  expect(requests.filter(request => request.method !== 'GET')).toEqual([]);
  expect(ui.calls.filter(request => request.method !== 'GET')).toEqual([]);
});

test('opening and closing a script preview from the tool editor preserves the unsaved tool draft', async ({ page, ui }) => {
  const tool = dynamicTool('fixture-tool', { permissionScriptId: scriptId, credentialPath: '.fixture/config' });
  const saved = [];
  await toolScriptPage(page, { tools: [tool], onDefinitionWrite: body => saved.push(body) });
  await page.getByRole('article', { name: tool.name, exact: true }).getByRole('button', { name: '编辑', exact: true }).click();
  const editor = page.getByRole('dialog', { name: `编辑工具：${tool.name}`, exact: true });
  const draftArgs = '["--draft-option"]';
  await editor.getByRole('textbox', { name: '启动参数（JSON 字符串数组）', exact: true }).fill(draftArgs);
  await editor.getByRole('textbox', { name: '主凭据文件路径', exact: true }).fill('.fixture/draft-config');
  await editor.getByRole('button', { name: '查看权限检查脚本', exact: true }).click();

  const preview = page.getByRole('dialog', { name: `查看脚本：${sharedScript.name}`, exact: true });
  await expect(preview.getByRole('region', { name: '脚本源码', exact: true })).toHaveText(sharedScript.source);
  await preview.getByRole('button', { name: '关闭预览', exact: true }).click();
  await expect(editor.getByRole('textbox', { name: '启动参数（JSON 字符串数组）', exact: true })).toHaveValue(draftArgs);
  await expect(editor.getByRole('textbox', { name: '主凭据文件路径', exact: true })).toHaveValue('.fixture/draft-config');
  await editor.getByRole('button', { name: '保存工具', exact: true }).click();
  await expect.poll(() => saved.length).toBe(1);
  expect(saved[0].args).toEqual(['--draft-option']);
  expect(saved[0].credentialPath).toBe('.fixture/draft-config');
});

test('shared script usage lists each referencing tool and hook purpose', async ({ page, ui }) => {
  const tools = [
    dynamicTool('tool-alpha', { permissionScriptId: scriptId }),
    dynamicTool('tool-beta', { credentialParseScriptId: scriptId }),
  ];
  await toolScriptPage(page, { tools });
  await page.getByRole('tab', { name: '脚本管理', exact: true }).click();
  const card = page.getByRole('article', { name: sharedScript.name, exact: true });
  await expect(card.getByText('tool-alpha · 权限检查', { exact: true })).toBeVisible();
  await expect(card.getByText('tool-beta · 凭据读取', { exact: true })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('script-usage-list.png'), fullPage: true });
  await card.getByRole('button', { name: '编辑', exact: true }).click();

  const impact = page.getByRole('region', { name: '脚本修改影响', exact: true });
  const rows = impact.locator('li');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText('tool-alpha');
  await expect(rows.nth(0)).toContainText('权限检查');
  await expect(rows.nth(1)).toContainText('tool-beta');
  await expect(rows.nth(1)).toContainText('凭据读取');
});

test('failed tool-reference lookup stays unknown instead of labeling a shared script unused', async ({ page, ui }) => {
  await toolScriptPage(page, { tools: [], definitionsStatus: 503 });
  await page.getByRole('tab', { name: '脚本管理', exact: true }).click();

  const card = page.getByRole('article', { name: sharedScript.name, exact: true });
  await expect(card.locator('.script-usage-unknown')).toContainText('引用信息未加载');
  await expect(card.getByText('未被工具引用', { exact: true })).toHaveCount(0);
  await expect(card.getByRole('button', { name: '删除', exact: true })).toBeDisabled();
  await expect(page.getByRole('status')).toContainText('工具引用加载失败');
  await card.getByRole('button', { name: '查看脚本', exact: true }).click();
  const preview = page.getByRole('dialog', { name: `查看脚本：${sharedScript.name}`, exact: true });
  await expect(preview.getByRole('region', { name: '脚本源码', exact: true })).toHaveText(sharedScript.source);
  await expect(preview.getByRole('region', { name: '脚本引用关系', exact: true })).toContainText('引用关系尚未加载');
});


test('missing tool scripts stay distinct from optional unconfigured hooks', async ({ page, ui }) => {
  const missingId = '00000000-0000-4000-8000-000000000099';
  const tool = dynamicTool('named-fixture', { credentialMode: 'named', credentialPath: '.fixture/config',
    permissionScriptId: missingId, credentialParseScriptId: scriptId });
  const requests = await toolScriptPage(page, { tools: [tool] });
  const card = page.getByRole('article', { name: tool.name, exact: true });
  const summary = card.getByRole('region', { name: `${tool.name} 脚本`, exact: true });
  await expect(summary.getByText('引用的脚本不存在', { exact: true })).toBeVisible();
  await expect(summary.getByText('未配置 · 直接保存原始文本或二进制', { exact: true })).toBeVisible();
  await expect(summary.getByText('缺少必需脚本', { exact: true })).toHaveCount(0);
  await card.getByRole('button', { name: '编辑', exact: true }).click();
  const editor = page.getByRole('dialog', { name: `编辑工具：${tool.name}`, exact: true });
  await expect(editor.getByRole('combobox', { name: '权限检查脚本', exact: true })).toHaveValue(missingId);
  await expect(editor.getByRole('button', { name: '查看权限检查脚本', exact: true })).toBeDisabled();
  expect(requests.filter(request => request.method !== 'GET')).toEqual([]);
});
