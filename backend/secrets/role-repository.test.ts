import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool, PoolConnection } from 'mysql2/promise';
import type { ToolPermission, ToolRole } from '../../protocol/secret-types.js';
import { HttpError } from '../../util/errors.js';
import { MemoryRoleRepository, MySqlRoleRepository } from './role-repository.js';

const mysql = (credentials: string[]): ToolPermission => ({ tool: 'mysql', enabled: true, credentials });
const role = (id: string, name: string, permissions: ToolPermission[] = []): ToolRole => ({
  id, name, permissions,
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
});

const rejectsWithStatus = (status: number) => (error: unknown) => error instanceof HttpError && error.status === status;

test('MySQL role repository maps the legacy connections JSON column to permission arrays', async () => {
  const permissions = [mysql(['analytics', 'warehouse']), { tool: 'lark-cli', enabled: true } satisfies ToolPermission];
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  const connection = {
    beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release: () => {},
    query: async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      if (sql.startsWith('SELECT id FROM tool_roles')) return [[{ id: 'role-a' }], []];
      return [[], []];
    },
  };
  const pool = {
    query: async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      if (sql.startsWith('SELECT id,name,connections')) return [[{ id: 'role-a', name: 'Ops', connections: JSON.stringify(permissions), created_at: 'created', updated_at: 'updated' }], []];
      if (sql.startsWith('SELECT default_role_id')) return [[{ default_role_id: 'role-a' }], []];
      return [[], []];
    },
    getConnection: async () => connection,
  } as unknown as Pool;
  const repository = new MySqlRoleRepository(pool);
  assert.deepEqual((await repository.catalog()).roles[0].permissions, permissions);

  const updated = [mysql(['warehouse'])];
  await repository.saveRole(role('role-a', 'Ops', updated), 'update');
  const write = calls.find(call => call.sql.startsWith('UPDATE tool_roles SET'));
  assert.ok(write);
  assert.deepEqual(JSON.parse(String(write.params?.[1])), updated);
  assert.equal(calls.some(call => call.sql.includes('FROM secrets')), false, 'role persistence no longer resolves or locks Secret IDs');
});

test('role writes enforce name uniqueness and distinguish create from update', async () => {
  const repository = new MemoryRoleRepository();
  await repository.bootstrap();
  await repository.saveRole(role('role-a', 'Ops', [mysql(['warehouse'])]), 'create');
  await assert.rejects(repository.saveRole(role('role-b', 'ops'), 'create'), rejectsWithStatus(409));
  await assert.rejects(repository.saveRole(role('role-c', 'Other'), 'update'), rejectsWithStatus(404));
  await assert.rejects(repository.saveRole(role('role-a', 'Renamed'), 'create'), rejectsWithStatus(409));
  const updated = role('role-a', 'Renamed', [mysql(['analytics', 'warehouse'])]);
  await repository.saveRole(updated, 'update');
  assert.deepEqual((await repository.catalog()).roles.find(item => item.id === 'role-a')?.permissions, updated.permissions);
});

test('default assignment snapshots once, preserves explicit null, and blocks deletion while referenced', async () => {
  const repository = new MemoryRoleRepository();
  await assert.rejects(repository.assignDefault('project-before-setup'), rejectsWithStatus(503));
  await assert.rejects(repository.catalog(), rejectsWithStatus(503));
  await repository.bootstrap();
  await repository.saveRole(role('role-a', 'Ops'), 'create');
  await repository.saveRole(role('role-b', 'Read only'), 'create');
  await repository.setDefault('role-a');
  await repository.assignDefault('project-a');
  assert.deepEqual(await repository.assignment('project-a'), { roleId: 'role-a' });

  await repository.assign('project-b', null);
  await repository.setDefault('role-b');
  await repository.assignDefault('project-b');
  assert.deepEqual(await repository.assignment('project-b'), { roleId: null });
  await assert.rejects(repository.deleteRole('role-a'), rejectsWithStatus(409));

  await repository.assign('project-a', null);
  await repository.deleteRole('role-a');
  assert.equal((await repository.catalog()).roles.some(item => item.id === 'role-a'), false);
});

test('bootstrap creates an empty Default role when none exists', async () => {
  const repository = new MemoryRoleRepository(() => ['project-a']);
  await repository.bootstrap();
  const catalog = await repository.catalog();
  assert.equal(catalog.roles.length, 1);
  assert.equal(catalog.roles[0].name, 'Default');
  assert.deepEqual(catalog.roles[0].permissions, []);
  assert.equal(catalog.defaultRoleId, catalog.roles[0].id);
  assert.deepEqual(await repository.assignment('project-a'), { roleId: catalog.roles[0].id });
});

test('bootstrap migrates every existing project to one empty default once', async () => {
  const projects = ['active-project', 'archived-project'];
  const repository = new MemoryRoleRepository(() => projects);
  await repository.saveRole(role('legacy-default', 'Legacy access', [mysql(['old-profile'])]), 'create');
  await repository.saveRole(role('other-role', 'Other'), 'create');
  await repository.setDefault('legacy-default');
  await repository.assign('active-project', 'other-role');

  await repository.bootstrap();

  const catalog = await repository.catalog();
  assert.equal(catalog.defaultRoleId, 'legacy-default');
  assert.deepEqual(catalog.roles.find(item => item.id === 'legacy-default')?.permissions, []);
  assert.deepEqual(await repository.assignment('active-project'), { roleId: 'legacy-default' });
  assert.deepEqual(await repository.assignment('archived-project'), { roleId: 'legacy-default' });

  // New projects take the configured default. Later bootstraps preserve
  // operator edits and project assignments made after the one-time migration.
  await repository.assignDefault('new-project');
  const updated = [mysql(['operator-profile'])];
  await repository.saveRole(role('legacy-default', 'Legacy access', updated), 'update');
  await repository.assign('active-project', 'other-role');
  await repository.bootstrap();
  assert.deepEqual(await repository.assignment('active-project'), { roleId: 'other-role' });
  assert.deepEqual(await repository.assignment('new-project'), { roleId: 'legacy-default' });
  assert.deepEqual((await repository.catalog()).roles.find(item => item.id === 'legacy-default')?.permissions, updated);
});
