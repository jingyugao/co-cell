import { test, expect } from './fixture.mjs';

test('model management keeps duplicate model IDs scoped to their channels', async ({ page, ui }, testInfo) => {
  const initial = {
    revision: 4,
    defaultModelId: 'channel-a-gpt',
    channels: [
      { id: 'channel-a', name: '渠道 A', endpoint: 'https://a.example/v1', enabled: true, hasApiKey: true,
        models: [{ id: 'channel-a-gpt', model: 'gpt-6-sol', visible: true }] },
      { id: 'channel-b', name: '渠道 B', endpoint: 'https://b.example/v1', enabled: true, hasApiKey: false,
        models: [{ id: 'channel-b-gpt', model: 'gpt-6-sol', visible: true }] },
    ],
  };
  const modelOptions = [
    { id: 'channel-a-gpt', model: 'gpt-6-sol', channelId: 'channel-a', channelName: '渠道 A', label: 'gpt-6-sol（渠道 A）' },
    { id: 'channel-b-gpt', model: 'gpt-6-sol', channelId: 'channel-b', channelName: '渠道 B', label: 'gpt-6-sol（渠道 B）' },
  ];
  const defaults = { executionMode: 'sandbox', workingDirectory: '/home/agent/workspace', model: 'integration-model', modelReasoningEffort: 'medium', collaborationMode: 'plan', fastMode: true, sandboxMode: 'danger-full-access', webSearchMode: 'disabled', networkAccessEnabled: true };
  ui.sessions.get('old-session').settings = { ...defaults };
  let savedInput;
  let sessionPatch;
  const sessionPatches = [];
  let persistedSettings = { ...defaults };
  await page.route('**/api/models', async route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: initial });
    savedInput = route.request().postDataJSON();
    const saved = {
      revision: initial.revision + 1,
      defaultModelId: savedInput.defaultModelId,
      channels: savedInput.channels.map(({ apiKey, ...channel }) => ({ ...channel, hasApiKey: Boolean(apiKey) || channel.id === 'channel-a' })),
    };
    await route.fulfill({ json: saved });
  });
  await page.route('**/api/config', route => route.fulfill({ json: {
    defaults: { ...defaults, model: 'gpt-6-sol', modelEntryId: 'channel-a-gpt', fastMode: false }, sandbox: { provider: 'cellbox', enabled: true, image: 'default', workingDirectory: defaults.workingDirectory },
    codexVersion: 'integration', approvalPolicy: 'never', auth: 'api-key', models: ['gpt-6-sol'], modelOptions,
    capabilities: { interactiveApprovals: false, tokenDeltas: false, sandboxPreviews: true },
  } }));
  await page.route('**/api/sandboxes**', route => route.fulfill({ json: [] }));
  await page.route('**/api/sessions/old-session', async route => {
    if (route.request().method() !== 'PATCH') return route.fallback();
    sessionPatch = route.request().postDataJSON();
    sessionPatches.push(sessionPatch);
    persistedSettings = { ...persistedSettings, ...sessionPatch.settings };
    await route.fulfill({ json: {
      id: 'old-session', projectId: 'paused', title: '旧会话', threadId: 'existing-thread', status: 'idle',
      settings: persistedSettings, turns: [], archivedAt: null,
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    } });
  });
  await page.goto('/#projects');
  const mobileMenu = page.getByRole('button', { name: '打开导航', exact: true });
  if (await mobileMenu.isVisible()) await mobileMenu.click();
  await page.getByRole('tab', { name: '系统管理', exact: true }).click();
  await expect(page).toHaveURL(/#sandboxes$/);
  if (await mobileMenu.isVisible()) await mobileMenu.click();
  await page.locator('.sidebar').getByRole('button', { name: '模型管理', exact: true }).click();
  await expect(page).toHaveURL(/#models$/);
  await expect(page.getByRole('heading', { name: '模型管理', exact: true })).toBeVisible();

  const defaultModel = page.getByRole('combobox', { name: '默认模型', exact: true });
  await expect(defaultModel.locator('option')).toHaveText([
    '未设置', 'gpt-6-sol（渠道 A）', 'gpt-6-sol（渠道 B）',
  ]);
  await defaultModel.selectOption('channel-b-gpt');

  const channelB = page.locator('.model-channel-card').filter({ has: page.getByRole('heading', { name: '渠道 B', exact: true }) });
  await channelB.getByLabel('Endpoint', { exact: true }).fill('https://b.example/v1/responses');
  await channelB.getByLabel('API Key', { exact: true }).fill('test-channel-b-key');
  await page.getByRole('button', { name: '保存配置', exact: true }).click();

  await expect(page.getByRole('status')).toHaveText('模型配置已保存。');
  expect(savedInput.defaultModelId).toBe('channel-b-gpt');
  expect(savedInput.channels.find(channel => channel.id === 'channel-b')).toMatchObject({
    endpoint: 'https://b.example/v1/responses', apiKey: 'test-channel-b-key',
    models: [{ id: 'channel-b-gpt', model: 'gpt-6-sol', visible: true }],
  });
  await expect(channelB.getByLabel('API Key', { exact: true })).toHaveValue('');
  await expect(channelB.getByText('API Key 已配置', { exact: true })).toBeVisible();
  await testInfo.attach('model-management', { body: await page.screenshot(), contentType: 'image/png' });

  await page.goto('/sessions/old-session');
  const trigger = page.getByRole('button', { name: /^配置模型/ });
  await expect(trigger).toHaveAccessibleName('配置模型，当前 integration-model，Medium，Fast');
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: '配置', exact: true });
  const modelSelect = dialog.getByRole('combobox', { name: '模型', exact: true });
  await expect(modelSelect.locator('option')).toHaveText([
    'integration-model', 'gpt-6-sol（渠道 A）', 'gpt-6-sol（渠道 B）',
  ]);
  await modelSelect.selectOption('channel-b-gpt');
  expect(sessionPatches).toHaveLength(0);
  await dialog.getByRole('button', { name: '完成', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => sessionPatch).toEqual({ settings: { model: 'gpt-6-sol', modelEntryId: 'channel-b-gpt' } });
  await expect(trigger).toHaveAccessibleName('配置模型，当前 gpt-6-sol，渠道 B，Medium，Fast');
  await trigger.click();
  await expect(modelSelect).toHaveValue('channel-b-gpt');
  const verifyBounds = async () => {
    await expect(dialog).toBeInViewport({ ratio: 1 });
    const bounds = await dialog.boundingBox();
    const viewport = page.viewportSize();
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width);
    expect(bounds.y).toBeGreaterThanOrEqual(0);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
  };
  await verifyBounds();
  await testInfo.attach('model-configuration-open', { body: await page.screenshot(), contentType: 'image/png' });
  if (testInfo.project.name === 'ui-mobile') {
    await page.setViewportSize({ width: 320, height: 480 });
    await verifyBounds();
    await testInfo.attach('model-configuration-narrow', { body: await page.screenshot(), contentType: 'image/png' });
  }
  await dialog.getByRole('combobox', { name: '推理强度' }).selectOption('high');
  await dialog.getByRole('combobox', { name: '速度' }).selectOption('standard');
  await dialog.getByRole('button', { name: '完成', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => sessionPatch).toEqual({ settings: { modelReasoningEffort: 'high', fastMode: false } });
  await expect(trigger).toHaveAccessibleName('配置模型，当前 gpt-6-sol，渠道 B，High');
  await trigger.click();
  await dialog.getByRole('button', { name: '恢复默认' }).click();
  await expect(modelSelect).toHaveValue('channel-a-gpt');
  await expect(dialog.getByRole('combobox', { name: '推理强度' })).toHaveValue('medium');
  await expect(dialog.getByRole('combobox', { name: '速度' })).toHaveValue('standard');
  expect(sessionPatches).toHaveLength(2);
  await dialog.getByRole('button', { name: '完成', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => sessionPatch).toEqual({ settings: { model: 'gpt-6-sol', modelEntryId: 'channel-a-gpt', modelReasoningEffort: 'medium' } });
  await trigger.click();
  await dialog.getByRole('combobox', { name: '推理强度' }).selectOption('low');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await trigger.click();
  await expect(dialog.getByRole('combobox', { name: '推理强度' })).toHaveValue('medium');
  await page.mouse.click(4, 4);
  await expect(dialog).toHaveCount(0);
  expect(sessionPatches).toHaveLength(3);
  await testInfo.attach('chat-model-picker', { body: await page.screenshot(), contentType: 'image/png' });
});
