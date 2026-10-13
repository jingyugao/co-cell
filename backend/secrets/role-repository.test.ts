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
  await assert.rejects(repository.saveRole(role('role-a', 'Ops', 'secret-a'), 'create'), rejectsWithStatus(400));

  secrets.add('secret-a');
  await repository.saveRole(role('role-a', 'Ops', 'secret-a'), 'create');
  await assert.rejects(repository.saveRole(role('role-b', 'ops'), 'create'), rejectsWithStatus(409));
  await assert.rejects(repository.saveRole(role('role-c', 'Other'), 'update'), rejectsWithStatus(404));
  await assert.rejects(repository.saveRole(role('role-a', 'Renamed'), 'create'), rejectsWithStatus(409));
  await repository.saveRole(role('role-a', 'Renamed'), 'update');
  assert.equal((await repository.catalog()).roles[0].name, 'Renamed');
});

test('default assignment snapshots once, preserves explicit null, and blocks deletion while referenced', async () => {
  const repository = new MemoryRoleRepository();
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
