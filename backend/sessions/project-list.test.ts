import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Project, Settings } from '../../protocol/types.js';
import type { SandboxRuntime } from '../execution/container-runtime.js';
import type { ProjectService } from '../projects/service.js';
import { MemoryWebStateStore } from '../testing/memory-web-state.js';
import { SessionManager, type CodexClient } from './manager.js';

test('project listing does not inspect Sandboxes or contend with backup maintenance', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cocell-project-list-'));
  const id = 'project-1';
  const workingDirectory = '/workspace';
  const state = new MemoryWebStateStore();
  const project: Project = { id, name: 'Project', type: 1, requirementUrl: null,
    executionMode: 'sandbox', workingDirectory, status: 'active', completedAt: null, archivedAt: null,
    sandbox: { id: 'sandbox-1', template: 'base', status: 'ready', workingDirectory },
    createdAt: '2026-09-27T00:00:00.000Z', updatedAt: '2026-09-27T00:00:00.000Z' };
  await state.saveProject(project);
  let inspections = 0;
  const runtime = { async close() {}, async inspect() {
    inspections++;
    if (inspections > 1) throw new Error('project listing inspected the Sandbox');
  } } as unknown as SandboxRuntime;
  const defaults: Settings = { executionMode: 'sandbox', workingDirectory, model: 'test', modelReasoningEffort: 'low',
    sandboxMode: 'danger-full-access', webSearchMode: 'disabled', networkAccessEnabled: true };
  const manager = new SessionManager({} as CodexClient, directory, defaults, state, runtime);
  let releaseMaintenance: (() => void) | undefined;
  try {
    await manager.init();
    const projects = (manager as unknown as { projects: ProjectService }).projects;
    releaseMaintenance = projects.beginMaintenance(id);
    const list = await manager.listProjectsWithArchives();
    assert.equal(list.length, 1);
    assert.equal(inspections, 1);
    assert.equal(projects.get(id).sandbox?.status, 'ready');
  } finally {
    releaseMaintenance?.();
    await manager.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('new sessions and restarted projects retain their selected image version', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cocell-project-image-'));
  const state = new MemoryWebStateStore();
  const defaults: Settings = { executionMode: 'sandbox', workingDirectory: '/home/agent/workspace', model: 'test', modelReasoningEffort: 'low',
    sandboxMode: 'danger-full-access', webSearchMode: 'disabled', networkAccessEnabled: true };
  const runtime = { async close() {}, async rebuild(target: Parameters<SandboxRuntime['rebuild']>[0], save: Parameters<SandboxRuntime['rebuild']>[1]) {
    assert.deepEqual(target.imageSelection, selection);
    await save({ id: 'python-box', template: 'default', status: 'ready', workingDirectory: defaults.workingDirectory });
  }, async verifySandbox() {} } as unknown as SandboxRuntime;
  const selection = { imageId: 'python', imageName: 'Python', category: '开发', versionId: 'v1', version: 'v1',
    importedImageId: 'imported-v1', image: 'registry/python@sha256:pinned' };
  let manager = new SessionManager({} as CodexClient, directory, defaults, state, runtime);
  try {
    await manager.init();
    const project = await manager.createProject({ name: 'Python project', imageSelection: selection });
    await (manager as unknown as { sandboxOperations: { close(): Promise<void> } }).sandboxOperations.close();
    const session = await manager.create({ projectId: project.id });
    assert.deepEqual(session.imageSelection, selection);
    assert.deepEqual((await state.listProjects())[0].imageSelection, selection);
    await manager.close();
    manager = new SessionManager({} as CodexClient, directory, defaults, state, runtime);
    await manager.init();
    assert.deepEqual(manager.get(session.id).imageSelection, selection);
    assert.deepEqual(manager.getProject(project.id).imageSelection, selection);
    const sibling = await manager.create({ projectId: project.id });
    assert.deepEqual(sibling.imageSelection, selection);
  } finally { await manager.close(); await rm(directory, { recursive: true, force: true }); }
});
