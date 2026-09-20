import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Project } from '../../protocol/types.js';
import type { SandboxState } from '../../protocol/sandbox-types.js';
import type { ArchiveManager } from '../archives/manager.js';
import type { SandboxRuntime } from '../execution/container-runtime.js';
import { JsonWebStateStore } from '../infra/storage/web-state.js';
import { ProjectService } from './service.js';
import { ProjectSandboxOperations } from './sandbox-operations.js';

const workdir = '/home/user/workspace';
const sandbox = (id = 'sandbox-old', status: SandboxState['status'] = 'ready'): SandboxState => ({ id, status, template: 'base', workingDirectory: workdir });
const project = (id: string, overrides: Partial<Project> = {}): Project => ({
  id, name: 'sandbox operation', type: 1, requirementUrl: null, executionMode: 'sandbox', workingDirectory: workdir,
  status: 'active', completedAt: null, archivedAt: null, sandbox: sandbox(),
  createdAt: '2026-09-20T00:00:00.000Z', updatedAt: '2026-09-20T00:00:00.000Z', ...overrides,
});
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

class FakeArchives {
  latest?: { storagePath: string; sizeBytes: number; sha256: string; createdAt: string };
  creates = 0;
  constructor(private directory: string) {}
  async getLatest() { return this.latest; }
  async create(key: string | undefined, _metadata: Record<string, unknown>, create: (path: string) => Promise<{ sizeBytes: number; sha256: string }>) {
    this.creates++;
    const path = join(this.directory, `archive-${this.creates}.tar.gz`);
    const file = await create(path);
    this.latest = { ...file, storagePath: path, createdAt: '2026-09-20T01:00:00.000Z' };
    return { archiveKey: key ?? 'archive-stream', ...this.latest };
  }
}

type RuntimeControl = {
  inspect?: 'ok' | 'unavailable' | 'error'; archive?: 'ok' | 'fail'; restore?: 'ok' | 'fail'; verify?: 'ok' | 'fail';
  cleanup?: 'ok' | 'fail'; fence?: 'ok' | 'fail'; blockCreate?: Promise<void>; duringRestore?: () => void;
};
const runtime = (control: RuntimeControl, calls: string[]): SandboxRuntime => ({
  async close() {}, async *run() {}, async *recover() {}, detach() {}, async preview() { return ''; }, async proxyHost() { return ''; },
  async file() { throw new Error('unused'); }, async history() { throw new Error('unused'); }, async delete() {}, async rebuild() {},
  async inspect() { calls.push('inspect'); if (control.inspect === 'unavailable') { const error = Object.assign(new Error('gone'), { code: 'not_accessible' }); throw error; } if (control.inspect === 'error') throw new Error('docker unavailable'); },
  async createArchive(_target, path) {
    calls.push('archive'); if (control.archive === 'fail') throw new Error('archive failed');
    const value = 'a valid backup'; await writeFile(path, value); return { sizeBytes: value.length, sha256: digest(value) };
  },
  async fenceSandbox(value) { calls.push(`fence:${value.id}`); if (control.fence === 'fail') throw new Error('fence failed'); },
  async detachSandbox() { calls.push('detach'); },
  async createReplacement(_target, onSandbox) {
    calls.push('create'); await control.blockCreate; const value = sandbox('sandbox-new', 'starting'); await onSandbox(value); return value;
  },
  async restoreReplacement(_sandbox, path) { calls.push('restore'); await stat(path); control.duringRestore?.(); if (control.restore === 'fail') throw new Error('restore failed'); },
  async verifySandbox() { calls.push('verify'); if (control.verify === 'fail') throw new Error('verify failed'); },
  async deleteDanglingSandbox(id) { calls.push(`delete:${id}`); if (control.cleanup === 'fail') throw new Error('delete failed'); },
});

async function fixture(value: Project, control: RuntimeControl = {}, latest?: string) {
  const directory = await mkdtemp(join(tmpdir(), 'swarm-hive-sandbox-operations-'));
  const state = new JsonWebStateStore(join(directory, 'state'));
  await state.init(); await state.saveProject(value);
  const projects = new ProjectService(state); await projects.init();
  const archives = new FakeArchives(directory);
  if (latest !== undefined) {
    const path = join(directory, 'latest.tar.gz'); await writeFile(path, latest);
    archives.latest = { storagePath: path, sizeBytes: Buffer.byteLength(latest), sha256: digest(latest), createdAt: '2026-09-20T00:30:00.000Z' };
    await projects.saveArchiveKey(value.id, 'archive-stream');
  }
  const calls: string[] = [];
  const operations = new ProjectSandboxOperations({ projects, runtime: runtime(control, calls), archives: () => archives as unknown as ArchiveManager,
    directory: join(directory, 'archives'), threadIds: () => ['thread-1'], saveSandbox: async (id, value, restore) => { await projects.updateSandbox(id, value, restore); }, detached: async () => {} });
  return { directory, state, projects, archives, calls, operations, async close() { await operations.close(); await projects.close(); await state.close(); await rm(directory, { recursive: true, force: true }); } };
}

test('manual backup succeeds without changing lifecycle and a failed replacement keeps the last backup', async () => {
  const f = await fixture(project('11111111-1111-4111-8111-111111111111', { archiveKey: 'archive-stream' }), {}, 'old backup');
  try {
    await f.operations.run('11111111-1111-4111-8111-111111111111', 'backup');
    assert.equal(f.projects.get('11111111-1111-4111-8111-111111111111').status, 'active');
    assert.equal(f.archives.creates, 1);
    const before = f.archives.latest!;
    // The archive manager should not replace a successful pointer when creation fails.
    const failing = await fixture(project('22222222-2222-4222-8222-222222222222', { archiveKey: 'archive-stream' }), { archive: 'fail' }, 'old backup');
    try {
      await assert.rejects(failing.operations.run('22222222-2222-4222-8222-222222222222', 'backup'), /archive failed/);
      assert.equal(await readFile(failing.archives.latest!.storagePath, 'utf8'), 'old backup');
    } finally { await failing.close(); }
    assert.equal(before.sha256, digest('a valid backup'));
  } finally { await f.close(); }
});

test('active or completed projects replace unavailable or absent sandboxes and preserve business status', async () => {
  for (const [id, status, current] of [
    ['33333333-3333-4333-8333-333333333333', 'active', sandbox('old-a', 'unavailable')],
    ['44444444-4444-4444-8444-444444444444', 'completed', undefined],
  ] as const) {
    const f = await fixture(project(id, { status, completedAt: status === 'completed' ? '2026-09-19T00:00:00.000Z' : null, sandbox: current }), {}, 'backup');
    try {
      await f.operations.run(id, 'restore');
      const restored = f.projects.get(id);
      assert.equal(restored.status, status);
      assert.equal(restored.sandbox?.id, 'sandbox-new');
      assert.equal(f.calls.includes('restore'), true);
      assert.equal(f.calls.includes('verify'), true);
      assert.equal(f.calls.includes('delete:old-a'), current !== undefined);
    } finally { await f.close(); }
  }
});

test('archived restore becomes active only after the replacement is verified', async () => {
  const f = await fixture(project('55555555-5555-4555-8555-555555555555', { status: 'archived', archivedAt: '2026-09-19T00:00:00.000Z', sandbox: undefined }), {}, 'backup');
  try {
    await f.operations.run('55555555-5555-4555-8555-555555555555', 'restore');
    const restored = f.projects.get('55555555-5555-4555-8555-555555555555');
    assert.equal(restored.status, 'active');
    assert.equal(restored.archivedAt, null);
    assert.equal(restored.sandbox?.id, 'sandbox-new');
  } finally { await f.close(); }
});

test('failed restore or verification never switches the old binding and can be retried', async () => {
  const id = '66666666-6666-4666-8666-666666666666';
  const control: RuntimeControl = { verify: 'fail' };
  const f = await fixture(project(id, { sandbox: sandbox('old', 'unavailable') }), control, 'backup');
  try {
    let bindingDuringRestore: string | undefined;
    let phaseDuringRestore: string | undefined;
    control.duringRestore = () => {
      bindingDuringRestore = f.projects.get(id).sandbox?.id;
      phaseDuringRestore = f.projects.get(id).sandboxOperation?.phase;
    };
    await assert.rejects(f.operations.run(id, 'restore'), /verify failed/);
    assert.equal(bindingDuringRestore, 'old');
    assert.equal(phaseDuringRestore, '恢复数据');
    assert.equal(f.projects.get(id).sandbox?.id, 'old');
    assert.equal(f.projects.get(id).sandboxOperation?.status, 'failed');
    // Switch to a healthy replacement and retry using the same latest archive.
    control.verify = 'ok';
    await f.operations.run(id, 'restore');
    assert.equal(f.projects.get(id).sandbox?.id, 'sandbox-new');
  } finally { await f.close(); }
});

test('a fence failure leaves the old binding in place and does not create a replacement', async () => {
  const id = '67676767-6767-4676-8676-676767676767';
  const f = await fixture(project(id, { sandbox: sandbox('old', 'unavailable') }), { fence: 'fail' }, 'backup');
  try {
    await assert.rejects(f.operations.run(id, 'restore'), /fence failed/);
    assert.equal(f.projects.get(id).sandbox?.id, 'old');
    assert.equal(f.calls.includes('create'), false);
  } finally { await f.close(); }
});

test('a corrupt latest backup neither falls back nor creates a replacement', async () => {
  const id = '77777777-7777-4777-8777-777777777777';
  const f = await fixture(project(id, { sandbox: undefined }), {}, 'backup');
  try {
    f.archives.latest!.sha256 = digest('different');
    await assert.rejects(f.operations.run(id, 'restore'), /校验失败/);
    assert.equal(f.calls.includes('create'), false);
  } finally { await f.close(); }
});

test('healthy archive stops on backup failure; unavailable archive requires explicit existing-backup confirmation', async () => {
  const healthy = await fixture(project('88888888-8888-4888-8888-888888888888'), { archive: 'fail' }, 'old backup');
  try {
    await assert.rejects(healthy.operations.run('88888888-8888-4888-8888-888888888888', 'archive'), /archive failed/);
    assert.equal(healthy.projects.get('88888888-8888-4888-8888-888888888888').sandbox?.id, 'sandbox-old');
  } finally { await healthy.close(); }
  const id = '99999999-9999-4999-8999-999999999999';
  const unavailable = await fixture(project(id, { sandbox: sandbox('old', 'unavailable') }), {}, 'old backup');
  try {
    await assert.rejects(unavailable.operations.run(id, 'archive'), /确认使用已有备份/);
    assert.equal(unavailable.projects.get(id).status, 'active');
    await unavailable.operations.run(id, 'archive', { useExistingBackup: true });
    assert.equal(unavailable.projects.get(id).status, 'archived');
  } finally { await unavailable.close(); }
  const successful = await fixture(project('98989898-9898-4989-8989-989898989898'));
  try {
    await successful.operations.run('98989898-9898-4989-8989-989898989898', 'archive');
    const archived = successful.projects.get('98989898-9898-4989-8989-989898989898');
    assert.equal(archived.status, 'archived');
    assert.equal(archived.sandbox, undefined);
    assert.equal(successful.calls.includes('detach'), true);
    assert.equal(successful.calls.includes('delete:sandbox-old'), true);
  } finally { await successful.close(); }
});

test('maintenance excludes concurrent operations, cleanup failures remain pending, and startup marks interrupted work failed', async () => {
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(project(id, { sandbox: sandbox('old', 'unavailable') }), { blockCreate: blocked, cleanup: 'fail' }, 'backup');
  try {
    const releaseSession = f.projects.startSession(id, 'active-turn');
    assert.throws(() => f.operations.run(id, 'restore'), /项目正在使用/);
    releaseSession();
    const first = f.operations.run(id, 'restore');
    await new Promise(resolve => setImmediate(resolve));
    assert.throws(() => f.operations.run(id, 'restore'), /正在维护/);
    release(); await first;
    assert.equal(f.projects.get(id).pendingSandboxCleanup?.some(item => item.id === 'old'), true);
  } finally { await f.close(); }

  const directory = await mkdtemp(join(tmpdir(), 'swarm-hive-operation-restart-'));
  const state = new JsonWebStateStore(directory); await state.init();
  await state.saveProject(project('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', { sandboxOperation: { kind: 'restore', phase: '恢复数据', status: 'running', updatedAt: '2026-09-20T00:00:00.000Z' } }));
  const restarted = new ProjectService(state); await restarted.init();
  assert.equal(restarted.get('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb').sandboxOperation?.status, 'failed');
  await restarted.close(); await state.close(); await rm(directory, { recursive: true, force: true });
});
