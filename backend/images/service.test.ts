import assert from 'node:assert/strict';
import test from 'node:test';
import { CellboxClient, CellboxError, type CellboxOperation, type CellboxTemplate, type CellboxTemplateRevision } from '../../packages/sandbox/src/providers/cellbox/client.js';
import type { DefaultImageSelection } from '../../protocol/image-types.js';
import type { ImageRecord } from './store.js';
import { ImageCatalog } from './service.js';

function fixture(seed: ImageRecord[] = []) {
  const documents = new Map(seed.map(record => [record.id, structuredClone(record)]));
  const templates = new Map<string, CellboxTemplate>();
  const revisions = new Map<string, CellboxTemplateRevision>();
  const operations = new Map<string, CellboxOperation>();
  const builds: Array<{ templateId: string; input: Record<string, unknown> }> = [];
  const templateUpdates: Array<{ id: string; input: Record<string, unknown> }> = [];
  const defaultWrites: Array<DefaultImageSelection | undefined> = [];
  let defaultSelection: DefaultImageSelection | undefined;
  let unknownNextBuild = false;
  const store = {
    listImages: async () => structuredClone([...documents.values()]),
    saveImage: async (record: ImageRecord) => { documents.set(record.id, structuredClone(record)); },
    loadDefaultImage: async () => structuredClone(defaultSelection),
    saveDefaultImage: async (selection: DefaultImageSelection | undefined, record?: ImageRecord) => {
      defaultSelection = structuredClone(selection);
      defaultWrites.push(structuredClone(selection));
      if (record) documents.set(record.id, structuredClone(record));
    },
  };
  const client = {
    async listTemplates() { return [...templates.values()]; },
    async getTemplate(id: string) { const value = templates.get(id); if (!value) throw new CellboxError('NOT_FOUND', 'template missing'); return value; },
    async createTemplate(input: { name: string; description?: string }) {
      const value: CellboxTemplate = { id: `template-${templates.size + 1}`, ...input, defaultWarmSlots: 0,
        generation: 1, createdAt: '2026-10-18T00:00:00.000Z', updatedAt: '2026-10-18T00:00:00.000Z' };
      templates.set(value.id, value); return value;
    },
    async updateTemplate(id: string, input: Record<string, unknown>) { templateUpdates.push({ id, input }); return templates.get(id)!; },
    async listTemplateRevisions(id: string) { return [...revisions.values()].filter(value => value.templateId === id); },
    async createTemplateRevision(templateId: string, input: Record<string, unknown>) {
      if (unknownNextBuild) { unknownNextBuild = false; throw new CellboxError('UNKNOWN_OUTCOME', 'response lost'); }
      const index = builds.length + 1;
      builds.push({ templateId, input });
      const operation: CellboxOperation = { id: `build-${index}`, kind: 'template-build', targetId: templateId,
        status: 'running', version: 1, createdAt: '2026-10-18T00:00:00.000Z' };
      operations.set(operation.id, operation);
      const revision: CellboxTemplateRevision = { id: `revision-${index}`, templateId, templateName: templates.get(templateId)!.name,
        userVersion: String(input.userVersion), revision: index, version: `${input.userVersion}-r${index}`, profileId: String(input.profileId),
        baseImage: String(input.baseImage), resolvedBaseImage: `${input.baseImage}@sha256:resolved`, image: `built@sha256:${index}`,
        buildCommand: String(input.buildCommand), runCommand: String(input.runCommand), platform: 'linux/amd64', cpu: 2, memoryMiB: 2048,
        warmSlots: 0, status: 'active', generation: 1, buildOperationId: operation.id,
        createdAt: '2026-10-18T00:00:00.000Z', updatedAt: '2026-10-18T00:00:00.000Z' };
      revisions.set(revision.id, revision);
      return operation;
    },
    async getTemplateRevision(id: string) { const value = revisions.get(id); if (!value) throw new CellboxError('NOT_FOUND', 'revision missing'); return value; },
    async updateTemplateRevision(id: string, input: { status: 'active' | 'retired'; expectedGeneration: number }) {
      const value = revisions.get(id)!;
      const updated = { ...value, status: input.status, generation: value.generation + 1, updatedAt: '2026-10-18T01:00:00.000Z' };
      revisions.set(id, updated); return updated;
    },
    async getOperation(id: string) { const value = operations.get(id); if (!value) throw new CellboxError('NOT_FOUND', 'operation missing'); return value; },
  } as unknown as CellboxClient;
  const registry = {
    listTags: async () => ({ tags: ['v1', 'v2'] }),
    resolveTag: async (_repository: string, tag: string) => `sha256:${(tag === 'v1' ? '1' : '2').repeat(64)}`,
  };
  const catalog = (options: { defaultTemplateId?: string; defaultRevisionId?: string } = {}) => new ImageCatalog(store, client, 'profile-test', registry, undefined, options);
  return { catalog, documents, templates, revisions, operations, builds, templateUpdates, defaultWrites,
    setUnknownNextBuild() { unknownNextBuild = true; },
    completeBuild(id: string) {
      const operation = operations.get(id)!;
      operation.status = 'succeeded';
      operation.result = { revisionId: operation.id.replace('build-', 'revision-') };
    },
  };
}

test('catalog creates a Cellbox template and each explicit sync submits one new revision build', async () => {
  const f = fixture();
  const catalog = f.catalog();
  const repository = await catalog.addRepository({ name: 'Node 开发', category: '开发', repository: 'team/node', buildCommand: 'npm install' });
  assert.equal(repository.templateStatus, 'ready');
  assert.equal(f.templates.size, 1);

  const first = await catalog.sync(repository.id, { tag: 'v1' });
  assert.equal(f.builds.length, 1);
  assert.equal(f.builds[0].input.baseImage, `docker.io/team/node@sha256:${'1'.repeat(64)}`);
  assert.equal(first.versions[0].status, 'running');
  f.completeBuild('build-1');
  const ready = await catalog.list();
  const selected = ready.find(image => image.id === repository.id)!.versions.find(version => version.revisionId === 'revision-1')!;
  assert.equal(selected.status, 'succeeded');

  await catalog.sync(repository.id, { tag: 'v1' });
  assert.equal(f.builds.length, 2, 'a deliberate second submit is a new build, even for the same tag');
  assert.notEqual(f.builds[0].input, f.builds[1].input);
});

test('unknown build submission is shown as unknown and is never replayed', async () => {
  const f = fixture();
  const catalog = f.catalog();
  const repository = await catalog.addRepository({ name: 'Python', category: '开发', repository: 'team/python' });
  f.setUnknownNextBuild();
  const result = await catalog.sync(repository.id, { tag: 'v1' });
  assert.equal(result.versions[0].status, 'unknown');
  assert.match(result.versions[0].error!, /response lost/);
  await assert.rejects(catalog.retry(repository.id, result.versions[0].id), /不会自动重放/);
  assert.equal(f.builds.length, 0);
  await catalog.sync(repository.id, { tag: 'v1' });
  assert.equal(f.builds.length, 1, 'a new user submission creates one distinct operation');
});

test('startup changes an interrupted submitting record to unknown without sending a request', async () => {
  const f = fixture();
  f.documents.set('interrupted-template', { id: 'interrupted-template', name: 'Pending', category: '开发',
    origin: 'managed', repository: 'team/pending', versions: [], templateStatus: 'submitting' });
  f.documents.set('interrupted-build', { id: 'interrupted-build', name: 'Build', category: '开发',
    origin: 'managed', templateId: 'template-existing', repository: 'team/build', templateStatus: 'ready',
    versions: [{ id: 'pending-version', templateId: 'template-existing', version: 'v1', source: 'team/build:v1',
      status: 'submitting', createdAt: '2026-10-18T00:00:00.000Z' }] });
  const result = await f.catalog().list();
  assert.equal(result.find(image => image.id === 'interrupted-template')?.templateStatus, 'unknown');
  assert.equal(result.find(image => image.id === 'interrupted-build')?.versions[0].status, 'unknown');
  assert.equal(f.builds.length, 0);
});

test('CoCell default selection is local and does not change Cellbox stable or warm settings', async () => {
  const f = fixture();
  const catalog = f.catalog();
  const repository = await catalog.addRepository({ name: 'Go', category: '开发', repository: 'team/go' });
  const submitted = await catalog.sync(repository.id, { tag: 'v1' });
  f.completeBuild(submitted.versions[0].operationId!);
  const version = (await catalog.list()).find(image => image.id === repository.id)!.versions.find(value => value.revisionId)!;
  await catalog.setDefault(repository.id, version.id);
  assert.deepEqual(f.defaultWrites.at(-1), { templateId: repository.templateId, revisionId: version.revisionId });
  assert.deepEqual(f.templateUpdates, []);
});

test('legacy imported image is visible for migration and cannot resolve as a revision', async () => {
  const old: ImageRecord = { id: 'old-repo', name: '旧仓库', category: '开发', origin: 'managed', repository: 'team/old',
    versions: [{ id: 'old-image', version: 'v1', source: 'team/old:v1', importedImageId: 'img-old', image: 'team/old@sha256:abc',
      status: 'succeeded', createdAt: '2025-01-01T00:00:00.000Z' }] };
  const f = fixture([old]);
  const catalog = f.catalog();
  const listed = await catalog.list();
  assert.equal(listed.find(image => image.id === old.id)?.migrationRequired, true);
  await assert.rejects(catalog.resolve(old.id, 'old-image'), /尚未迁移/);
});

test('request-scoped private registry credentials are explicitly unsupported and are not persisted', async () => {
  const f = fixture();
  const catalog = f.catalog();
  const repository = await catalog.addRepository({ name: '私有镜像', category: '开发', repository: 'team/private', registryAuthRequired: true });
  await assert.rejects(catalog.sync(repository.id, { tag: 'v1', registryAuth: { username: 'user', password: 'secret' } }), /UNSUPPORTED/);
  assert.equal(JSON.stringify([...f.documents.values()]).includes('secret'), false);
  assert.equal(f.builds.length, 0);
});


test('configured revision and template selectors resolve the actual default without rewriting stable', async () => {
  const f = fixture();
  const owner = f.catalog();
  const repository = await owner.addRepository({ name: 'System', category: '系统', repository: 'team/system' });
  await owner.sync(repository.id, { tag: 'v1' });
  f.completeBuild('build-1');
  f.templates.get(repository.templateId!)!.stableRevisionId = 'revision-1';
  for (const options of [{ defaultRevisionId: 'revision-1' }, { defaultTemplateId: repository.templateId! }]) {
    const selected = await f.catalog(options).acquireDefaultSelection();
    assert.equal(selected.selection.revisionId, 'revision-1');
    assert.equal(selected.selection.templateId, repository.templateId);
  }
  assert.deepEqual(f.defaultWrites, []);
  assert.deepEqual(f.templateUpdates, []);
});
