import assert from 'node:assert/strict';
import test from 'node:test';
import { Hono } from 'hono';
import { z } from 'zod';
import { CellboxClient, type CellboxOperation, type CellboxImportedImage } from '../../packages/sandbox/src/providers/cellbox/client.js';
import type { ImageRecord } from './store.js';
import { ImageCatalog } from './service.js';
import { installImageRoutes } from './routes.js';
import { installProjectsRoutes } from '../projects/routes.js';
import { HttpError } from '../../util/errors.js';

function fixture() {
  const documents = new Map<string, ImageRecord>();
  const images = new Map<string, CellboxImportedImage>();
  const operations = new Map<string, CellboxOperation>();
  const submissions: Array<{ key: string; body: Record<string, unknown> }> = [];
  let loseResponse = false;
  const store = { listImages: async () => structuredClone([...documents.values()]),
    saveImage: async (image: ImageRecord) => { documents.set(image.id, structuredClone(image)); } };
  const client = new CellboxClient({ baseUrl: 'http://cellbox.test', token: 'server-token', fetch: async (input, init) => {
    const path = new URL(String(input)).pathname;
    const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });
    if (path === '/v1/profiles') return json([{ id: 'cocell', image: 'registry/default@sha256:default' }]);
    if (path === '/v1/images:import') {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const key = new Headers(init?.headers).get('Idempotency-Key')!;
      const previous = submissions.find(submission => submission.key === key);
      submissions.push({ key, body });
      assert.ok([...documents.values()].some(image => image.versions.some(version => `cocell-image-${version.id}` === key)), 'request must be durable before submission');
      if (previous && JSON.stringify(previous.body) !== JSON.stringify(body)) return new Response(JSON.stringify({ error: { code: 'CONFLICT', message: 'request changed' } }), { status: 409 });
      const operation: CellboxOperation = operations.get(key) ?? { id: key, kind: 'image-import', targetId: key, status: 'running', version: 1, createdAt: new Date().toISOString() };
      operations.set(key, operation);
      if (loseResponse) { loseResponse = false; throw new Error('connection lost after acceptance'); }
      return json(operation);
    }
    if (path === '/v1/images') return json([...images.values()]);
    if (path.startsWith('/v1/images/')) {
      const image = images.get(decodeURIComponent(path.slice('/v1/images/'.length)));
      return image ? json(image) : new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'missing image' } }), { status: 404 });
    }
    if (path.startsWith('/v1/operations/')) return json(operations.get(decodeURIComponent(path.slice('/v1/operations/'.length))));
    throw new Error(`Unexpected path ${path}`);
  } });
  const catalog = () => new ImageCatalog(store, client, 'cocell');
  function finish(operationId: string, source: string) {
    const operation = operations.get(operationId)!;
    operation.status = 'succeeded'; operation.result = { importedImageId: operationId };
    images.set(operationId, { id: operationId, source, resolvedSource: `${source}@sha256:source`, image: `registry/prepared@sha256:${operationId}`,
      platform: 'linux/amd64', command: ['/usr/local/bin/node', '/opt/product/cocell/launcher.mjs'], env: {}, workingDir: '/home/agent/workspace',
      ports: [], warnings: ['runs as agent'], key: operationId, createdAt: new Date().toISOString() });
  }
  return { catalog, documents, submissions, operations, images, finish, loseResponse: () => { loseResponse = true; } };
}

test('versions resolve to distinct immutable images; records survive restart without credentials', async () => {
  const f = fixture(); const catalog = f.catalog(); await catalog.init();
  const first = await catalog.import({ name: 'Python', category: '开发环境', version: 'v1', url: 'team/python:v1',
    buildCommand: 'cp /bundled/git /usr/local/bin/git', registryAuth: { username: 'private-user', password: 'private-password' } });
  await assert.rejects(catalog.resolve(first.id, first.versions[0].id), /已导入成功/);
  f.finish(first.versions[0].operationId!, 'team/python:v1');
  const pinned = await catalog.resolve(first.id, first.versions[0].id);
  const second = await catalog.import({ imageId: first.id, version: 'v2', url: 'team/python:v2' });
  f.finish(second.versions[0].operationId!, 'team/python:v2');
  const restarted = f.catalog(); await restarted.init();
  assert.deepEqual(await restarted.resolve(first.id, first.versions[0].id), pinned);
  assert.notEqual((await restarted.resolve(first.id, second.versions[0].id))?.importedImageId, pinned?.importedImageId);
  assert.equal((await restarted.list()).find(image => image.id === first.id)?.versions.length, 2);
  assert.doesNotMatch(JSON.stringify([...f.documents.values()]), /private-password|private-user/);
  assert.doesNotMatch(JSON.stringify(first), /private-password|private-user|"request"/);
  assert.equal(f.submissions[0].body.registryAuth && (f.submissions[0].body.registryAuth as { password: string }).password, 'private-password');
  assert.match(String(f.submissions[0].body.buildCommand), /\/bin\/sh -ec 'cp \/bundled\/git/);
  assert.match(String(f.submissions[0].body.buildCommand), /launcher\.mjs/);
  assert.doesNotMatch(String(f.submissions[0].body.buildCommand), /apt-get|curl|npm install/);
  assert.equal(f.submissions[0].body.runCommand, "docker run -w /home/agent/workspace --entrypoint /usr/local/bin/node 'team/python:v1' /opt/product/cocell/launcher.mjs");
  await assert.rejects(restarted.import({ imageId: first.id, version: 'v1', url: 'team/python:other' }), /版本名称已存在/);
});

test('uncertain submission survives restart and retries the same request and key', async () => {
  const f = fixture(); const catalog = f.catalog(); await catalog.init(); f.loseResponse();
  const image = await catalog.import({ name: 'Private', category: '开发', version: 'v1', url: 'team/private:v1', registryAuth: { username: 'u', password: 'secret' } });
  assert.equal(image.versions[0].status, 'unknown');
  const restarted = f.catalog(); await restarted.init();
  await assert.rejects(restarted.retry(image.id, image.versions[0].id), /重新提供私有仓库凭证/);
  const uncertain = await restarted.retry(image.id, image.versions[0].id, { username: 'u', password: 'incorrect' });
  assert.equal(uncertain.versions[0].status, 'unknown', 'a retry conflict must not mark the original operation failed');
  await restarted.retry(image.id, image.versions[0].id, { username: 'u', password: 'secret' });
  assert.deepEqual(f.submissions[0], f.submissions[2]);
  f.finish(f.submissions[2].key, 'team/private:v1');
  assert.equal((await restarted.list()).find(value => value.id === image.id)?.versions[0].status, 'succeeded');
});

test('existing Cellbox versions are grouped and can gain a new managed version', async () => {
  const f = fixture();
  for (const version of ['v1', 'v2']) {
    f.operations.set(version, { id: version, kind: 'image-import', targetId: version, status: 'running', version: 1, createdAt: '' });
    f.finish(version, `registry:5000/team/python:${version}`);
  }
  f.images.get('v1')!.command = ['/bin/sleep', 'infinity'];
  const catalog = f.catalog(); await catalog.init();
  const existing = (await catalog.list()).find(image => image.origin === 'cellbox')!;
  assert.equal(existing.name, 'registry:5000/team/python'); assert.equal(existing.versions.length, 2);
  await assert.rejects(catalog.resolve(existing.id, 'v1'), /未配置 CoCell 启动器/);
  assert.equal((await catalog.resolve(existing.id, 'v2'))?.importedImageId, 'v2');
  const adopted = await catalog.import({ imageId: existing.id, version: 'v3', url: 'registry:5000/team/python:v3' });
  assert.equal(adopted.versions.length, 3); assert.equal(adopted.origin, 'managed');
  assert.equal((await catalog.list()).filter(image => image.origin === 'cellbox').length, 0);
});

test('build failures remain visible and cannot be chosen; active builds prevent a second submission', async () => {
  const f = fixture(); const catalog = f.catalog(); await catalog.init();
  const image = await catalog.import({ name: 'Node', category: '开发', version: 'v1', url: 'team/node:v1' });
  await assert.rejects(catalog.import({ imageId: image.id, version: 'v2', url: 'team/node:v2' }), /已有镜像正在构建/);
  assert.equal(f.submissions.length, 1);
  const operation = f.operations.get(image.versions[0].operationId!)!;
  operation.status = 'failed'; operation.error = { code: 'BUILD_FAILED', message: 'Codex missing' };
  const version = (await catalog.list()).find(value => value.id === image.id)!.versions[0];
  assert.equal(version.status, 'failed'); assert.equal(version.error, 'Codex missing');
  await assert.rejects(catalog.resolve(image.id, version.id), /已导入成功/);
});

test('project API resolves selections on the server and rejects incomplete or forged selection metadata', async () => {
  const f = fixture(); const catalog = f.catalog(); await catalog.init();
  const image = await catalog.import({ name: 'Node', category: '开发', version: 'v1', url: 'team/node:v1' });
  f.finish(image.versions[0].operationId!, 'team/node:v1');
  const app = new Hono();
  app.onError((error, c) => c.json({ error: error.message }, error instanceof HttpError ? error.status as 400 : error instanceof z.ZodError ? 400 : 500));
  const created: unknown[] = [];
  installImageRoutes(app, catalog);
  installProjectsRoutes(app, { createProject: async (input: Parameters<Parameters<typeof installProjectsRoutes>[1]['createProject']>[0]) => { created.push(input); return input as never; } } as unknown as Parameters<typeof installProjectsRoutes>[1], undefined, catalog);
  const post = (body: unknown) => app.request('/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await post({ name: 'test', imageId: image.id })).status, 400);
  assert.equal((await post({ name: 'test', imageSelection: { importedImageId: 'foreign' } })).status, 400);
  assert.equal((await post({ name: 'test', imageId: image.id, imageVersionId: image.versions[0].id })).status, 201);
  assert.equal((created[0] as { imageSelection: { importedImageId: string } }).imageSelection.importedImageId, image.versions[0].operationId);
  assert.equal((await post({ name: 'default' })).status, 201);
});
