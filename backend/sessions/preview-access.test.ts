import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Settings } from '../../protocol/types.js';
import type { SandboxState } from '../../protocol/sandbox-types.js';
import type { SandboxRuntime } from '../execution/container-runtime.js';
import { MemoryWebStateStore } from '../testing/memory-web-state.js';
import { SessionManager, type CodexClient } from './manager.js';

const defaults: Settings = { executionMode: 'sandbox', workingDirectory: '/home/agent/workspace', model: 'test',
  modelReasoningEffort: 'low', sandboxMode: 'danger-full-access', webSearchMode: 'disabled', networkAccessEnabled: true };

test('preview access retains runtime/project ownership and releases it once even after runtime failure', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cocell-preview-lease-'));
  const state = new MemoryWebStateStore();
  const box: SandboxState = { id: 'preview-box', status: 'ready', template: 'default', workingDirectory: '/home/agent/workspace' };
  let releases = 0;
  let refuseAccess = false;
  const runtime = {
    rebuild: async (_target: unknown, save: (value: SandboxState) => Promise<void>) => save(box),
    verifySandbox: async () => {},
    currentImageIdentity: async () => undefined,
    resume: async () => box,
    querySandbox: async () => box,
    track: async (_target: unknown, save: (value: SandboxState) => Promise<void>) => save(box),
    openServiceAccess: async () => {
      if (refuseAccess) throw new Error('service unavailable');
      return { url: 'http://localhost/internal/', headers: {}, release: async () => { releases++; throw new Error('release failed'); } };
    },
    close: async () => {},
  } as unknown as SandboxRuntime;
  const manager = new SessionManager({} as CodexClient, directory, defaults, state, runtime, '/home/agent/workspace');
  try {
    await manager.init();
    const project = await manager.createProject({ name: 'Preview' });
    const ready = await manager.enterProject(project.id);
    assert.equal(ready.sandbox?.status, 'ready');
    const access = await manager.projectServiceAccess(project.id, 8080, 'POST', new AbortController().signal);
    const projects = (manager as any).projects;
    assert.equal(projects.operations.get(project.id), 1);
    await assert.rejects(access.release(), /release failed/);
    await access.release();
    assert.equal(releases, 1);
    assert.equal(projects.operations.has(project.id), false);
    refuseAccess = true;
    await assert.rejects(manager.projectServiceAccess(project.id, 8080, 'POST', new AbortController().signal), /service unavailable/);
    assert.equal(projects.operations.has(project.id), false);
    assert.equal(projects.reads.has(project.id), false);
  } finally { await manager.close(); await rm(directory, { recursive: true, force: true }); }
});
