import assert from 'node:assert/strict';
import test from 'node:test';
import type { ToolRole } from '../../protocol/secret-types.js';
import { HttpError } from '../../util/errors.js';
import { MemoryRoleRepository } from './role-repository.js';

const role = (id: string, name: string, secretId?: string): ToolRole => ({
  id, name, connections: secretId ? [{ tool: 'mysql', alias: 'primary', secretId }] : [],
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
});

const rejectsWithStatus = (status: number) => (error: unknown) => error instanceof HttpError && error.status === status;

test('role writes validate secrets, enforce name uniqueness, and distinguish create from update', async () => {
  const secrets = new Set<string>();
  const repository = new MemoryRoleRepository(id => secrets.has(id));
  await repository.bootstrap();
  await assert.rejects(repository.saveRole(role('role-a', 'Ops', 'secret-a'), 'create'), rejectsWithStatus(400));

  secrets.add('secret-a');
  await repository.saveRole(role('role-a', 'Ops', 'secret-a'), 'create');
  await assert.rejects(repository.saveRole(role('role-b', 'ops'), 'create'), rejectsWithStatus(409));
  await assert.rejects(repository.saveRole(role('role-c', 'Other'), 'update'), rejectsWithStatus(404));
  await assert.rejects(repository.saveRole(role('role-a', 'Renamed'), 'create'), rejectsWithStatus(409));
  await repository.saveRole(role('role-a', 'Renamed'), 'update');
  assert.equal((await repository.catalog()).roles.find(item => item.id === 'role-a')?.name, 'Renamed');
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
  const repository = new MemoryRoleRepository(() => false, () => ['project-a']);
  await repository.bootstrap();
  const catalog = await repository.catalog();
  assert.equal(catalog.roles.length, 1);
  assert.equal(catalog.roles[0].name, 'Default');
  assert.deepEqual(catalog.roles[0].connections, []);
  assert.equal(catalog.defaultRoleId, catalog.roles[0].id);
  assert.deepEqual(await repository.assignment('project-a'), { roleId: catalog.roles[0].id });
});

test('bootstrap migrates every existing project to one empty default once', async () => {
  const secrets = new Set(['old-secret', 'operator-secret']);
  const projects = ['active-project', 'archived-project'];
  const repository = new MemoryRoleRepository(id => secrets.has(id), () => projects);
  await repository.saveRole(role('legacy-default', 'Legacy access', 'old-secret'), 'create');
  await repository.saveRole(role('other-role', 'Other'), 'create');
  await repository.setDefault('legacy-default');
  await repository.assign('active-project', 'other-role');

  await repository.bootstrap();

  const catalog = await repository.catalog();
  assert.equal(catalog.defaultRoleId, 'legacy-default');
  assert.deepEqual(catalog.roles.find(item => item.id === 'legacy-default')?.connections, []);
  assert.deepEqual(await repository.assignment('active-project'), { roleId: 'legacy-default' });
  assert.deepEqual(await repository.assignment('archived-project'), { roleId: 'legacy-default' });

  // New projects take the configured default. Later bootstraps preserve
  // operator edits and project assignments made after the one-time migration.
  await repository.assignDefault('new-project');
  await repository.saveRole(role('legacy-default', 'Legacy access', 'operator-secret'), 'update');
  await repository.assign('active-project', 'other-role');
  await repository.bootstrap();
  assert.deepEqual(await repository.assignment('active-project'), { roleId: 'other-role' });
  assert.deepEqual(await repository.assignment('new-project'), { roleId: 'legacy-default' });
  assert.deepEqual((await repository.catalog()).roles.find(item => item.id === 'legacy-default')?.connections, [
    { tool: 'mysql', alias: 'primary', secretId: 'operator-secret' },
  ]);
});
