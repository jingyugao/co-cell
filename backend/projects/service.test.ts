import assert from 'node:assert/strict';
import test from 'node:test';
import type { Project, Session } from '../../protocol/types.js';
import type { WebStateStore } from '../infra/storage/web-state.js';
import { ProjectService } from './service.js';

const project = (): Project => ({
  id: 'project-1', name: 'Archive history', requirementUrl: null, executionMode: 'sandbox',
  workingDirectory: '/home/user/workspace',
  sandbox: { id: 'sandbox-1', template: 'base', status: 'ready', workingDirectory: '/home/user/workspace' },
  archivedAt: null, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
});

class MemoryState implements WebStateStore {
  constructor(public projects: Project[]) {}
  async init() {}
  async listProjects() { return structuredClone(this.projects); }
  async listSessions(): Promise<Session[]> { return []; }
  async saveProject(value: Project) {
    const index = this.projects.findIndex(item => item.id === value.id);
    if (index < 0) this.projects.push(structuredClone(value)); else this.projects[index] = structuredClone(value);
  }
  async saveSession() {}
  async recordProjectArchive() {}
  async latestProjectArchive(id: string) { return this.projects.find(item => item.id === id)?.sandboxDataArchive; }
  async deleteProject(id: string) { this.projects = this.projects.filter(item => item.id !== id); }
  async deleteSession() {}
  async close() {}
}

test('archive detaches the Sandbox and rebuilding restores the project with a new binding', async () => {
  const state = new MemoryState([project()]);
  const service = new ProjectService(state);
  await service.init();

  await service.archiveAndDetachSandbox('project-1', 'sandbox-1');
  const archived = service.get('project-1');
  assert.ok(archived.archivedAt);
  assert.equal(archived.sandbox, undefined);
  assert.equal(archived.lifecycleHistory?.length, 1);
  assert.equal(archived.lifecycleHistory?.[0].action, 'archived');
  assert.equal(archived.lifecycleHistory?.[0].sandboxId, 'sandbox-1');

  await service.updateSandbox('project-1', { id: 'sandbox-2', template: 'image', status: 'ready', workingDirectory: '/home/user/workspace' }, true);
  const restored = service.get('project-1');
  assert.equal(restored.archivedAt, null);
  assert.equal(restored.sandbox?.id, 'sandbox-2');
  assert.deepEqual(restored.lifecycleHistory?.map(record => record.action), ['archived', 'restored']);
  assert.equal(state.projects[0].lifecycleHistory?.length, 2);
});

test('an archived Sandbox project cannot change status directly before rebuild', async () => {
  const value = project();
  value.archivedAt = '2026-09-01T00:00:00.000Z';
  delete value.sandbox;
  value.sandboxReclaimedAt = '2026-09-02T00:00:00.000Z';
  const service = new ProjectService(new MemoryState([value]));
  await service.init();

  value.status = 'archived';
  await assert.rejects(service.update(value.id, { status: 'active' }), /归档项目请使用恢复操作/);
  assert.equal(service.get(value.id).archivedAt, value.archivedAt);
  assert.equal(service.get(value.id).lifecycleHistory, undefined);
});
