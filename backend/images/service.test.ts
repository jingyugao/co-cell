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
import type { Project } from '../../protocol/types.js';
import { MemoryCoordinator } from '../infra/storage/coordination.js';

function fixture() {
  const documents = new Map<string, ImageRecord>();
  const images = new Map<string, CellboxImportedImage>();
  const operations = new Map<string, CellboxOperation>();
  const submissions: Array<{ key: string; body: Record<string, unknown> }> = [];
  const deletions: string[] = [];
  const projects: Project[] = [];
  const upstream = new Map(['v1', 'v2', 'v3', 'latest'].map((tag, i) => [tag, `sha256:${String(i + 1).repeat(64)}`]));
  let loseResponse = false;
  let rejectDeletion = false;
  const store = { listImages: async () => structuredClone([...documents.values()]),
    saveImage: async (image: ImageRecord) => { documents.set(image.id, structuredClone(image)); } };
  const client = new CellboxClient({ baseUrl: 'http://cellbox.test', fetch: async (input, init) => {
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
      if (path.endsWith('/usage')) return json({ deletable: true, blockers: [], manifestShared: false });
      const image = images.get(decodeURIComponent(path.slice('/v1/images/'.length)));
      if (init?.method === 'DELETE') {
        if (rejectDeletion) return new Response(JSON.stringify({ error: { code: 'CONFLICT', message: 'box still references image' } }), { status: 409 });
        const key = new Headers(init.headers).get('Idempotency-Key')!;
        deletions.push(key);
        const operation: CellboxOperation = operations.get(key) ?? { id: key, kind: 'image-delete', targetId: image!.id, status: 'running', version: 1, createdAt: '' };
        operations.set(key, operation);
        if (loseResponse) { loseResponse = false; throw new Error('connection lost after deletion acceptance'); }
        return json(operation);
      }
      return image ? json(image) : new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'missing image' } }), { status: 404 });
    }
    if (path.startsWith('/v1/operations/')) return json(operations.get(decodeURIComponent(path.slice('/v1/operations/'.length))));
    throw new Error(`Unexpected path ${path}`);
  } });
  const catalog = (coordinator?: MemoryCoordinator) => new ImageCatalog(store, client, 'cocell', {
    listTags: async () => ({ tags: [...upstream.keys()] }),
    resolveTag: async (_repository, tag) => { const digest = upstream.get(tag); if (!digest) throw new HttpError(404, 'Tag 不存在'); return digest; },
  }, () => projects, coordinator);
  function finish(operationId: string, source: string) {
    const operation = operations.get(operationId)!;
    operation.status = 'succeeded'; operation.result = { importedImageId: operationId };
    images.set(operationId, { id: operationId, source, resolvedSource: `${source}@sha256:source`, image: `registry/prepared@sha256:${operationId}`,
      platform: 'linux/amd64', command: ['/usr/local/bin/node', '/opt/product/cocell/launcher.mjs'], env: {}, workingDir: '/home/agent/workspace',
      ports: [], warnings: ['runs as agent'], key: operationId, createdAt: new Date().toISOString() });
  }
  return { catalog, documents, submissions, deletions, projects, operations, images, upstream, finish,
    rejectDeletion: (reject: boolean) => { rejectDeletion = reject; }, loseResponse: () => { loseResponse = true; } };
}

test('image catalog refreshes durable records under a shared lock and shares live restore reservations', async () => {
  const f = fixture(), coordinator = new MemoryCoordinator();
  const firstCatalog = f.catalog(coordinator), secondCatalog = f.catalog(coordinator);
  await Promise.all([firstCatalog.init(), secondCatalog.init()]);
  const repository = await firstCatalog.addRepository({ name: 'Shared', category: '开发', repository: 'team/shared' });
  await assert.rejects(secondCatalog.addRepository({ name: 'Shared', category: '开发', repository: 'team/shared' }), /该镜像仓库已添加/);

  const first = (await firstCatalog.sync(repository.id, { tag: 'v1' })).versions[0];
  f.finish(first.operationId!, first.source);
  await firstCatalog.list();
  const second = (await firstCatalog.sync(repository.id, { tag: 'v2' })).versions[0];
  f.finish(second.operationId!, second.source);
  await firstCatalog.list();
  const pinned = (await firstCatalog.resolve(repository.id, first.id))!;
  const reservation = await firstCatalog.acquireRestoreSelection({ id: 'archived-project', name: 'archived',
    executionMode: 'sandbox', workingDirectory: '/workspace', status: 'archived', imageSelection: pinned,
    requirementUrl: null, createdAt: '', updatedAt: '' }, second.id);
  await assert.rejects(secondCatalog.removeVersion(repository.id, second.id), /正在被创建或恢复/);
  await reservation.release();
  f.projects.push({ id: 'restore-p', name: 'restore-p', executionMode: 'sandbox', workingDirectory: '/workspace',
    status: 'archived', imageSelection: pinned, requirementUrl: null, createdAt: '', updatedAt: '',
    sandboxOperation: { kind: 'restore', phase: '恢复 Sandbox', status: 'failed', updatedAt: '', imageSelection: reservation.selection } });
  await assert.rejects(secondCatalog.removeVersion(repository.id, second.id), /恢复操作仍引用此版本/);
  delete f.projects[0].sandboxOperation;
  await secondCatalog.removeVersion(repository.id, second.id);
  await coordinator.close();
});

test('version cleanup protects pinned projects, backups, defaults and in-flight restore reservations', async () => {
  const f = fixture(); const catalog = f.catalog(); await catalog.init();
  const repo = await catalog.addRepository({ name: 'Go', category: '开发', repository: 'team/go' });
  const first = (await catalog.sync(repo.id, { tag: 'v1' })).versions[0]; f.finish(first.operationId!, first.source);
  const original = (await catalog.resolve(repo.id, first.id))!;
  const second = (await catalog.sync(repo.id, { tag: 'v2' })).versions[0]; f.finish(second.operationId!, second.source);
  await catalog.resolve(repo.id, second.id);
  assert.equal((await catalog.list()).find(image => image.id === repo.id)?.defaultVersionId, first.id, 'sync alone must not switch restore defaults');
  await assert.rejects(catalog.removeVersion(repo.id, first.id), /默认版本/);
  await catalog.setDefault(repo.id, second.id);
  const project: Project = { id: 'p', name: 'Go 服务', requirementUrl: null, executionMode: 'sandbox', workingDirectory: '/home/agent/workspace', status: 'active', imageSelection: original, createdAt: '', updatedAt: '' };
  f.projects.push(project);
  await assert.rejects(catalog.removeVersion(repo.id, first.id), /仍固定此版本/);
  project.status = 'archived';
  project.remoteArchives = [{ id: 'archive', createdAt: '', sizeBytes: 1, sha256: 'a'.repeat(64), imageId: original.image, sourceSandboxId: 'box', threadIds: [] }];
  await assert.rejects(catalog.removeVersion(repo.id, first.id), /依赖原镜像的备份/);
  project.remoteArchives[0].portable = true;
  const restore = await catalog.acquireRestoreSelection(project);
  assert.equal(restore.selection?.versionId, second.id); await restore.release();
  const oldRestore = await catalog.acquireRestoreSelection(project, first.id);
  await assert.rejects(catalog.removeVersion(repo.id, first.id), /创建或恢复操作/); await oldRestore.release();
  project.pendingSandboxCleanup = [{ id: 'stale', template: 'cocell', status: 'unavailable', workingDirectory: project.workingDirectory, image: { id: original.image, reference: original.image, repoDigests: [] } }];
  await assert.rejects(catalog.removeVersion(repo.id, first.id), /待清理环境/);
  project.pendingSandboxCleanup = [];
  assert.equal((await catalog.usage(repo.id, first.id)).deletable, true);
  f.rejectDeletion(true);
  await assert.rejects(catalog.removeVersion(repo.id, first.id), /镜像仍被引用/);
  assert.deepEqual(await catalog.resolve(repo.id, first.id), original, 'a rejected delete must leave the version available');
  f.rejectDeletion(false);
  const pending = await catalog.removeVersion(repo.id, first.id);
  assert.equal(pending.versions.find(version => version.id === first.id)?.cleanup?.status, 'pending');
  await assert.rejects(catalog.resolve(repo.id, first.id), /正在清理/);
  const cleanup = f.operations.get(f.deletions[0])!; cleanup.status = 'succeeded'; f.images.delete(cleanup.targetId);
  assert.equal((await catalog.list()).find(image => image.id === repo.id)?.versions.some(version => version.id === first.id), false);
  assert.equal((await catalog.acquireRestoreSelection(project)).selection?.versionId, second.id);
});

test('lost cleanup acceptance remains unavailable across restart and retries the durable key', async () => {
  const f = fixture(); const catalog = f.catalog(); await catalog.init();
  const repo = await catalog.addRepository({ name: 'Node', category: '开发', repository: 'team/node' });
  const old = (await catalog.sync(repo.id, { tag: 'v1' })).versions[0]; f.finish(old.operationId!, old.source);
  await catalog.resolve(repo.id, old.id);
  const next = (await catalog.sync(repo.id, { tag: 'v2' })).versions[0]; f.finish(next.operationId!, next.source);
  await catalog.setDefault(repo.id, next.id);
  f.loseResponse();
  const unknown = await catalog.removeVersion(repo.id, old.id);
  assert.equal(unknown.versions.find(version => version.id === old.id)?.cleanup?.status, 'unknown');
  const restarted = f.catalog(); await restarted.init();
  await assert.rejects(restarted.resolve(repo.id, old.id), /正在清理/);
  await restarted.removeVersion(repo.id, old.id);
  assert.equal(f.deletions[0], f.deletions[1]);
  const operation = f.operations.get(f.deletions[0])!; operation.status = 'succeeded'; f.images.delete(operation.targetId);
  assert.equal((await restarted.list()).find(image => image.id === repo.id)?.versions.length, 1);
});

test('versions resolve to distinct immutable images; records survive restart without credentials', async () => {
  const f = fixture(); const catalog = f.catalog(); await catalog.init();
  const repo = await catalog.addRepository({ name: 'Python', category: '开发环境', repository: 'team/python',
    buildCommand: 'cp /bundled/git /usr/local/bin/git' });
  assert.equal(repo.repository, 'docker.io/team/python'); assert.equal(repo.versions.length, 0); assert.equal(f.submissions.length, 0);
  assert.deepEqual((await catalog.tags(repo.id)).tags, [...f.upstream.keys()]);
  const first = await catalog.sync(repo.id, { tag: 'v1', registryAuth: { username: 'private-user', password: 'private-password' } });
  await assert.rejects(catalog.resolve(first.id, first.versions[0].id), /已导入成功/);
  f.finish(first.versions[0].operationId!, 'team/python:v1');
  const pinned = await catalog.resolve(first.id, first.versions[0].id);
  const second = await catalog.sync(first.id, { tag: 'v2' });
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
  assert.equal(f.submissions[0].body.url, `docker.io/team/python@${f.upstream.get('v1')}`);
  assert.equal(f.submissions[0].body.runCommand, `docker run -w /home/agent/workspace --entrypoint /usr/local/bin/node 'docker.io/team/python@${f.upstream.get('v1')}' /opt/product/cocell/launcher.mjs`);
  await restarted.sync(first.id, { tag: 'v1' });
  assert.equal(f.submissions.length, 2, 'unchanged upstream digest must not rebuild');
});

test('an upstream tag update creates a new pinned revision without changing existing project selections', async () => {
  const f = fixture(); const catalog = f.catalog(); await catalog.init();
  const repo = await catalog.addRepository({ name: 'Node', category: '开发', repository: 'team/node' });
  const first = await catalog.sync(repo.id, { tag: 'latest' });
  const original = first.versions[0]; f.finish(original.operationId!, original.source);
  const selection = await catalog.resolve(repo.id, original.id);
  f.upstream.set('latest', `sha256:${'a'.repeat(64)}`);
  const updated = await catalog.sync(repo.id, { tag: 'latest' });
  assert.equal(updated.versions.length, 2);
  assert.equal(updated.versions[0].version, 'latest'); assert.equal(updated.versions[1].version, 'latest');
  assert.notEqual(updated.versions[0].id, original.id);
  assert.equal(f.submissions[1].body.url, `docker.io/team/node@sha256:${'a'.repeat(64)}`);
  f.finish(updated.versions[0].operationId!, updated.versions[0].source);
  const restarted = f.catalog(); await restarted.init();
  assert.deepEqual(await restarted.resolve(repo.id, original.id), selection);
  assert.notEqual((await restarted.resolve(repo.id, updated.versions[0].id))?.image, selection?.image);
});

test('uncertain submission survives restart and retries the same request and key', async () => {
  const f = fixture(); const catalog = f.catalog(); await catalog.init(); f.loseResponse();
  const repo = await catalog.addRepository({ name: 'Private', category: '开发', repository: 'team/private', registryAuthRequired: true });
  await assert.rejects(catalog.tags(repo.id), /提供私有仓库/);
  const image = await catalog.sync(repo.id, { tag: 'v1', registryAuth: { username: 'u', password: 'secret' } });
  assert.equal(image.versions[0].status, 'unknown');
  const restarted = f.catalog(); await restarted.init();
  await assert.rejects(restarted.sync(repo.id, { tag: 'v2', registryAuth: { username: 'u', password: 'secret' } }), /结果待确认/);
  await assert.rejects(restarted.retry(image.id, image.versions[0].id), /重新提供私有仓库凭证/);
  const uncertain = await restarted.retry(image.id, image.versions[0].id, { username: 'u', password: 'incorrect' });
  assert.equal(uncertain.versions[0].status, 'unknown', 'a retry conflict must not mark the original operation failed');
  await restarted.retry(image.id, image.versions[0].id, { username: 'u', password: 'secret' });
  assert.deepEqual(f.submissions[0], f.submissions[2]);
  f.finish(f.submissions[2].key, 'team/private:v1');
  assert.equal((await restarted.list()).find(value => value.id === image.id)?.versions[0].status, 'succeeded');
});

test('existing Cellbox versions are grouped and retain readiness validation', async () => {
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
  await assert.rejects(catalog.sync(existing.id, { tag: 'v3' }), /镜像仓库不存在/);
});

test('build failures remain visible and cannot be chosen; active builds prevent a second submission', async () => {
  const f = fixture(); const catalog = f.catalog(); await catalog.init();
  const repo = await catalog.addRepository({ name: 'Node', category: '开发', repository: 'team/node' });
  const image = await catalog.sync(repo.id, { tag: 'v1' });
  await assert.rejects(catalog.sync(image.id, { tag: 'v2' }), /已有版本正在同步/);
  assert.equal(f.submissions.length, 1);
  const operation = f.operations.get(image.versions[0].operationId!)!;
  operation.status = 'failed'; operation.error = { code: 'BUILD_FAILED', message: 'Codex missing' };
  const version = (await catalog.list()).find(value => value.id === image.id)!.versions[0];
  assert.equal(version.status, 'failed'); assert.equal(version.error, 'Codex missing');
  await assert.rejects(catalog.resolve(image.id, version.id), /已导入成功/);
  const retry = await catalog.sync(image.id, { tag: 'v1' });
  assert.notEqual(retry.versions[0].id, version.id); assert.equal(f.submissions.length, 2);
});

test('project API resolves selections on the server and rejects incomplete or forged selection metadata', async () => {
  const f = fixture(); const catalog = f.catalog(); await catalog.init();
  const repo = await catalog.addRepository({ name: 'Node', category: '开发', repository: 'team/node' });
  const image = await catalog.sync(repo.id, { tag: 'v1' });
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
  const repositoryRequest = (body: unknown) => app.request('/api/images/repositories', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await repositoryRequest({ name: 'Invalid', category: '开发', repository: 'team/other:v1' })).status, 400);
  assert.equal((await repositoryRequest({ name: 'Invalid', category: '开发', repository: 'team/other', registryAuth: { username: 'u', password: 'secret' } })).status, 400);
  const registered = await repositoryRequest({ name: 'Other', category: '开发', repository: 'team/other' });
  assert.equal(registered.status, 201);
  const saved = await registered.json() as { id: string; versions: unknown[] };
  assert.deepEqual(saved.versions, []); assert.equal(f.submissions.length, 1, 'adding a repository must not build any version');
  const tags = await app.request(`/api/images/${saved.id}/tags`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(tags.status, 200); assert.deepEqual(await tags.json(), { tags: [...f.upstream.keys()] });
  assert.equal((await repositoryRequest({ name: 'Duplicate', category: '开发', repository: 'docker.io/team/other' })).status, 409);
  const sync = (body: unknown) => app.request(`/api/images/${repo.id}/versions/sync`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await sync({ tag: 'v1', version: 'fake', url: 'foreign/image:v1' })).status, 400);
  assert.equal((await sync({ tag: '../v1' })).status, 400);
  assert.equal((await sync({ tag: 'v1' })).status, 202);
});

test('a rejected cleanup retry retains the failed operation for safe retry', async () => {
  const f = fixture(); const catalog = f.catalog(); await catalog.init();
  const repo = await catalog.addRepository({ name: 'Node', category: '开发', repository: 'team/node' });
  const old = (await catalog.sync(repo.id, { tag: 'v1' })).versions[0]; f.finish(old.operationId!, old.source);
  await catalog.resolve(repo.id, old.id);
  const next = (await catalog.sync(repo.id, { tag: 'v2' })).versions[0]; f.finish(next.operationId!, next.source);
  await catalog.setDefault(repo.id, next.id);
  await catalog.removeVersion(repo.id, old.id);
  const operation = f.operations.get(f.deletions[0])!;
  operation.status = 'failed'; operation.error = { code: 'TRANSPORT', message: 'Registry deletion failed' };
  await catalog.list();
  f.rejectDeletion(true);
  await assert.rejects(catalog.removeVersion(repo.id, old.id), /镜像仍被引用/);
  const listed = (await catalog.list()).find(image => image.id === repo.id)!;
  assert.equal(listed.versions.find(version => version.id === old.id)?.cleanup?.status, 'failed');
  await assert.rejects(catalog.resolve(repo.id, old.id), /正在清理/);
});


test('deprecation persists, blocks new selections and moves restore default without changing pinned projects', async () => {
  const f = fixture(); const catalog = f.catalog(); await catalog.init();
  const repo = await catalog.addRepository({ name: 'Go', category: '开发', repository: 'team/go' });
  const first = (await catalog.sync(repo.id, { tag: 'v1' })).versions[0]; f.finish(first.operationId!, first.source);
  const pinned = (await catalog.resolve(repo.id, first.id))!;
  const second = (await catalog.sync(repo.id, { tag: 'v2' })).versions[0]; f.finish(second.operationId!, second.source);
  const project: Project = { id: 'p', name: 'Pinned', requirementUrl: null, executionMode: 'sandbox', workingDirectory: '/home/agent/workspace', status: 'active', imageSelection: pinned, createdAt: '', updatedAt: '' };
  f.projects.push(project);
  const app = new Hono();
  app.onError((error, c) => c.json({ error: error.message }, error instanceof HttpError ? error.status as 400 : error instanceof z.ZodError ? 400 : 500));
  installImageRoutes(app, catalog);
  const patch = (body: unknown) => app.request(`/api/images/${repo.id}/versions/${first.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await patch({ deprecated: 'true' })).status, 400);
  assert.equal((await patch({ deprecated: true })).status, 200);
  assert.equal((await catalog.list()).find(value => value.id === repo.id)?.defaultVersionId, second.id);
  assert.deepEqual(project.imageSelection, pinned);
  assert.equal(f.deletions.length, 0, 'deprecation must not delete the runtime image');
  const restarted = f.catalog(); await restarted.init();
  await assert.rejects(restarted.acquireSelection(repo.id, first.id), /已弃用/);
  await assert.rejects(restarted.setDefault(repo.id, first.id), /已弃用/);
  await assert.rejects(restarted.acquireRestoreSelection(project, first.id), /已弃用/);
  const restore = await restarted.acquireRestoreSelection(project);
  assert.equal(restore.selection?.versionId, second.id); await restore.release();
  await restarted.setDeprecated(repo.id, second.id, true);
  assert.equal((await restarted.list()).find(value => value.id === repo.id)?.defaultVersionId, undefined);
  await assert.rejects(restarted.acquireRestoreSelection(project), /没有可恢复/);
  await restarted.setDeprecated(repo.id, first.id, false);
  assert.deepEqual(await restarted.resolve(repo.id, first.id), pinned);
  assert.equal((await restarted.list()).find(value => value.id === repo.id)?.defaultVersionId, first.id);
});

test('Cellbox-discovered image lifecycle flags survive restart without duplicating inventory or enabling repository sync', async () => {
  const f = fixture();
  f.operations.set('external', { id: 'external', kind: 'image-import', targetId: 'external', status: 'running', version: 1, createdAt: '' });
  f.finish('external', 'docker.io/team/node:v1');
  const catalog = f.catalog(); await catalog.init();
  const image = (await catalog.list()).find(value => value.origin === 'cellbox')!;
  await catalog.setDeprecated(image.id, 'external', true);
  const restarted = f.catalog(); await restarted.init();
  const inventory = (await restarted.list()).filter(value => value.id === image.id);
  assert.equal(inventory.length, 1); assert.ok(inventory[0].versions[0].deprecatedAt);
  await assert.rejects(restarted.resolve(image.id, 'external'), /已弃用/);
  await assert.rejects(restarted.sync(image.id, { tag: 'v2' }), /镜像仓库不存在/);
  await assert.rejects(restarted.setDeprecated('default', 'default', true), /平台配置/);
  await restarted.setDeprecated(image.id, 'external', false);
  assert.equal((await restarted.resolve(image.id, 'external'))?.importedImageId, 'external');
  const repo = await restarted.addRepository({ name: 'Node', category: '开发', repository: 'team/node' });
  assert.equal(repo.origin, 'managed', 'lifecycle flags must not prevent adding the upstream repository');
});


test('repository cleanup requires all versions removed and remains hidden across restart', async () => {
  const f = fixture(); const catalog = f.catalog(); await catalog.init();
  const repo = await catalog.addRepository({ name: 'Demo', category: '开发', repository: 'team/demo' });
  const version = (await catalog.sync(repo.id, { tag: 'v1' })).versions[0]; f.finish(version.operationId!, version.source);
  await assert.rejects(catalog.removeRepository(repo.id), /所有版本/);
  await catalog.setDeprecated(repo.id, version.id, true);
  await catalog.removeVersion(repo.id, version.id);
  const operation = f.operations.get(f.deletions[0])!; operation.status = 'succeeded'; f.images.delete(operation.targetId);
  await catalog.removeRepository(repo.id);
  await catalog.removeRepository(repo.id);
  const restarted = f.catalog(); await restarted.init();
  assert.equal((await restarted.list()).some(image => image.id === repo.id), false);
  await assert.rejects(restarted.sync(repo.id, { tag: 'v2' }), /镜像仓库不存在/);
  await restarted.addRepository({ name: 'Demo', category: '开发', repository: 'team/demo' });
});

test('managed repositories hide duplicate imports while pinned imports still resolve and restore', async () => {
  const f = fixture(); const catalog = f.catalog(); await catalog.init();
  const source = 'registry.example/team/mybox@sha256:' + 'a'.repeat(64);
  f.images.set('external', { id: 'external', source, resolvedSource: source, image: 'registry/prepared@sha256:' + 'b'.repeat(64),
    platform: 'linux/amd64', command: ['/usr/local/bin/node', '/opt/product/cocell/launcher.mjs'], env: {}, workingDir: '/home/agent/workspace',
    ports: [], warnings: [], key: 'external', createdAt: new Date().toISOString() });
  const pinned = (await catalog.resolve('cellbox:registry.example/team/mybox', 'external'))!;
  await catalog.addRepository({ name: 'mybox', category: '自定义', repository: 'http://registry.example/team/mybox' });
  assert.equal((await catalog.list()).filter(image => image.repository?.endsWith('/team/mybox')).length, 1);
  assert.deepEqual(await catalog.resolve(pinned.imageId, pinned.versionId), pinned);
  const project: Project = { id: 'p', name: 'existing', status: 'active', executionMode: 'sandbox', workingDirectory: '/home/agent/workspace',
    requirementUrl: null, createdAt: '', updatedAt: '', imageSelection: pinned };
  const reservation = await catalog.acquireRestoreSelection(project);
  assert.deepEqual(reservation.selection, pinned); await reservation.release();
});

test('sync rebuilds unchanged upstream content when the platform tool installation changes', async () => {
  const f = fixture(); const catalog = f.catalog(); await catalog.init();
  const repo = await catalog.addRepository({ name: 'mybox', category: '自定义', repository: 'team/mybox' });
  const first = (await catalog.sync(repo.id, { tag: 'v1' })).versions[0]; f.finish(first.operationId!, first.source);
  await catalog.list();
  const saved = f.documents.get(repo.id)!;
  saved.versions[0].request.buildCommand = 'old launcher without proxies';
  const restarted = f.catalog(); await restarted.init();
  const rebuilt = await restarted.sync(repo.id, { tag: 'v1' });
  assert.equal(rebuilt.versions.length, 2);
  assert.notEqual(rebuilt.versions[0].id, first.id);
  assert.match(String(f.submissions.at(-1)!.body.buildCommand), /proxy-tool-ids\.json/);
  assert.match(String(f.submissions.at(-1)!.body.buildCommand), /\/usr\/local\/bin\/\$tool/);
});
