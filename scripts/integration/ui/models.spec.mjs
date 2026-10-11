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
  const defaults = { executionMode: 'sandbox', workingDirectory: '/home/agent/workspace', model: 'integration-model', modelReasoningEffort: 'medium', sandboxMode: 'danger-full-access', webSearchMode: 'disabled', networkAccessEnabled: true };
  let savedInput;
  let sessionPatch;
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
    defaults, sandbox: { provider: 'cellbox', enabled: true, image: 'default', workingDirectory: defaults.workingDirectory },
    codexVersion: 'integration', approvalPolicy: 'never', auth: 'api-key', models: ['gpt-6-sol'], modelOptions,
    capabilities: { interactiveApprovals: false, tokenDeltas: false, sandboxPreviews: true },
  } }));
  await page.route('**/api/sandboxes**', route => route.fulfill({ json: [] }));
  await page.route('**/api/sessions/old-session', async route => {
    if (route.request().method() !== 'PATCH') return route.fallback();
    sessionPatch = route.request().postDataJSON();
    await route.fulfill({ json: {
      id: 'old-session', projectId: 'paused', title: '旧会话', threadId: 'existing-thread', status: 'idle',
      settings: { ...defaults, ...sessionPatch.settings }, turns: [], archivedAt: null,
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
  const chatModel = page.getByRole('combobox', { name: '切换模型', exact: true });
  await expect(chatModel.locator('option')).toHaveText([
    'integration-model', 'gpt-6-sol（渠道 A）', 'gpt-6-sol（渠道 B）',
  ]);
  await chatModel.selectOption('channel-b-gpt');
  await expect.poll(() => sessionPatch).toEqual({ settings: { model: 'gpt-6-sol', modelEntryId: 'channel-b-gpt' } });
  await expect(chatModel).toHaveValue('channel-b-gpt');
  await testInfo.attach('chat-model-picker', { body: await page.screenshot(), contentType: 'image/png' });
});
