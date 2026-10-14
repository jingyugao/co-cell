import { test, expect } from './fixture.mjs';

const stamp = '2026-01-01T00:00:00Z';
const version = (id, name, options = {}) => ({ id, version: name, source: `registry.example/${name}`, status: 'succeeded', createdAt: stamp, projectReady: true, ...options });
const initialImages = () => [
  { id: 'managed', name: 'Managed Runtime', category: 'Node', origin: 'managed', repository: 'registry.example/runtime', defaultVersionId: 'managed-v1', versions: [
    version('managed-v1', '1.0', { isDefault: false }),
    version('managed-v2', '2.0'),
  ] },
  { id: 'cellbox', name: 'Cellbox Runtime', category: 'Go', origin: 'cellbox', versions: [version('cellbox-v1', 'go-1.24')] },
  { id: 'system', name: '系统基础镜像', category: '系统', origin: 'profile', versions: [version('system-v1', 'node-22', { source: 'system', isDefault: true })] },
];

async function imageRoutes(page, initial = initialImages()) {
  let images = initial;
  const reads = [], writes = [];
  await page.route('**/api/images**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (request.method() === 'GET') {
      reads.push(path);
      return route.fulfill({ json: images });
    }
    const match = path.match(/^\/api\/images\/([^/]+)\/versions\/([^/]+)\/default$/);
    if (request.method() === 'POST' && match) {
      const [, imageId, versionId] = match.map(decodeURIComponent);
      writes.push({ imageId, versionId, body: request.postDataJSON() });
      images = images.map(image => ({ ...image, versions: image.versions.map(item => ({ ...item, isDefault: image.id === imageId && item.id === versionId })) }));
      return route.fulfill({ json: images.find(image => image.id === imageId) });
    }
    return route.fulfill({ status: 404, json: { error: `Unexpected image API request ${request.method()} ${path}` } });
  });
  await page.route('**/api/images/*/tags', route => route.fulfill({ json: { tags: [] } }));
  return { reads, writes };
}

test('global default can move across image origins and reload clears the previous badge', async ({ page, ui }) => {
  const { reads, writes } = await imageRoutes(page);
  await page.goto('/#images');
  await expect(page.getByText('新项目使用标记为默认镜像的版本；只预热此版本。已有项目继续使用原版本。')).toBeVisible();

  await page.getByRole('article').filter({ hasText: 'Managed Runtime' }).getByRole('button', { name: '进入仓库' }).click();
  const managedVersion = page.locator('.image-version').filter({ hasText: '2.0' });
  await expect(page.locator('.image-version').filter({ hasText: '1.0' }).getByText('仓库默认 · 归档恢复')).toBeVisible();
  await managedVersion.getByRole('button', { name: '设为默认镜像' }).click();
  await expect(managedVersion.getByText('默认镜像', { exact: true })).toBeVisible();
  expect(writes).toEqual([{ imageId: 'managed', versionId: 'managed-v2', body: {} }]);

  await page.getByRole('button', { name: '返回仓库列表' }).click();
  await expect(page.locator('.image-default-summary')).toHaveCount(1);
  await expect(page.locator('.image-card').filter({ hasText: 'Managed Runtime' }).getByText('默认镜像 · 2.0')).toBeVisible();
  await expect(page.locator('.image-card').filter({ hasText: '系统基础镜像' }).locator('.image-default-summary')).toHaveCount(0);

  await page.getByRole('article').filter({ hasText: '系统基础镜像' }).getByRole('button', { name: '查看版本' }).click();
  const systemVersion = page.locator('.image-version').filter({ hasText: 'node-22' });
  await expect(systemVersion.getByRole('button', { name: '设为默认镜像' })).toBeVisible();
  await systemVersion.getByRole('button', { name: '设为默认镜像' }).click();
  await expect(systemVersion.getByText('默认镜像', { exact: true })).toBeVisible();
  expect(writes.at(-1)).toEqual({ imageId: 'system', versionId: 'system-v1', body: {} });
  expect(reads.length).toBeGreaterThanOrEqual(3);
});

test('new-project picker names the global default without sending an explicit image selection', async ({ page, ui }) => {
  await imageRoutes(page);
  let createBody;
  await page.route('**/api/projects', async route => {
    const request = route.request();
    if (request.method() !== 'POST') return route.fallback();
    createBody = request.postDataJSON();
    await route.fulfill({ status: 400, json: { error: 'capture only' } });
  });
  await page.goto('/#projects');
  await page.getByRole('button', { name: '＋ 创建项目' }).click();
  const form = page.getByRole('form', { name: '创建项目' });
  const imageType = form.getByLabel('镜像类型');
  await expect(imageType.locator('option').first()).toHaveText('系统默认镜像 · 系统基础镜像 node-22');
  await expect(imageType).toHaveValue('');
  await expect(form.getByText('未指定镜像时，新项目使用当前默认版本：系统基础镜像 · node-22；只预热该版本。')).toBeVisible();
  await form.getByLabel('项目名称').fill('默认镜像测试');
  await form.getByRole('button', { name: '创建项目', exact: true }).click();
  await expect.poll(() => createBody).toBeDefined();
  expect(createBody).toEqual({ name: '默认镜像测试', requirementUrl: null, type: 1 });
  await expect(form.getByRole('alert')).toHaveText('capture only');
});

test('a default revision remains selectable when a newer revision reuses its tag', async ({ page, ui }) => {
  const images = initialImages();
  images[0].defaultVersionId = 'new-revision';
  images[0].versions = [
    version('new-revision', '1.0', { image: 'registry.example/runtime@sha256:' + 'b'.repeat(64) }),
    version('old-revision', '1.0', { image: 'registry.example/runtime@sha256:' + 'a'.repeat(64), isDefault: true }),
  ];
  images[2].versions[0].isDefault = false;
  await imageRoutes(page, images);
  let createBody;
  await page.route('**/api/projects', async route => {
    if (route.request().method() !== 'POST') return route.fallback();
    createBody = route.request().postDataJSON();
    await route.fulfill({ status: 400, json: { error: 'capture only' } });
  });
  await page.goto('/#projects');
  await page.getByRole('button', { name: '＋ 创建项目' }).click();
  const form = page.getByRole('form', { name: '创建项目' });
  await form.getByLabel('镜像类型').selectOption('Node');
  await form.getByLabel('镜像', { exact: true }).selectOption('managed');
  const versions = form.getByLabel('版本', { exact: true });
  await expect(versions).toHaveValue('old-revision');
  await expect(versions.locator('option')).toHaveText(['请选择版本', '1.0 · bbbbbbbbbbbb', '1.0 · 默认镜像 · aaaaaaaaaaaa']);
  await form.getByLabel('项目名称').fill('旧版默认镜像');
  await form.getByRole('button', { name: '创建项目', exact: true }).click();
  await expect.poll(() => createBody?.imageVersionId).toBe('old-revision');
});
