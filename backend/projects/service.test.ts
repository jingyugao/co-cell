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

  const release = service.beginMaintenance('project-2');
  await service.refreshOne('project-2');
  release();
  assert.equal(service.get('project-2').name, 'Other project', 'refresh does not replace a locally maintained project');
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

test('resume permits descriptive metadata edits but keeps lifecycle status changes guarded', async () => {
  const value = project();
  value.sandboxOperation = { id: 'resume-1', kind: 'resume', phase: '恢复中', status: 'running', updatedAt: value.updatedAt };
  const state = new MemoryState([value]);
  const service = new ProjectService(state, undefined, undefined, true);
  await service.init();

  await service.update('project-1', { name: 'Renamed during resume', backupRetentionCount: 7 });
  assert.equal(service.get('project-1').name, 'Renamed during resume');
  assert.equal(service.get('project-1').backupRetentionCount, 7);
  assert.equal(service.get('project-1').sandboxOperation?.id, 'resume-1');
  await assert.rejects(service.update('project-1', { status: 'completed' }), /维护/);
  assert.equal(service.get('project-1').status, 'active');
});

test('resume claims serialize owners and recovery transfers only the same operation', async () => {
  const state = new MemoryState([project()]);
  const service = new ProjectService(state, undefined, undefined, true);
  await service.init();

  const first = await service.claimResume('project-1', 'api-a');
  assert.equal(first.started, true);
  const duplicate = await service.claimResume('project-1', 'api-a');
  assert.equal(duplicate.started, false);
  const duplicateFromOtherApi = await service.claimResume('project-1', 'api-b');
  assert.equal(duplicateFromOtherApi.started, false, 'a duplicate cannot steal a live owner’s claim');
  assert.equal(duplicateFromOtherApi.project.sandboxOperation?.resume?.ownerId, 'api-a');

  const opId = first.project.sandboxOperation!.id!;
  const recovered = await service.claimResume('project-1', 'api-b', { operationId: opId, previousOwnerId: 'api-a' });
  assert.equal(recovered.started, true);
  assert.equal(recovered.project.sandboxOperation?.id, opId);
  assert.deepEqual(recovered.project.sandboxOperation?.resume, { sandboxId: 'sandbox-1', ownerId: 'api-b' });
  await assert.rejects(service.claimResume('project-1', 'api-c', { operationId: opId, previousOwnerId: 'api-a' }), /恢复操作已变化/);
});

test('resume completion is conditional and commits the final sandbox plus operation once', async () => {
  const state = new MemoryState([project()]);
  const service = new ProjectService(state, undefined, undefined, true);
  await service.init();
  const claim = await service.claimResume('project-1', 'api-a');
  const opId = claim.project.sandboxOperation!.id!;
  const writes = state.projectWrites;

  assert.equal(await service.finishResume('project-1', { operationId: opId, ownerId: 'stale-api', sandboxId: 'sandbox-1' }, {}), false);
  assert.equal(state.projectWrites, writes, 'stale completion does not write the project');

  // Simulate a concurrent unrelated API edit after claim; finish must merge
  // onto the latest durable row rather than saving the claim-time snapshot.
  state.projects[0].name = 'renamed elsewhere';
  const finished = await service.finishResume('project-1', { operationId: opId, ownerId: 'api-a', sandboxId: 'sandbox-1' }, {
    sandbox: { ...claim.project.sandbox!, status: 'ready', pausedAt: undefined, lastActiveAt: '2026-09-03T00:00:00.000Z' },
  });
  assert.equal(finished, true);
  assert.equal(state.projectWrites, writes + 1);
  assert.equal(service.get('project-1').name, 'renamed elsewhere');
  assert.equal(service.get('project-1').sandbox?.pausedAt, undefined);
  assert.ok(service.get('project-1').sandbox?.lastActiveAt, 'successful resume records fresh activity');
  assert.equal(service.get('project-1').sandboxOperation?.status, 'succeeded');
});

test('a queued same-instance rename cannot regress a committed resume or disappear from cache', async () => {
  class DelayedTerminalState extends MemoryState {
    commitReached!: () => void;
    allowCommit!: () => void;
    holdTerminal = false;
    async mutateProject(id: string, mutate: (current: Project) => void) {
      const current = this.projects.find(item => item.id === id);
      if (this.holdTerminal && current?.sandboxOperation?.status === 'running') {
        const projected = structuredClone(current);
        mutate(projected);
        if (projected.sandboxOperation?.status === 'succeeded') {
          this.holdTerminal = false;
          this.commitReached();
          await new Promise<void>(resolve => { this.allowCommit = resolve; });
        }
      }
      return super.mutateProject(id, mutate);
    }
  }
  const state = new DelayedTerminalState([project()]);
  const service = new ProjectService(state, undefined, undefined, true);
  await service.init();
  const claim = await service.claimResume('project-1', 'api-a');
  const operationId = claim.project.sandboxOperation!.id!;
  let commitReached!: () => void;
  const reached = new Promise<void>(resolve => { commitReached = resolve; });
  state.commitReached = commitReached;
  state.holdTerminal = true;

  const finish = service.finishResume('project-1', { operationId, ownerId: 'api-a', sandboxId: 'sandbox-1' }, {});
  await reached;
  const rename = service.update('project-1', { name: 'renamed while resume commits' });
  await Promise.resolve();
  state.allowCommit();
  assert.equal(await finish, true);
  await rename;

  const cached = service.get('project-1');
  const durable = state.projects[0];
  assert.equal(cached.sandboxOperation?.status, 'succeeded');
  assert.equal(durable.sandboxOperation?.status, 'succeeded', 'the queued field-level save must preserve the terminal operation');
  assert.equal(cached.name, 'renamed while resume commits');
  assert.equal(durable.name, 'renamed while resume commits');
});

test('resume provider callbacks are captured without intermediate writes and reject another Box', async () => {
  const state = new MemoryState([project()]);
  const service = new ProjectService(state, undefined, undefined, true);
  await service.init();
  const writes = state.projectWrites;
  const final = await service.withResumeSandbox('project-1', 'sandbox-1', async () => {
    await service.updateSandbox('project-1', { ...service.get('project-1').sandbox!, status: 'ready', pausedAt: undefined });
    await assert.rejects(service.updateSandbox('project-1', { ...service.get('project-1').sandbox!, id: 'different-box' }), /身份已变化/);
  });
  assert.equal(final?.id, 'sandbox-1');
  assert.equal(final?.status, 'ready');
  assert.equal(state.projectWrites, writes);
  assert.equal(service.get('project-1').sandbox?.pausedAt, undefined, 'captured callbacks do not mutate the shared cache');
});

test('shared refresh waits for in-flight writes, honors skipped scopes, and refreshes baselines safely', async () => {
  class DelayedState extends MemoryState {
    holdNext = false;
    lastPrevious?: Project;
    entered!: () => void;
    releaseSave!: () => void;
    async saveProject(value: Project, previous?: Project) {
      this.lastPrevious = previous;
      if (this.holdNext) {
        this.holdNext = false;
        const gate = new Promise<void>(resolve => { this.releaseSave = resolve; });
        this.entered();
        await gate;
      }
      await super.saveProject(value);
    }
  }
  const state = new DelayedState([project()]);
  const service = new ProjectService(state, undefined, undefined, true);
  await service.init();

  state.projects[0].name = 'remote skipped update';
  await service.refresh(new Set(['project-1']));
  assert.equal(service.get('project-1').name, 'Archive history');
  assert.equal(state.projectReads, 0);

  let signalEntered!: () => void;
  const entered = new Promise<void>(resolve => { signalEntered = resolve; });
  state.entered = signalEntered;
  state.holdNext = true;
  const update = service.update('project-1', { name: 'local write' });
  await entered;
  let refreshed = false;
  const refresh = service.refresh().then(() => { refreshed = true; });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(refreshed, false);
  state.releaseSave();
  await Promise.all([update, refresh]);
  assert.equal(service.get('project-1').name, 'local write');
  assert.equal(state.projectReads, 1, 'only the stale list entry is reread after the save advances its baseline');

  state.projects[0].name = 'new remote baseline';
  await service.refresh();
  assert.equal(service.get('project-1').name, 'new remote baseline');
  assert.equal(state.projectReads, 1, 'ordinary bulk refreshes do not issue per-project point reads');
  await service.update('project-1', { name: 'final local write' });
  assert.equal(state.lastPrevious?.name, 'new remote baseline');
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

test('weekly projects are unique per China week and become last-week projects in the following week', async () => {
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

test('Feishu projects require a requirement link', async () => {
  const service = new ProjectService(new MemoryState([]));
  await service.init();
  await assert.rejects(service.create({ name: 'missing requirement', type: 2 }, { workingDirectory: '/tmp' } as Settings), /必须绑定飞书需求/);
});
