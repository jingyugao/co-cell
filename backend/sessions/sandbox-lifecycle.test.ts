import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { SandboxDataArchive, SandboxState } from '../../protocol/sandbox-types.js';
import type { Project, Session, Settings, Turn } from '../../protocol/types.js';
import type { E2BRuntime } from '../execution/e2b-runtime.js';
import type { SandboxRestoreOptions } from '../execution/sandbox-upgrade.js';
import type { WebStateStore } from '../infra/storage/web-state.js';
import type { WorkspaceTarget } from '../sandboxes/types.js';
import { SessionManager, type CodexClient } from './manager.js';

const DAY = 24 * 60 * 60 * 1000;
const WORKSPACE = '/home/user/workspace';
const NOW = Date.parse('2026-01-20T00:00:00.000Z');
const defaults: Settings = {
  executionMode: 'e2b', workingDirectory: WORKSPACE, model: 'test', modelReasoningEffort: 'low',
  sandboxMode: 'danger-full-access', webSearchMode: 'disabled', networkAccessEnabled: true,
};
const source: SandboxState = {
  id: 'sandbox-old', template: 'template-old', status: 'ready', workingDirectory: WORKSPACE,
  lastActiveAt: '2026-01-01T00:00:00.000Z',
};
const candidate: SandboxState = {
  id: 'sandbox-new', template: 'template-new', status: 'ready', workingDirectory: WORKSPACE,
  lastActiveAt: '2026-01-20T00:00:00.000Z',
};

function session(overrides: Partial<Session> = {}): Session {
  const turn: Turn = {
    id: 'turn-1', prompt: '', images: [], items: [], status: 'completed',
    startedAt: '2026-01-01T00:00:00.000Z', completedAt: '2026-01-01T00:01:00.000Z',
  };
  return {
    id: 'session-1', projectId: 'project-1', threadId: 'thread-original', title: 'Existing conversation',
    settings: defaults, status: 'completed', startedAt: '2026-01-01T00:00:00.000Z', archivedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:01:00.000Z', turns: [turn],
    sandbox: source, ...overrides,
  };
}

function checkpoint(sessions: Session[]): string {
  const value = sessions.filter(item => item.threadId || item.turns.length).map(item => ({
    id: item.id, threadId: item.threadId,
    turns: item.turns.map(turn => ({ id: turn.id, status: turn.status })),
  })).sort((a, b) => a.id.localeCompare(b.id));
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function archive(sessions: Session[], sandbox = source): SandboxDataArchive {
  return {
    key: `${sandbox.id}.tar.gz`, sizeBytes: 10, sha256: 'a'.repeat(64), createdAt: new Date(NOW).toISOString(),
    format: 'codex-workspace-v1', workingDirectory: WORKSPACE,
    threadIds: sessions.flatMap(item => item.threadId ? [item.threadId] : []), manifestSha256: 'b'.repeat(64),
    sourceSandboxId: sandbox.id, sourceTemplate: sandbox.template, sessionCheckpoint: checkpoint(sessions),
  };
}

function project(sessions: Session[], overrides: Partial<Project> = {}): Project {
  return {
    id: 'project-1', name: 'Lifecycle project', requirementUrl: null, executionMode: 'e2b', workingDirectory: WORKSPACE,
    sandbox: source, archivedAt: null, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:01:00.000Z',
    ...overrides,
  };
}

class MemoryState implements WebStateStore {
  constructor(public projects: Project[], public sessions: Session[]) {
    this.projects = structuredClone(projects);
    this.sessions = structuredClone(sessions);
  }
  async init() {}
  async listProjects() { return structuredClone(this.projects); }
  async listSessions() { return structuredClone(this.sessions); }
  async saveProject(value: Project) {
    const index = this.projects.findIndex(item => item.id === value.id);
    if (index < 0) this.projects.push(structuredClone(value)); else this.projects[index] = structuredClone(value);
  }
  async saveSession(value: Session) {
    const index = this.sessions.findIndex(item => item.id === value.id);
    if (index < 0) this.sessions.push(structuredClone(value)); else this.sessions[index] = structuredClone(value);
  }
  async deleteProject(id: string) { this.projects = this.projects.filter(item => item.id !== id); }
  async deleteSession(id: string) { this.sessions = this.sessions.filter(item => item.id !== id); }
  async close() {}
}

type RuntimeOptions = { failArchive?: boolean; archiveGate?: Promise<void>; restoreGate?: Promise<void> };
function fakeRuntime(options: RuntimeOptions = {}) {
  const calls = {
    archives: [] as Array<{ sourceId?: string; threadIds: string[] }>, restores: [] as SandboxDataArchive[],
    detached: [] as string[], verified: [] as string[], paused: [] as string[], deleted: [] as string[],
    deletedArchives: [] as string[], files: [] as Array<{ sandboxId?: string; path: string }>, order: [] as string[],
  };
  const runtime = {
    track() {}, trackExecution() {}, detach() {}, async close() {},
    async archiveSandbox(target: WorkspaceTarget, threadIds: string[]) {
      calls.archives.push({ sourceId: target.sandbox?.id, threadIds: [...threadIds] });
      calls.order.push('archive');
      await options.archiveGate;
      if (options.failArchive) throw new Error('backup unavailable');
      return { ...archive([], target.sandbox!), threadIds: [...threadIds] };
    },
    async restoreSandbox(target: WorkspaceTarget, stored: SandboxDataArchive, restore: SandboxRestoreOptions) {
      calls.restores.push(structuredClone(stored));
      calls.order.push('restore');
      await restore.onProgress('restoring', candidate);
      await options.restoreGate;
      await restore.onProgress('verifying', candidate);
      await restore.beforeReplace?.(candidate);
      await restore.onSandbox(candidate);
      target.sandbox = structuredClone(candidate);
    },
    async detachSandbox(target: WorkspaceTarget) {
      calls.detached.push(target.sandbox!.id);
      calls.order.push('detach');
    },
    async verifyDataArchive(stored: SandboxDataArchive) {
      calls.verified.push(stored.key);
      calls.order.push('verify');
    },
    async pauseDanglingSandbox(id: string) { calls.paused.push(id); calls.order.push('pause'); },
    async deleteDanglingSandbox(id: string) { calls.deleted.push(id); calls.order.push('delete'); },
    async deleteDataArchive(stored: SandboxDataArchive) { calls.deletedArchives.push(stored.key); },
    async file(target: WorkspaceTarget, path: string) {
      calls.files.push({ sandboxId: target.sandbox?.id, path });
      return { file: { path, name: 'result.txt', size: 2, kind: 'text' as const, mimeType: 'text/plain' }, data: Buffer.from('ok') };
    },
  } as unknown as E2BRuntime;
  return { runtime, calls };
}

async function until(check: () => boolean) {
  for (let index = 0; index < 400; index++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('timed out');
}

async function fixture(input: {
  sessions?: Session[]; project?: Project; now?: { value: number }; idleReclaimAfterMs?: number; runtime?: RuntimeOptions;
} = {}) {
  const sessions = input.sessions ?? [session()];
  const currentProject = input.project ?? project(sessions);
  const state = new MemoryState([currentProject], sessions);
  const fake = fakeRuntime(input.runtime);
  const directory = await mkdtemp(join(tmpdir(), 'hive-sandbox-lifecycle-'));
  const clock = input.now ?? { value: NOW };
  const manager = new SessionManager({} as CodexClient, directory, defaults, fake.runtime, WORKSPACE, undefined, state,
    join(directory, 'images'), { now: () => clock.value, scanIntervalMs: 2_000_000_000, retentionMs: DAY,
      idleReclaimAfterMs: input.idleReclaimAfterMs ?? DAY * 100 });
  await manager.init();
  return {
    manager, state, clock, ...fake,
    async close() { await manager.close(); await rm(directory, { recursive: true, force: true }); },
  };
}

test('idle lifecycle archives, detaches, verifies, and deletes the source sandbox', async () => {
  const f = await fixture({ idleReclaimAfterMs: 0 });
  try {
    await f.manager.sweepSandboxLifecycle();
    assert.equal(f.manager.getProject('project-1').sandbox, undefined);
    assert.equal(f.manager.get('session-1').sandbox, undefined);
    assert.deepEqual(f.calls.archives, [{ sourceId: source.id, threadIds: ['thread-original'] }]);
    assert.deepEqual(f.calls.detached, [source.id]);
    assert.deepEqual(f.calls.verified, [`${source.id}.tar.gz`]);
    assert.deepEqual(f.calls.deleted, [source.id]);
    assert.deepEqual(f.calls.order, ['archive', 'detach', 'verify', 'delete']);
  } finally { await f.close(); }
});

test('opening a project file restores the archived workspace and original Codex thread', async () => {
  const sessions = [session({ sandbox: undefined })];
  const f = await fixture({ sessions, project: project(sessions, {
    sandbox: undefined, sandboxReclaimedAt: new Date(NOW - DAY).toISOString(), sandboxDataArchive: archive(sessions),
  }) });
  try {
    const result = await f.manager.projectFile('project-1', `${WORKSPACE}/result.txt`);
    assert.equal(result.data.toString(), 'ok');
    assert.equal(f.calls.restores.length, 1);
    assert.deepEqual(f.calls.restores[0].threadIds, ['thread-original']);
    assert.deepEqual(f.calls.files, [{ sandboxId: candidate.id, path: `${WORKSPACE}/result.txt` }]);
    assert.equal(f.manager.get('session-1').sandbox?.id, candidate.id);
  } finally { await f.close(); }
});

test('concurrent project file reads share one automatic restore', async () => {
  let allowRestore!: () => void;
  const restoreGate = new Promise<void>(resolve => { allowRestore = resolve; });
  const sessions = [session({ sandbox: undefined })];
  const f = await fixture({ sessions, project: project(sessions, {
    sandbox: undefined, sandboxReclaimedAt: new Date(NOW - DAY).toISOString(), sandboxDataArchive: archive(sessions),
  }), runtime: { restoreGate } });
  try {
    const first = f.manager.projectFile('project-1', `${WORKSPACE}/result.txt`);
    const second = f.manager.projectFile('project-1', `${WORKSPACE}/result.txt`);
    await until(() => f.calls.restores.length === 1);
    assert.equal(f.calls.restores.length, 1);
    allowRestore();
    await Promise.all([first, second]);
    assert.equal(f.calls.restores.length, 1);
    assert.equal(f.calls.files.length, 2);
  } finally { allowRestore(); await f.close(); }
});

test('a file request arriving during reclaim waits, restores once, and reads the replacement sandbox', async () => {
  let allowArchive!: () => void;
  const archiveGate = new Promise<void>(resolve => { allowArchive = resolve; });
  const f = await fixture({ idleReclaimAfterMs: 0, runtime: { archiveGate } });
  try {
    await until(() => f.calls.archives.length === 1);
    const reading = f.manager.projectFile('project-1', `${WORKSPACE}/result.txt`);
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(f.calls.files.length, 0);
    allowArchive();
    const result = await reading;
    assert.equal(result.data.toString(), 'ok');
    assert.equal(f.calls.restores.length, 1);
    assert.deepEqual(f.calls.restores[0].threadIds, ['thread-original']);
    assert.deepEqual(f.calls.files, [{ sandboxId: candidate.id, path: `${WORKSPACE}/result.txt` }]);
  } finally { allowArchive(); await f.close(); }
});

test('a file request arriving during upgrade waits and then reads the upgraded sandbox', async () => {
  let allowRestore!: () => void;
  const restoreGate = new Promise<void>(resolve => { allowRestore = resolve; });
  const f = await fixture({ runtime: { restoreGate } });
  try {
    await f.manager.upgradeProjectSandbox('project-1');
    await until(() => f.calls.restores.length === 1);
    const reading = f.manager.projectFile('project-1', `${WORKSPACE}/result.txt`);
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(f.calls.files.length, 0);
    allowRestore();
    await reading;
    assert.equal(f.calls.restores.length, 1);
    assert.deepEqual(f.calls.files, [{ sandboxId: candidate.id, path: `${WORKSPACE}/result.txt` }]);
  } finally { allowRestore(); await f.close(); }
});

test('failed idle backup keeps the source sandbox bound and never deletes it', async () => {
  const legacySource = { ...source };
  delete legacySource.lastActiveAt;
  const sessions = [session({ sandbox: legacySource })];
  const originalBaseline = '2026-01-01T00:01:00.000Z';
  const f = await fixture({ sessions, project: project(sessions, {
    sandbox: legacySource, updatedAt: originalBaseline,
  }), idleReclaimAfterMs: 0, runtime: { failArchive: true } });
  try {
    await f.manager.sweepSandboxLifecycle();
    assert.equal(f.manager.getProject('project-1').sandbox?.id, source.id);
    assert.equal(f.manager.getProject('project-1').sandbox?.lastActiveAt, originalBaseline);
    assert.deepEqual(f.calls.detached, []);
    assert.deepEqual(f.calls.deleted, []);
    assert.match(f.manager.getProject('project-1').sandboxUpgrade?.error ?? '', /backup unavailable/);
  } finally { await f.close(); }
});

test('manual dangling deletion refuses a sandbox still referenced by a project', async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.manager.deleteDanglingSandbox(source.id), /仍被项目、会话或复原操作使用/);
    assert.deepEqual(f.calls.deleted, []);
  } finally { await f.close(); }
});

test('creating an empty conversation does not invalidate the restore checkpoint', async () => {
  const sessions = [session({ sandbox: undefined })];
  const f = await fixture({ sessions, project: project(sessions, {
    sandbox: undefined, sandboxReclaimedAt: new Date(NOW - DAY).toISOString(), sandboxDataArchive: archive(sessions),
  }) });
  try {
    const empty = await f.manager.create({ projectId: 'project-1', title: 'Empty conversation' });
    assert.equal(empty.threadId, null);
    assert.equal(empty.turns.length, 0);
    await f.manager.projectFile('project-1', `${WORKSPACE}/result.txt`);
    assert.equal(f.calls.restores.length, 1);
    assert.equal(f.manager.getProject('project-1').sandbox?.id, candidate.id);
  } finally { await f.close(); }
});

test('an upgraded sandbox is paused immediately and deleted after the 24-hour retention window', async () => {
  const f = await fixture();
  try {
    await f.manager.upgradeProjectSandbox('project-1');
    await until(() => f.manager.getProject('project-1').sandbox?.id === candidate.id);
    const [cleanup] = await f.manager.listSandboxCleanups();
    assert.equal(cleanup.sandboxId, source.id);
    assert.equal(Date.parse(cleanup.deleteAfter) - Date.parse(cleanup.scheduledAt), DAY);

    await f.manager.sweepSandboxLifecycle();
    assert.deepEqual(f.calls.paused, [source.id]);
    assert.deepEqual(f.calls.deleted, []);
    f.clock.value += DAY;
    await f.manager.sweepSandboxLifecycle();
    assert.deepEqual(f.calls.deleted, [source.id]);
  } finally { await f.close(); }
});

test('deleting a reclaimed project eventually releases its unreferenced data archive', async () => {
  const sessions = [session({ sandbox: undefined })];
  const stored = archive(sessions);
  const f = await fixture({ sessions, project: project(sessions, {
    sandbox: undefined, sandboxReclaimedAt: new Date(NOW - DAY).toISOString(), sandboxDataArchive: stored,
  }) });
  try {
    await f.manager.deleteProject('project-1');
    assert.deepEqual(f.calls.deletedArchives, [stored.key]);
    assert.equal(f.state.projects.length, 0);
    assert.equal(f.state.sessions.length, 0);
  } finally { await f.close(); }
});
