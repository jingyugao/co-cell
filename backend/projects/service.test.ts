import assert from 'node:assert/strict';
import test from 'node:test';
import type { Project, Session, Settings } from '../../protocol/types.js';
import { projectTypeLabel, weeklyProjectDisplayName } from '../../util/project-types.js';
import type { WebStateStore } from '../infra/storage/web-state.js';
import { mergeRecord } from '../infra/storage/record-merge.js';
import { ProjectService } from './service.js';

const project = (): Project => ({
  id: 'project-1', name: 'Archive history', requirementUrl: null, executionMode: 'sandbox',
  workingDirectory: '/home/agent/workspace',
  sandbox: { id: 'sandbox-1', template: 'base', status: 'ready', workingDirectory: '/home/agent/workspace' },
  archivedAt: null, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
});

class MemoryState implements WebStateStore {
  projectReads = 0;
  projectLists = 0;
  projectWrites = 0;
  constructor(public projects: Project[]) {}
  async init() {}
  async listProjects() { this.projectLists++; return structuredClone(this.projects); }
  async listSessions(): Promise<Session[]> { return []; }
  async listProjectSessions(_projectId: string): Promise<Session[]> { return []; }
  async getProject(id: string) { this.projectReads++; const value = this.projects.find(item => item.id === id); return value ? structuredClone(value) : undefined; }
  async getSession(_id: string) { return undefined; }
  async mutateProject(id: string, mutate: (current: Project) => void) {
    const index = this.projects.findIndex(item => item.id === id);
    if (index < 0) throw new Error('missing project');
    const next = structuredClone(this.projects[index]);
    const before = JSON.stringify(next);
    mutate(next);
    if (JSON.stringify(next) !== before) {
      this.projects[index] = structuredClone(next);
      this.projectWrites++;
    }
    return structuredClone(next);
  }
  async saveProject(value: Project, previous?: Project) {
    this.projectWrites++;
    const index = this.projects.findIndex(item => item.id === value.id);
    if (index < 0) this.projects.push(structuredClone(value));
    else this.projects[index] = structuredClone(previous ? mergeRecord(previous, value, this.projects[index]) : value);
  }
  async saveSession() {}
  async deleteProject(id: string) { this.projects = this.projects.filter(item => item.id !== id); }
  async deleteSession() {}
  async close() {}
}

test('restart retains a completed pause and marks an interrupted background backup unknown', async () => {
  const value = project();
  value.sandboxOperation = { id: 'pause-1', kind: 'checkpoint', status: 'succeeded', phase: '完成', updatedAt: value.updatedAt };
  value.sandboxBackup = { id: 'pause-1', sandboxId: 'sandbox-1', status: 'running', phase: '校验备份', updatedAt: value.updatedAt };
  const state = new MemoryState([value]);
  const service = new ProjectService(state);
  await service.init();
  assert.equal(service.get(value.id).sandboxOperation?.status, 'succeeded');
  assert.equal(service.get(value.id).sandboxBackup?.status, 'unknown');
  assert.equal((await state.getProject(value.id))?.sandboxBackup?.status, 'unknown');
  await service.close();
});

test('restart marks an interrupted Sandbox operation unknown without changing its identity', async () => {
  const value = project();
  value.sandboxOperation = { id: 'resume-unknown', kind: 'resume', status: 'running', phase: '恢复中', updatedAt: value.updatedAt };
  const state = new MemoryState([value]);
  const service = new ProjectService(state);
  await service.init();

  const operation = service.get(value.id).sandboxOperation;
  assert.equal(operation?.id, 'resume-unknown');
  assert.equal(operation?.kind, 'resume');
  assert.equal(operation?.status, 'unknown');
  assert.match(operation?.error ?? '', /结果未确认/);
  assert.equal((await state.getProject(value.id))?.sandboxOperation?.status, 'unknown');
  await service.close();
});

test('scoped shared refresh point-reads one project and skips protected projects', async () => {
  const second = { ...project(), id: 'project-2', name: 'Other project' };
  const state = new MemoryState([project(), second]);
  const service = new ProjectService(state, undefined, undefined, true);
  await service.init();
  state.projects[0].name = 'remote target';
  state.projects[1].name = 'remote unrelated';

  await service.refreshOne('project-1');
  assert.equal(service.get('project-1').name, 'remote target');
  assert.equal(service.get('project-2').name, 'Other project');
  assert.equal(state.projectReads, 1);
  assert.equal(state.projectLists, 1, 'only initialization lists the full project table');

  await service.refreshOne('project-2');
  assert.equal(service.get('project-2').name, 'remote unrelated', 'maintenance does not block viewing the current record');
  assert.equal(state.projectReads, 2);
});

test('scoped refresh re-reads after a local save advances the baseline during the point read', async () => {
  class DelayedReadState extends MemoryState {
    holdRead = false;
    readStarted!: () => void;
    releaseRead!: () => void;
    async getProject(id: string) {
      this.projectReads++;
      const result = this.projects.find(item => item.id === id);
      if (this.holdRead) {
        this.holdRead = false;
        this.readStarted();
        await new Promise<void>(resolve => { this.releaseRead = resolve; });
      }
      return result ? structuredClone(result) : undefined;
    }
  }
  const state = new DelayedReadState([project()]);
  const service = new ProjectService(state, undefined, undefined, true);
  await service.init();
  let readStarted!: () => void;
  const started = new Promise<void>(resolve => { readStarted = resolve; });
  state.readStarted = readStarted;
  state.holdRead = true;
  const refresh = service.refreshOne('project-1');
  await started;
  await service.update('project-1', { name: 'local newer save' });
  state.releaseRead();
  await refresh;
  assert.equal(service.get('project-1').name, 'local newer save');
  assert.equal(state.projectReads, 2, 'the stale point-read is followed by a fresh read');
});

test('resume metadata status-only callbacks are no-ops, while pausedAt and activity changes persist', async () => {
  const value = project();
  value.sandbox = { ...value.sandbox!, pausedAt: '2026-09-02T00:00:00.000Z' };
  const state = new MemoryState([value]);
  const service = new ProjectService(state, undefined, undefined, true);
  await service.init();
  const updatedAt = service.get('project-1').updatedAt;
  const writes = state.projectWrites;

  await service.updateSandbox('project-1', { ...service.get('project-1').sandbox!, status: 'paused' });
  await service.updateSandbox('project-1', { ...service.get('project-1').sandbox!, status: 'ready' });
  assert.equal(state.projectWrites, writes, 'transient status changes do not write durable metadata');
  assert.equal(service.get('project-1').updatedAt, updatedAt);

  await service.updateSandbox('project-1', { ...service.get('project-1').sandbox!, status: 'ready', pausedAt: undefined,
    lastActiveAt: '2026-09-03T00:00:00.000Z' });
  assert.equal(state.projectWrites, writes + 1);
  assert.equal(service.get('project-1').sandbox?.pausedAt, undefined);
  assert.equal(service.get('project-1').sandbox?.lastActiveAt, '2026-09-03T00:00:00.000Z');
});

test('release then create preserves volumes and persists the actual stable revision across restart', async () => {
  const value = project();
  value.imageSelection = { imageId: 'python', imageName: 'Python', category: '开发', templateId: 'tpl-python',
    revisionId: 'rev-old', versionId: 'rev-old', version: '1.0-r1', image: 'python@sha256:old' };
  const mounts = [{ volumeId: 'retained-home', mountPath: '/home/agent' }];
  value.sandbox = { ...value.sandbox!, mounts, ownerKey: 'project:actual-owner' };
  const state = new MemoryState([value]);
  const service = new ProjectService(state);
  await service.init();
  await service.releaseSandbox(value.id, value.sandbox);
  assert.equal(service.get(value.id).imageSelection?.revisionId, 'rev-old');

  const image = { templateId: 'tpl-python', revisionId: 'rev-stable', version: '2.0-r1',
    reference: 'python@sha256:stable', id: 'sha256:stable', repoDigests: [] };
  await service.updateSandbox(value.id, { ...value.sandbox, id: 'new-box', image }, false, undefined, null);
  assert.deepEqual(service.get(value.id).imageSelection, { ...value.imageSelection,
    revisionId: 'rev-stable', versionId: 'rev-stable', version: '2.0-r1', image: image.reference });
  assert.deepEqual(service.get(value.id).sandboxMounts, mounts);
  assert.equal(service.get(value.id).sandboxOwnerKey, 'project:actual-owner');

  const restarted = new ProjectService(state);
  await restarted.init();
  assert.equal(restarted.get(value.id).imageSelection?.revisionId, 'rev-stable');
  assert.deepEqual(restarted.get(value.id).sandbox?.image, image);
  await service.close(); await restarted.close();
});

test('project can be viewed and edited while a Sandbox operation is running', async () => {
  const value = project();
  value.sandboxOperation = { id: 'resume-1', kind: 'resume', phase: '恢复中', status: 'running', updatedAt: value.updatedAt };
  const state = new MemoryState([value]);
  const service = new ProjectService(state, undefined, undefined, true);
  await service.init();

  assert.equal(service.get(value.id).sandboxOperation?.status, 'running');
  await service.update('project-1', { name: 'Renamed during resume', backupRetentionCount: 7 });
  assert.equal(service.get('project-1').name, 'Renamed during resume');
  assert.equal(service.get('project-1').backupRetentionCount, 7);
  assert.equal(service.get('project-1').sandboxOperation?.id, 'resume-1');
  await service.update('project-1', { status: 'completed' });
  assert.equal(service.get('project-1').status, 'completed');
  assert.equal(service.get('project-1').sandboxOperation?.id, 'resume-1');
});

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

  await service.updateSandbox('project-1', { id: 'sandbox-2', template: 'image', status: 'ready', workingDirectory: '/home/agent/workspace' }, true);
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

test('backup retention accepts and persists counts from 2 to 100', async () => {
  const state = new MemoryState([project()]);
  const service = new ProjectService(state);
  await service.init();

  for (const count of [1, 101, 2.5]) {
    await assert.rejects(service.update('project-1', { backupRetentionCount: count }), /备份保留数量/);
  }
  assert.equal(service.get('project-1').backupRetentionCount, undefined);

  await service.update('project-1', { backupRetentionCount: 2 });
  assert.equal(state.projects[0].backupRetentionCount, 2);
  await service.update('project-1', { backupRetentionCount: 100 });
  assert.equal(service.get('project-1').backupRetentionCount, 100);
});

test('weekly projects use a normal existence check and labels follow China week boundaries', async () => {
  let now = new Date('2026-09-13T10:00:00.000Z'); // Sunday evening in China
  const service = new ProjectService(new MemoryState([]), async () => ({ name: 'unused', status: null }), () => now);
  await service.init();
  const settings = { executionMode: 'sandbox', workingDirectory: '/home/agent/workspace' } as Settings;

  const weekly = await service.create({ name: '本周重点', type: 3 }, settings);
  assert.equal(weekly.weekOf, '2026-09-07');
  await assert.rejects(service.create({ name: '重复本周项目', type: 3 }, settings), /每周只能创建一个/);

  now = new Date('2026-09-14T10:00:00.000Z');
  assert.equal(projectTypeLabel(weekly.type, weekly.weekOf, now), '上周项目');
  assert.equal(weeklyProjectDisplayName(weekly.weekOf, now), '【上周项目】');
  assert.equal(weeklyProjectDisplayName(weekly.weekOf, new Date('2026-09-28T10:00:00.000Z')), '【9月第2周项目】');
  const next = await service.create({ name: '下周重点', type: 3 }, settings);
  assert.equal(next.weekOf, '2026-09-14');
  assert.equal(projectTypeLabel(next.type, next.weekOf, now), '本周项目');
});

test('concurrent weekly project creation has no reservation or uniqueness guarantee', async () => {
  const service = new ProjectService(new MemoryState([]), async () => ({ name: 'unused', status: null }), () => new Date('2026-09-13T10:00:00.000Z'));
  await service.init();
  const settings = { executionMode: 'sandbox', workingDirectory: '/home/agent/workspace' } as Settings;
  const created = await Promise.all([
    service.create({ name: '并发本周项目 A', type: 3 }, settings),
    service.create({ name: '并发本周项目 B', type: 3 }, settings),
  ]);
  assert.equal(created.length, 2);
  assert.equal(created[0].weekOf, created[1].weekOf);
  assert.equal(service.list().filter(value => value.type === 3).length, 2);
});

test('Feishu projects require a requirement link', async () => {
  const service = new ProjectService(new MemoryState([]));
  await service.init();
  await assert.rejects(service.create({ name: 'missing requirement', type: 2 }, { workingDirectory: '/tmp' } as Settings), /必须绑定飞书需求/);
});

test('new project role initialization completes before creation returns and rolls back failed initialization', async () => {
  const state = new MemoryState([]);
  const initialized: string[] = [];
  const projects = new ProjectService(state, undefined, undefined, false, async id => {
    assert.ok(await state.getProject(id));
    initialized.push(id);
  });
  const created = await projects.create({ name: 'Role project' }, { workingDirectory: '/tmp', executionMode: 'local' } as Settings);
  assert.deepEqual(initialized, [created.id]);
  const failed = new ProjectService(state, undefined, undefined, false, async () => { throw new Error('Role store unavailable'); });
  await assert.rejects(failed.create({ name: 'Failed' }, { workingDirectory: '/tmp', executionMode: 'local' } as Settings), /Role store unavailable/);
  assert.deepEqual(failed.list(), []);
  assert.equal((await state.listProjects()).length, 1);
});


test('late Sandbox callbacks cannot replace a newer binding or reattach an archived source', async () => {
  const service = new ProjectService(new MemoryState([project()]));
  await service.init();
  const replacement = { ...service.get('project-1').sandbox!, id: 'sandbox-new' };
  assert.equal(await service.updateSandbox('project-1', replacement, false, undefined, 'sandbox-1'), true);
  assert.equal(await service.updateSandbox('project-1', { ...replacement, id: 'sandbox-1' }), false);
  assert.equal(await service.updateSandbox('project-1', { ...replacement, id: 'stale-candidate' }, false, undefined, 'sandbox-1'), false);
  assert.equal(service.get('project-1').sandbox?.id, 'sandbox-new');
  await service.archiveAndDetachSandbox('project-1', 'sandbox-new');
  assert.equal(await service.updateSandbox('project-1', replacement), false);
  assert.equal(service.get('project-1').sandbox, undefined);
  await service.close();
});

test('archive started without a Sandbox cannot detach a binding created in the meantime', async () => {
  const initial = project(); delete initial.sandbox;
  const service = new ProjectService(new MemoryState([initial]));
  await service.init();
  const current = { id: 'new-box', template: 'base', status: 'ready' as const, workingDirectory: initial.workingDirectory };
  assert.equal(await service.updateSandbox(initial.id, current, false, undefined, null), true);
  await assert.rejects(service.archiveAndDetachSandbox(initial.id, null), /Sandbox 已变化/);
  assert.equal(service.get(initial.id).sandbox?.id, current.id);
  assert.equal(service.get(initial.id).status, 'active');
  await service.close();
});

test('late callbacks cannot reattach a released Box and explicit creation retains the promoted volume owner', async () => {
  const original = project();
  const service = new ProjectService(new MemoryState([original]));
  await service.init();
  const released = { ...original.sandbox!, homeVolumeId: 'retained-volume', ownerKey: 'project:project-1:restore:older' };
  try {
    await service.releaseSandbox(original.id, released);
    assert.equal(await service.updateSandbox(original.id, original.sandbox!), false);
    assert.equal(service.get(original.id).sandbox, undefined);
    assert.equal(service.get(original.id).sandboxOwnerKey, released.ownerKey);
    assert.deepEqual(service.get(original.id).sandboxMounts, [{ volumeId: 'retained-volume', mountPath: '/home/agent' }]);
    const replacement = { ...released, id: 'new-box' };
    assert.equal(await service.updateSandbox(original.id, replacement, false, undefined, null), true);
    assert.equal(service.get(original.id).sandbox?.id, replacement.id);
  } finally { await service.close(); }
});
