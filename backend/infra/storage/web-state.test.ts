import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Project } from '../../../protocol/types.js';
import { createWebStateStore, MySqlWebStateStore } from './web-state.js';
import { projectFromRow } from './relational-records.js';

test('metadata storage requires MYSQL_URL and rejects invalid URLs without exposing credentials', () => {
  for (const value of [undefined, '', ' \t\n']) {
    assert.throws(() => createWebStateStore(value), /MYSQL_URL is required/);
  }
  for (const value of ['file:///tmp/state', 'postgres://user:secret@localhost/db', 'mysql://localhost', 'mysql://user:secret@host:invalid/db']) {
    assert.throws(() => createWebStateStore(value), error => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /MYSQL_URL must be a valid mysql:\/\/ URL/);
      assert.equal(error.message.includes('secret'), false);
      return true;
    });
  }
});

test('configured metadata storage is MySQL without connecting until initialization', async () => {
  const store = createWebStateStore('mysql://user:unused@database.invalid/cocell');
  assert.ok(store instanceof MySqlWebStateStore);
  await store.close();
});

test('database initialization failure propagates instead of falling back to local files', async () => {
  const store = Object.create(MySqlWebStateStore.prototype) as MySqlWebStateStore;
  Object.assign(store, { previewGrants: { async init() {} } });
  const failure = new Error('Database unavailable');
  (store as unknown as { pool: { query: () => Promise<unknown> } }).pool = {
    async query() { throw failure; },
  };
  await assert.rejects(store.init(), error => error === failure);
});

const now = '2026-09-24T00:00:00.000Z';

function rowFromProjectWrite(sql: string, values: unknown[] = []): Record<string, unknown> {
  const match = /^INSERT INTO projects \(([^)]+)\)/.exec(sql);
  assert.ok(match, 'Expected a relational project upsert');
  const columns = match[1].split(',');
  assert.equal(values.length, columns.length);
  return Object.fromEntries(columns.map((column, index) => [column, values[index]]));
}

test('baseline project writes merge the latest row and retain the latest image selector across reloads', async () => {
  const baseline: Project = { id: 'merge-project', name: 'before', type: 1, status: 'active', requirementUrl: null,
    executionMode: 'sandbox', workingDirectory: '/workspace', createdAt: now, updatedAt: now,
    imageSelection: { selectionPolicy: 'latest', imageId: 'mybox', imageName: 'mybox', category: 'development',
      versionId: 'revision-1', version: '1.0.4-r1', templateId: 'template-1', revisionId: 'revision-1', image: 'mybox@sha256:built' } };
  let stored: Record<string, unknown> = { id: baseline.id, name: baseline.name, type: 1, status: 'active',
    requirement_url: null, requirement_status: 'written by another instance', execution_mode: 'sandbox',
    working_directory: '/workspace', created_at: now, updated_at: now,
    image_catalog_id: 'mybox', image_name: 'mybox', image_category: 'development', image_version_id: 'latest',
    image_version: '1.0.4-r1', template_id: 'template-1', revision_id: 'revision-1', image_reference: 'mybox@sha256:built' };
  const statements: string[] = [];
  const connection = {
    async beginTransaction() { statements.push('begin'); },
    async commit() { statements.push('commit'); },
    async rollback() { statements.push('rollback'); },
    release() { statements.push('release'); },
    async query(sql: string, values?: unknown[]) {
      statements.push(sql);
      if (sql.includes('FOR UPDATE')) {
        assert.match(sql, /^SELECT .* FROM projects WHERE id=\? FOR UPDATE$/s);
        assert.deepEqual(values, [baseline.id]);
        return [[structuredClone(stored)], []];
      }
      stored = rowFromProjectWrite(sql, values);
      return [[], []];
    },
  };
  const store = Object.create(MySqlWebStateStore.prototype) as MySqlWebStateStore;
  Object.assign(store, { pool: { getConnection: async () => connection } });
  await store.saveProject({ ...baseline, name: 'after' }, baseline);
  assert.equal(stored.name, 'after');
  assert.equal(stored.requirement_status, 'written by another instance');
  assert.equal(stored.image_version_id, 'latest');
  assert.equal(stored.revision_id, 'revision-1');
  assert.deepEqual(projectFromRow(stored).imageSelection, baseline.imageSelection);
  assert.equal(projectFromRow({ ...stored, image_version_id: 'revision-1' }).imageSelection?.selectionPolicy, undefined);
  assert.equal(statements[0], 'begin');
  assert.deepEqual(statements.slice(-2), ['commit', 'release']);
});

test('project mutation uses the latest locked row, skips no-op writes, and rolls back callback failures', async () => {
  const id = 'mutate-project';
  let stored: Record<string, unknown> = { id, name: 'latest name', type: 1, status: 'active', requirement_url: null,
    requirement_status: 'externally refreshed', execution_mode: 'sandbox', working_directory: '/latest',
    created_at: now, updated_at: now };
  let writes = 0, rollbacks = 0, commits = 0, releases = 0;
  const statements: string[] = [];
  const connection = {
    async beginTransaction() { statements.push('begin'); },
    async commit() { commits++; statements.push('commit'); },
    async rollback() { rollbacks++; statements.push('rollback'); },
    release() { releases++; },
    async query(sql: string, values?: unknown[]) {
      statements.push(sql);
      if (sql.includes('FOR UPDATE')) {
        assert.match(sql, /^SELECT .* FROM projects WHERE id = \? FOR UPDATE$/s);
        assert.deepEqual(values, [id]);
        return [[structuredClone(stored)], []];
      }
      writes++;
      stored = rowFromProjectWrite(sql, values);
      return [[], []];
    },
  };
  const store = Object.create(MySqlWebStateStore.prototype) as MySqlWebStateStore;
  Object.assign(store, { pool: { getConnection: async () => connection } });

  const result = await store.mutateProject(id, current => { current.name = 'callback name'; });
  assert.equal(result.name, 'callback name');
  assert.equal(stored.name, 'callback name');
  assert.equal(stored.requirement_status, 'externally refreshed');
  assert.equal(stored.working_directory, '/latest');
  assert.equal(statements[0], 'begin');
  assert.match(statements[2], /^INSERT INTO projects/);
  assert.equal(statements[3], 'commit');
  assert.equal(writes, 1);

  const priorStored = structuredClone(stored);
  statements.length = 0;
  const noOp = await store.mutateProject(id, () => {});
  assert.equal(noOp.name, priorStored.name);
  assert.equal(writes, 1, 'a no-op mutation commits without issuing a project write');
  assert.equal(commits, 2);
  assert.equal(rollbacks, 0);

  const failure = new Error('callback rejected');
  statements.length = 0;
  await assert.rejects(store.mutateProject(id, () => { throw failure; }), error => error === failure);
  assert.deepEqual(stored, priorStored);
  assert.equal(writes, 1, 'a rejected callback never reaches the upsert');
  assert.equal(rollbacks, 1);
  assert.equal(commits, 2);
  assert.equal(releases, 3, 'each transaction releases its dedicated connection');
  assert.equal(statements.at(-1), 'rollback');
});
