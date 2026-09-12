import assert from 'node:assert/strict';
import test from 'node:test';
import type { SandboxCleanupRecord, SandboxDataArchive, SandboxState } from '../../protocol/sandbox-types.js';
import type { Project, Session } from '../../protocol/types.js';
import type { E2BRuntime } from '../execution/e2b-runtime.js';
import type { SandboxRestoreOptions } from '../execution/sandbox-upgrade.js';
import type { WebStateStore } from '../infra/storage/web-state.js';
import type { WorkspaceTarget } from '../sandboxes/types.js';
import { ProjectSandboxUpgrades, type ProjectSandboxUpgradeOptions, type SandboxDataOperation } from './sandbox-upgrades.js';
import { ProjectService } from './service.js';

const source: SandboxState = { id: 'sandbox-source', template: 'template-old', status: 'ready', workingDirectory: '/home/user/workspace' };
const candidate: SandboxState = { id: 'sandbox-candidate', template: 'template-latest', status: 'ready', workingDirectory: '/home/user/workspace' };
const archived = (key = 'archive-old.tar.gz', checkpoint: string | undefined = 'checkpoint-1'): SandboxDataArchive => ({
  key, sizeBytes: 123, sha256: 'a'.repeat(64), createdAt: new Date(1).toISOString(),
  format: 'codex-workspace-v1', workingDirectory: source.workingDirectory,
  threadIds: ['thread-1'], manifestSha256: 'b'.repeat(64), sourceSandboxId: source.id,
  sourceTemplate: source.template, ...(checkpoint ? { sessionCheckpoint: checkpoint } : {}),
});
const project = (overrides: Partial<Project> = {}): Project => ({
  id: 'project-1', name: 'Test project', requirementUrl: null, executionMode: 'e2b',
  workingDirectory: source.workingDirectory, sandbox: source, archivedAt: null,
  createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(), ...overrides,
});

class MemoryWebStateStore implements WebStateStore {
  projects: Project[];
  saved: Project[] = [];
  failSave?: (value: Project) => boolean;
  constructor(projects: Project[]) { this.projects = structuredClone(projects); }
  async init() {}
  async listProjects() { return structuredClone(this.projects); }
  async listSessions(): Promise<Session[]> { return []; }
  async saveProject(value: Project) {
    if (this.failSave?.(value)) throw new Error('project persistence failed');
    const saved = structuredClone(value);
    this.saved.push(saved);
    const index = this.projects.findIndex(item => item.id === value.id);
    if (index < 0) this.projects.push(saved); else this.projects[index] = saved;
  }
  async saveSession() {}
  async deleteProject(id: string) { this.projects = this.projects.filter(item => item.id !== id); }
  async deleteSession() {}
  async close() {}
}

type RuntimeActions = {
  archive?: (target: WorkspaceTarget, threadIds: string[]) => Promise<SandboxDataArchive>;
  restore?: (target: WorkspaceTarget, archive: SandboxDataArchive, options: SandboxRestoreOptions) => Promise<void>;
  deleteArchive?: (archive: SandboxDataArchive) => Promise<void>;
};
function runtime(actions: RuntimeActions = {}) {
  const calls = {
    archives: [] as Array<{ sandboxId: string | undefined; threadIds: string[] }>,
    restores: [] as Array<{ sandboxId: string | undefined; archiveKey: string }>,
    deletedArchives: [] as string[], detached: [] as string[], order: [] as string[],
  };
  const value = {
    async archiveSandbox(target: WorkspaceTarget, threadIds: string[]) {
      calls.archives.push({ sandboxId: target.sandbox?.id, threadIds });
      calls.order.push('archive');
      return actions.archive ? actions.archive(target, threadIds) : archived('archive-new.tar.gz', undefined);
    },
    async restoreSandbox(target: WorkspaceTarget, archive: SandboxDataArchive, options: SandboxRestoreOptions) {
      calls.restores.push({ sandboxId: target.sandbox?.id, archiveKey: archive.key });
      calls.order.push('restore');
      if (actions.restore) return actions.restore(target, archive, options);
      await options.onProgress('restoring', candidate);
      await options.onProgress('verifying', candidate);
      await options.beforeReplace?.(candidate);
      await options.onSandbox(candidate);
    },
    async detachSandbox(target: WorkspaceTarget) {
      calls.detached.push(target.sandbox!.id);
      calls.order.push('detach');
    },
    async deleteDataArchive(archive: SandboxDataArchive) {
      calls.deletedArchives.push(archive.key);
      calls.order.push(`delete:${archive.key}`);
      await actions.deleteArchive?.(archive);
    },
  } as unknown as E2BRuntime;
  return { value, calls };
}
async function fixture(initial = project(), actions: RuntimeActions = {}, optionOverrides: Partial<ProjectSandboxUpgradeOptions> = {}) {
  const state = new MemoryWebStateStore([initial]);
  const projects = new ProjectService(state);
  await projects.init();
  const fake = runtime(actions);
  const cleanupRecords: SandboxCleanupRecord[] = [];
  const reclaimed: string[] = [];
  const options: ProjectSandboxUpgradeOptions = {
    cleanup: {
      async schedule(sandboxId, reason, archive) {
        fake.calls.order.push(`schedule:${reason}:${sandboxId}`);
        const record: SandboxCleanupRecord = { sandboxId, reason, archive: archive && structuredClone(archive), attempts: 0,
          scheduledAt: new Date(2).toISOString(), deleteAfter: new Date(3).toISOString() };
        const index = cleanupRecords.findIndex(item => item.sandboxId === sandboxId);
        if (index < 0) cleanupRecords.push(record); else cleanupRecords[index] = record;
        return structuredClone(record);
      },
      async list() { return structuredClone(cleanupRecords); },
    },
    onReclaimed: async id => { reclaimed.push(id); },
    ...optionOverrides,
  };
  const upgrades = new ProjectSandboxUpgrades(projects, fake.value, options);
  const cutover = async (value: SandboxState) => { fake.calls.order.push('cutover'); await projects.updateSandbox(initial.id, value); };
  return { state, projects, upgrades, cutover, cleanupRecords, reclaimed, options, ...fake };
}
async function perform(f: Awaited<ReturnType<typeof fixture>>, kind: SandboxDataOperation,
  checkpoint = 'checkpoint-1', threadIds = ['thread-1']) {
  await f.upgrades.start('project-1', kind, threadIds, checkpoint, f.cutover);
  await f.upgrades.wait('project-1');
}

test('archive persists portable data without changing the current sandbox', async () => {
  const old = archived();
  const created = archived('archive-new.tar.gz', undefined);
  const f = await fixture(project({ sandboxDataArchive: old }), { archive: async () => created });
  await perform(f, 'archive', 'checkpoint-2', ['thread-1', 'thread-2']);
  const current = f.projects.get('project-1');
  assert.equal(current.sandbox?.id, source.id);
  assert.equal(current.sandboxDataArchive?.key, created.key);
  assert.equal(current.sandboxDataArchive?.sessionCheckpoint, 'checkpoint-2');
  assert.deepEqual(f.calls.archives, [{ sandboxId: source.id, threadIds: ['thread-1', 'thread-2'] }]);
  assert.deepEqual(f.calls.restores, []);
  assert.deepEqual(f.calls.deletedArchives, [old.key]);
  assert.equal(current.sandboxUpgrade, undefined);
});

test('restore uses only the stored archive and never invokes archive', async () => {
  const archive = archived();
  const f = await fixture(project({ sandboxDataArchive: archive }), {
    restore: async (target, restored, options) => {
      assert.equal(target.sandbox?.id, source.id);
      assert.equal(restored.key, archive.key);
      await options.onProgress('restoring', candidate);
      await options.onProgress('verifying', candidate);
      await options.beforeReplace?.(candidate);
      await options.onSandbox(candidate);
    },
  });
  await perform(f, 'restore');
  assert.deepEqual(f.calls.archives, []);
  assert.deepEqual(f.calls.restores, [{ sandboxId: source.id, archiveKey: archive.key }]);
  assert.equal(f.projects.get('project-1').sandbox?.id, candidate.id);
  assert.equal(f.projects.get('project-1').sandboxDataArchive?.key, archive.key);
  assert.equal(f.cleanupRecords[0].sandboxId, source.id);
});

test('upgrade saves its archive before restoring and cuts over without a retired association', async () => {
  const created = archived('archive-upgrade.tar.gz', undefined);
  const f = await fixture(project(), {
    archive: async () => created,
    restore: async (_target, archive, options) => {
      assert.equal(f.state.projects[0].sandboxDataArchive?.key, archive.key);
      f.calls.order.push('archive-is-durable');
      await options.onProgress('restoring', candidate);
      await options.onProgress('verifying', candidate);
      await options.beforeReplace?.(candidate);
      await options.onSandbox(candidate);
    },
  });
  await perform(f, 'upgrade');
  assert.deepEqual(f.calls.order, ['archive', 'restore', 'archive-is-durable', `schedule:upgrade:${source.id}`, 'cutover']);
  const current = f.projects.get('project-1');
  assert.equal(current.sandbox?.id, candidate.id);
  assert.equal(current.sandboxUpgrade, undefined);
  assert.equal(Object.hasOwn(current, 'retiredSandboxes'), false);
  assert.equal(Object.hasOwn(f.state.projects[0], 'retiredSandboxes'), false);
});

test('restore failure leaves the archive usable and the source current', async () => {
  const archive = archived();
  const f = await fixture(project({ sandboxDataArchive: archive }), {
    restore: async (_target, _archive, options) => {
      await options.onProgress('restoring', candidate);
      throw new Error('restore failed');
    },
  });
  await perform(f, 'restore');
  const current = f.projects.get('project-1');
  assert.equal(current.sandbox?.id, source.id);
  assert.equal(current.sandboxDataArchive?.key, archive.key);
  assert.equal(current.sandboxUpgrade?.phase, 'failed');
  assert.equal(current.sandboxUpgrade?.target?.id, candidate.id);
  assert.match(current.sandboxUpgrade?.error ?? '', /restore failed/);
  assert.deepEqual(f.calls.deletedArchives, []);
  assert.equal(f.cleanupRecords[0].sandboxId, candidate.id);
  assert.equal(f.cleanupRecords[0].reason, 'failed_restore');
});

test('restore rejects a changed conversation checkpoint before invoking the runtime', async () => {
  const f = await fixture(project({ sandboxDataArchive: archived() }));
  await assert.rejects(f.upgrades.start('project-1', 'restore', [], 'checkpoint-new', f.cutover), /归档后会话已变化/);
  assert.deepEqual(f.calls.archives, []);
  assert.deepEqual(f.calls.restores, []);
  assert.equal(f.projects.get('project-1').sandboxUpgrade, undefined);
  await f.upgrades.close();
});

test('busy project rejects every data operation before creating a journal', async () => {
  for (const kind of ['archive', 'restore', 'upgrade', 'reclaim'] as const) {
    const f = await fixture(kind === 'restore' ? project({ sandboxDataArchive: archived() }) : project());
    const release = f.projects.startSession('project-1', 'session-1');
    try {
      await assert.rejects(f.upgrades.start('project-1', kind, [], 'checkpoint-1', f.cutover), /项目正在使用/);
      assert.equal(f.projects.get('project-1').sandboxUpgrade, undefined);
      assert.deepEqual(f.calls.archives, []);
      assert.deepEqual(f.calls.restores, []);
    } finally { release(); await f.upgrades.close(); }
  }
});

test('initialization removes legacy retired metadata without deleting any sandbox', async () => {
  const legacy = project() as Project & { retiredSandboxes?: SandboxState[] };
  legacy.retiredSandboxes = [candidate];
  const state = new MemoryWebStateStore([legacy]);
  const projects = new ProjectService(state);
  await projects.init();
  assert.equal(Object.hasOwn(projects.get('project-1'), 'retiredSandboxes'), false);
  assert.equal(Object.hasOwn(state.projects[0], 'retiredSandboxes'), false);
  assert.equal(state.saved.length, 1);
});

test('initialization marks interrupted restore failed while leaving its target dangling', async () => {
  const interrupted = project({ sandboxDataArchive: archived(), sandboxUpgrade: {
    id: 'upgrade-1', kind: 'restore', source, target: candidate,
    phase: 'restoring', startedAt: new Date(1).toISOString(),
  } });
  const state = new MemoryWebStateStore([interrupted]);
  const projects = new ProjectService(state);
  await projects.init();
  const restored = projects.get('project-1');
  assert.equal(restored.sandbox?.id, source.id);
  assert.equal(restored.sandboxUpgrade?.phase, 'failed');
  assert.equal(restored.sandboxUpgrade?.target?.id, candidate.id);
  assert.match(restored.sandboxUpgrade?.error ?? '', /服务重启中断/);
  assert.equal(Object.hasOwn(restored, 'retiredSandboxes'), false);
});

test('archive metadata persistence failure deletes new object and preserves previous archive', async () => {
  const old = archived();
  const created = archived('archive-new.tar.gz', undefined);
  const f = await fixture(project({ sandboxDataArchive: old }), { archive: async () => created });
  f.state.failSave = value => value.sandboxDataArchive?.key === created.key;
  await perform(f, 'archive', 'checkpoint-2');
  const current = f.projects.get('project-1');
  assert.equal(current.sandbox?.id, source.id);
  assert.equal(current.sandboxDataArchive?.key, old.key);
  assert.equal(current.sandboxUpgrade?.phase, 'failed');
  assert.match(current.sandboxUpgrade?.error ?? '', /project persistence failed/);
  assert.deepEqual(f.calls.deletedArchives, [created.key]);
});

test('successful cutover persists only the candidate as project sandbox', async () => {
  const f = await fixture(project({ sandboxDataArchive: archived() }));
  await perform(f, 'restore');
  const durable = f.state.projects[0];
  assert.equal(durable.sandbox?.id, candidate.id);
  assert.equal(durable.sandboxUpgrade, undefined);
  assert.equal(Object.hasOwn(durable, 'retiredSandboxes'), false);
});

test('restore can rebuild a reclaimed project without a current sandbox', async () => {
  const saved = archived();
  const f = await fixture(project({ sandbox: undefined, sandboxDataArchive: saved, sandboxReclaimedAt: new Date(1).toISOString() }), {
    restore: async (target, archive, options) => {
      assert.equal(target.sandbox, undefined);
      assert.equal(archive.key, saved.key);
      await options.onProgress('restoring', candidate);
      await options.onProgress('verifying', candidate);
      await options.beforeReplace?.(candidate);
      await options.onSandbox(candidate);
    },
  });
  // Session metadata can change while reclaimed (for example, deleting an old
  // session) without advancing the archived native Codex histories.
  await perform(f, 'restore', 'checkpoint-after-session-delete');
  assert.equal(f.projects.get('project-1').sandbox?.id, candidate.id);
  assert.deepEqual(f.cleanupRecords, []);
});

test('restore from an archive belonging to another source does not authorize automatic source deletion', async () => {
  const external = { ...archived(), sourceSandboxId: 'sandbox-from-backup' };
  const f = await fixture(project({ sandboxDataArchive: external }));
  await perform(f, 'restore');
  assert.equal(f.projects.get('project-1').sandbox?.id, candidate.id);
  assert.deepEqual(f.cleanupRecords, []);
});

test('reclaim persists the archive and cleanup intent before detaching the current sandbox', async () => {
  const created = archived('archive-reclaim.tar.gz', undefined);
  const f = await fixture(project(), { archive: async () => created });
  await perform(f, 'reclaim', 'checkpoint-reclaim');
  const current = f.projects.get('project-1');
  assert.equal(current.sandbox, undefined);
  assert.equal(current.sandboxDataArchive?.key, created.key);
  assert.equal(current.sandboxDataArchive?.sessionCheckpoint, 'checkpoint-reclaim');
  assert.equal(current.sandboxReclaimedAt !== undefined, true);
  assert.deepEqual(f.calls.order, ['archive', `schedule:idle:${source.id}`, 'detach']);
  assert.deepEqual(f.calls.detached, [source.id]);
  assert.deepEqual(f.reclaimed, ['project-1']);
});

test('a cleanup-referenced archive is not deleted when a newer project archive replaces it', async () => {
  const old = archived();
  const created = archived('archive-new.tar.gz', undefined);
  const f = await fixture(project({ sandboxDataArchive: old }), { archive: async () => created });
  await f.options?.cleanup?.schedule(source.id, 'upgrade', old);
  await perform(f, 'archive', 'checkpoint-2');
  assert.equal(f.projects.get('project-1').sandboxDataArchive?.key, created.key);
  assert.deepEqual(f.calls.deletedArchives, []);
});

test('wait follows the initial journal write into the full background operation', async () => {
  const f = await fixture();
  const originalSave = f.state.saveProject.bind(f.state);
  let releaseJournal!: () => void;
  let journalStarted!: () => void;
  const journalGate = new Promise<void>(resolve => { releaseJournal = resolve; });
  const savingJournal = new Promise<void>(resolve => { journalStarted = resolve; });
  let firstJournal = true;
  f.state.saveProject = async value => {
    if (firstJournal && value.sandboxUpgrade?.phase === 'archiving') {
      firstJournal = false;
      journalStarted();
      await journalGate;
    }
    await originalSave(value);
  };
  let releaseArchive!: () => void;
  let archiveStarted!: () => void;
  const archiveGate = new Promise<void>(resolve => { releaseArchive = resolve; });
  const archiving = new Promise<void>(resolve => { archiveStarted = resolve; });
  f.value.archiveSandbox = async () => {
    archiveStarted();
    await archiveGate;
    return archived('waited-archive.tar.gz', undefined);
  };
  const starting = f.upgrades.start('project-1', 'archive', [], 'checkpoint-1', f.cutover);
  await savingJournal;
  let waited = false;
  const waiting = f.upgrades.wait('project-1').then(() => { waited = true; });
  releaseJournal();
  await starting;
  await archiving;
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(waited, false);
  releaseArchive();
  await waiting;
  assert.equal(f.projects.get('project-1').sandboxDataArchive?.key, 'waited-archive.tar.gz');
});
