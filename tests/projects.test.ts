import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import type { ThreadEvent } from '@openai/codex-sdk';
import { createApp } from '../server/app.js';
import { HttpError, SessionManager, type CodexClient } from '../server/manager.js';
import type { E2BRuntime } from '../server/e2b.js';
import type { AppConfig, Project, Session, Settings } from '../shared/types.js';

const completed: ThreadEvent = { type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, cache_write_input_tokens: 0, reasoning_output_tokens: 0 } };
const sandbox: NonNullable<Session['sandbox']> = { id: 'shared-box', status: 'ready', template: 'base', workingDirectory: '/home/user/workspace' };
const client: CodexClient = { startThread() { throw Error('unexpected local run'); }, resumeThread() { throw Error('unexpected local resume'); } };
const conflict = (code: number) => (error: unknown) => error instanceof HttpError && error.status === code;
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
async function fixture(t: TestContext, run: E2BRuntime['run'] = async function* () { yield completed; }) {
  const directory = await mkdtemp(join(tmpdir(), 'codex-project-test-'));
  const defaults: Settings = { executionMode: 'e2b', workingDirectory: '/home/user/workspace', model: '', modelReasoningEffort: 'medium', sandboxMode: 'workspace-write', webSearchMode: 'disabled', networkAccessEnabled: true };
  const runtime: E2BRuntime = {
    run, delete: async () => {}, close: async () => {}, changes: async () => ({ branch: '', files: [], diff: '' }),
    rawTools: async session => ({ source: 'codex-rollout', threadId: session.threadId, availability: 'pending', messages: [], nextCursor: 0, hasMore: false, skippedLines: 0 }),
  };
  const manager = new SessionManager(client, directory, defaults, runtime);
  await manager.init();
  t.after(async () => { await manager.close(); await rm(directory, { recursive: true, force: true }); });
  return { manager, runtime, defaults, directory };
}

test('legacy E2B migration is restartable, preserves threads and uses project sandbox as authority', async t => {
  const { manager, defaults, directory, runtime } = await fixture(t);
  const original = await manager.create({ title: 'Migrated workspace' });
  await manager.close();
  const legacy = { ...original, threadId: 'existing-thread', sandbox };
  delete legacy.projectId;
  await rm(join(directory, 'projects', `${original.projectId}.json`));
  await writeFile(join(directory, `${legacy.id}.json`), JSON.stringify(legacy));
  const restarted = new SessionManager(client, directory, defaults, runtime);
  t.after(() => restarted.close());
  await restarted.init();
  assert.equal(restarted.get(legacy.id).projectId, legacy.id);
  assert.equal(restarted.get(legacy.id).threadId, 'existing-thread');
  assert.equal(restarted.listProjects().length, 1);
  assert.equal(restarted.getProject(legacy.id).sandbox?.id, sandbox.id);
  await restarted.close();
  // Simulate an interruption after the project was persisted but before the legacy session was rewritten.
  await writeFile(join(directory, `${legacy.id}.json`), JSON.stringify({ ...legacy, sandbox: { ...sandbox, id: 'stale-session-copy' } }));
  const again = new SessionManager(client, directory, defaults, runtime);
  t.after(() => again.close());
  await again.init();
  assert.equal(again.listProjects().length, 1);
  assert.equal(again.get(legacy.id).sandbox?.id, sandbox.id);
  assert.equal(again.get(legacy.id).threadId, 'existing-thread');
  const persisted = JSON.parse(await readFile(join(directory, `${legacy.id}.json`), 'utf8')) as Session;
  assert.equal(persisted.projectId, legacy.id);
  assert.equal(persisted.sandbox?.id, sandbox.id);
});

test('project sessions share sandbox callbacks while SDK threads and raw logs remain independent', async t => {
  const seen: Array<{ sessionId: string; projectId?: string; threadId: string | null; sandboxId?: string }> = [];
  let updateSandbox!: Parameters<E2BRuntime['run']>[3];
  const { manager, directory } = await fixture(t, async function* (session, _turn, _signal, update) {
    seen.push({ sessionId: session.id, projectId: session.projectId, threadId: session.threadId, sandboxId: session.sandbox?.id });
    updateSandbox = update;
    await update(sandbox);
    yield { type: 'thread.started', thread_id: session.threadId ?? `thread-${session.id}` };
    yield completed;
  });
  const project = await manager.createProject({ name: 'Two conversations' });
  const first = await manager.create({ projectId: project.id });
  const second = await manager.create({ projectId: project.id });
  for (const session of [first, second, first]) { await manager.startTurn(session.id, 'Run'); await manager.waitForIdle(session.id); }
  assert.deepEqual(seen.map(s => s.threadId), [null, null, `thread-${first.id}`]);
  assert.deepEqual(seen.map(s => s.sandboxId), [undefined, sandbox.id, sandbox.id]);
  assert.equal(manager.get(second.id).sandbox?.id, sandbox.id);
  assert.notEqual(manager.get(first.id).threadId, manager.get(second.id).threadId);
  assert.equal(manager.getProject(project.id).sessionCount, 2);
  await manager.delete(first.id);
  await updateSandbox({ ...sandbox, status: 'paused' }); // The callback's original session was deleted.
  assert.equal(manager.get(second.id).sandbox?.status, 'paused');
  const diskProject = JSON.parse(await readFile(join(directory, 'projects', `${project.id}.json`), 'utf8')) as Project;
  assert.equal(diskProject.sandbox?.status, 'paused');
  assert.equal(manager.getProject(project.id).sessionCount, 1);
});

test('project execution is reserved before attachment validation; siblings conflict and other projects run independently', async t => {
  const { manager } = await fixture(t, async function* (_session, _turn, signal) {
    if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
    throw Error('cancelled');
  });
  const project = await manager.createProject({ name: 'Shared' });
  const first = await manager.create({ projectId: project.id });
  const second = await manager.create({ projectId: project.id });
  const other = await manager.create();
  const invalid = manager.startTurn(first.id, 'Invalid upload', ['/missing-project-image']);
  await assert.rejects(manager.startTurn(second.id, 'Race'), conflict(409));
  await assert.rejects(invalid, conflict(400));
  assert.equal(manager.getProject(project.id).activeSessionId, null);
  await manager.startTurn(second.id, 'First active');
  assert.equal(manager.getProject(project.id).activeSessionId, second.id);
  await assert.rejects(manager.startTurn(first.id, 'Sibling'), conflict(409));
  await assert.rejects(manager.deleteProject(project.id), conflict(409));
  await manager.startTurn(other.id, 'Other project');
  assert.equal(manager.get(other.id).status, 'running');
  await Promise.all([manager.stop(second.id), manager.stop(other.id)]);
  assert.equal(manager.getProject(project.id).activeSessionId, null);
  await manager.startTurn(first.id, 'Now available');
  await manager.stop(first.id);
});

test('failed turn persistence releases the project reservation for another session', async t => {
  const { manager, directory } = await fixture(t);
  const project = await manager.createProject({ name: 'Storage retry' });
  const first = await manager.create({ projectId: project.id });
  const second = await manager.create({ projectId: project.id });
  await mkdir(join(directory, `${first.id}.json.tmp`));
  await assert.rejects(manager.startTurn(first.id, 'Fail save'), (error: NodeJS.ErrnoException) => error.code === 'EISDIR');
  assert.equal(manager.getProject(project.id).activeSessionId, null);
  await manager.startTurn(second.id, 'Sibling can still run');
  await manager.waitForIdle(second.id);
  assert.equal(manager.get(second.id).status, 'completed');
});

test('deleting every session retains the project sandbox and deleting the empty project destroys it once', async t => {
  const { manager, runtime } = await fixture(t, async function* (_session, _turn, _signal, update) { await update(sandbox); yield completed; });
  const first = await manager.create();
  const second = await manager.create({ projectId: first.projectId });
  await manager.startTurn(first.id, 'Provision');
  await manager.waitForIdle(first.id);
  const deleted: Session[] = [];
  runtime.delete = async session => { deleted.push(structuredClone(session)); };
  await manager.delete(first.id);
  await manager.delete(second.id);
  assert.equal(deleted.length, 0);
  assert.equal(manager.getProject(first.projectId!).sessionCount, 0);
  assert.equal(manager.getProject(first.projectId!).sandbox?.id, sandbox.id);
  await manager.deleteProject(first.projectId!);
  assert.equal(deleted.length, 1);
  assert.equal(deleted[0].projectId, first.projectId);
  assert.equal(deleted[0].sandbox?.id, sandbox.id);
  assert.throws(() => manager.getProject(first.projectId!), conflict(404));
});

test('project teardown blocks concurrent creates, starts, edits, uploads and readers', async t => {
  const gate = deferred();
  const entered = deferred();
  const { manager, runtime } = await fixture(t, async function* (_session, _turn, _signal, update) { await update(sandbox); yield completed; });
  const session = await manager.create();
  await manager.startTurn(session.id, 'Provision');
  await manager.waitForIdle(session.id);
  runtime.delete = async () => { entered.resolve(); await gate.promise; };
  const deleting = manager.deleteProject(session.projectId!);
  await entered.promise;
  try {
    await Promise.all([
      assert.rejects(manager.create({ projectId: session.projectId }), conflict(409)),
      assert.rejects(manager.startTurn(session.id, 'Racing turn'), conflict(409)),
      assert.rejects(manager.updateProject(session.projectId!, { name: 'Racing edit' }), conflict(409)),
      assert.rejects(manager.update(session.id, { title: 'Racing edit' }), conflict(409)),
      assert.rejects(manager.uploadImage(session.id, new Uint8Array([1]), 'png'), conflict(409)),
      assert.rejects(manager.changes(session.id), conflict(409)),
    ]);
  } finally { gate.resolve(); await deleting; }
  assert.equal(manager.list().length, 0);
  assert.equal(manager.listProjects().length, 0);
});

test('in-flight project session creation and remote reads prevent project teardown', async t => {
  const { manager, runtime } = await fixture(t);
  const project = await manager.createProject({ name: 'Reservation' });
  const creating = manager.create({ projectId: project.id });
  await assert.rejects(manager.deleteProject(project.id), conflict(409));
  const session = await creating;
  const gate = deferred();
  runtime.changes = async () => { await gate.promise; return { branch: '', diff: '', files: [] }; };
  const reading = manager.changes(session.id);
  try { await assert.rejects(manager.deleteProject(project.id), conflict(409)); }
  finally { gate.resolve(); await reading; }
  await manager.deleteProject(project.id);
});

test('projects API accepts optional requirement links and rejects unsafe URLs or conflicting session environments', async t => {
  const { manager, defaults } = await fixture(t);
  const config: AppConfig = { defaults, sdkVersion: 'test', auth: 'api-key', approvalPolicy: 'never', capabilities: { interactiveApprovals: false, tokenDeltas: false } };
  const app = createApp(manager, config, ['localhost:3001']);
  const request = (path: string, method = 'GET', body?: unknown) => app.request(`http://localhost:3001/api${path}`, { method, headers: { host: 'localhost:3001', 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  for (const requirementUrl of ['javascript:alert(1)', 'file:///etc/passwd', 'invalid']) assert.equal((await request('/projects', 'POST', { name: 'Invalid', requirementUrl })).status, 400);
  assert.equal(manager.listProjects().length, 0);
  const created = await request('/projects', 'POST', { name: 'Independent project' });
  assert.equal(created.status, 201);
  const project = await created.json();
  assert.equal(project.requirementUrl, null);
  assert.equal(project.sessionCount, 0);
  for (const settings of [{ executionMode: 'local' }, { workingDirectory: '/home/user/another-workspace' }]) assert.equal((await request('/sessions', 'POST', { projectId: project.id, settings })).status, 400);
  assert.equal((await request('/sessions', 'POST', { projectId: project.id })).status, 201);
  const session = manager.list()[0];
  assert.equal(session.projectId, project.id);
  assert.equal((await request(`/sessions/${session.id}`, 'PATCH', { settings: { workingDirectory: '/home/user/different' } })).status, 400);
  const linked = await request(`/projects/${project.id}`, 'PATCH', { name: 'Linked requirement', requirementUrl: 'https://project.feishu.cn/example' });
  assert.equal((await linked.json()).requirementUrl, 'https://project.feishu.cn/example');
  const listed = await (await request('/projects')).json();
  assert.equal(listed[0].sessionCount, 1);
  assert.equal((await request(`/projects/${project.id}`, 'DELETE')).status, 200);
  assert.equal((await request(`/projects/${project.id}`)).status, 404);
  assert.equal((await request(`/sessions/${session.id}`)).status, 404);
});

test('failed project metadata persistence rolls back visible fields and allows a later edit', async t => {
  const { manager, directory } = await fixture(t);
  const project = await manager.createProject({ name: 'Persisted name' });
  const blocker = join(directory, 'projects', `${project.id}.json.tmp`);
  await mkdir(blocker);
  await assert.rejects(manager.updateProject(project.id, { name: 'Failed edit', requirementUrl: 'https://project.feishu.cn/not-saved' }), (error: NodeJS.ErrnoException) => error.code === 'EISDIR');
  assert.deepEqual(manager.getProject(project.id), project);
  await rm(blocker, { recursive: true });
  assert.equal((await manager.updateProject(project.id, { name: 'Successful edit' })).name, 'Successful edit');
});

test('E2B project uses the configured remote directory when the service defaults to local execution', async t => {
  const { directory, defaults, runtime } = await fixture(t);
  const localDefaults = { ...defaults, executionMode: 'local' as const, workingDirectory: directory };
  const manager = new SessionManager(client, join(directory, 'local-defaults'), localDefaults, runtime, '/home/user/custom-workspace');
  await manager.init();
  t.after(() => manager.close());
  const project = await manager.createProject({ name: 'Remote project' });
  assert.equal(project.executionMode, 'e2b');
  assert.equal(project.workingDirectory, '/home/user/custom-workspace');
  const session = await manager.create({ projectId: project.id });
  assert.equal(session.settings.workingDirectory, project.workingDirectory);
  assert.equal(session.settings.networkAccessEnabled, true);
});
