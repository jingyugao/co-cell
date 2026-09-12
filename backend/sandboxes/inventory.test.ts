import assert from 'node:assert/strict';
import test from 'node:test';
import type { SandboxInfo } from 'e2b';
import type { ProjectSummary, SessionSummary } from '../../protocol/types.js';
import { E2BSandboxInventory } from './inventory.js';

const pausedSandbox = (id: string, app = 'codex-web'): SandboxInfo => ({
  sandboxId: id,
  templateId: 'template-id',
  name: 'template-name',
  metadata: { app, projectId: 'stale-provider-project' },
  state: 'paused',
  cpuCount: 2,
  memoryMB: 1024,
  startedAt: new Date('2026-01-01T00:00:00Z'),
  endAt: new Date('2026-01-02T00:00:00Z'),
} as unknown as SandboxInfo);

function project(id: string, sandboxId: string, upgrade?: ProjectSummary['sandboxUpgrade']): ProjectSummary {
  return {
    id, name: id, requirementUrl: null, executionMode: 'e2b', workingDirectory: '/home/user/workspace',
    sandbox: { id: sandboxId, template: 'template-name', status: 'paused', workingDirectory: '/home/user/workspace' }, sandboxUpgrade: upgrade,
    createdAt: '', updatedAt: '', sessionCount: 0, activeSessionId: null,
  };
}

function legacySession(sandboxId: string): SessionSummary {
  return {
    id: 'legacy-session', threadId: null, title: 'legacy', settings: { executionMode: 'e2b' } as SessionSummary['settings'],
    status: 'idle', sandbox: { id: sandboxId, template: 'template-name', status: 'paused', workingDirectory: '/home/user/workspace' },
    startedAt: '', archivedAt: null, createdAt: '', updatedAt: '', turnCount: 0,
  };
}

test('only unreferenced codex-web sandboxes are marked dangling', async () => {
  const sandboxes = [
    pausedSandbox('old'), pausedSandbox('current'), pausedSandbox('candidate'), pausedSandbox('failed-candidate'),
    pausedSandbox('legacy'), pausedSandbox('foreign', 'another-app'),
  ];
  let returned = false;
  const api = {
    list: () => ({
      get hasNext() { return !returned; },
      async nextItems() { returned = true; return sandboxes; },
    }),
    async getMetrics() { return []; },
  };
  const current = project('current-project', 'current');
  const upgrading = project('upgrading-project', 'upgrade-source', {
    id: 'upgrade-1', source: { id: 'upgrade-source', template: 'old-template', status: 'paused', workingDirectory: '/home/user/workspace' },
    target: { id: 'candidate', template: 'template-name', status: 'paused', workingDirectory: '/home/user/workspace' }, phase: 'verifying', startedAt: '',
  });
  const failed = project('failed-project', 'failed-source', {
    id: 'upgrade-2', source: { id: 'failed-source', template: 'old-template', status: 'paused', workingDirectory: '/home/user/workspace' },
    target: { id: 'failed-candidate', template: 'template-name', status: 'paused', workingDirectory: '/home/user/workspace' }, phase: 'failed', startedAt: '',
  });
  const reader = new E2BSandboxInventory({ apiKey: 'test' }, api);

  const inventory = await reader.read([legacySession('legacy')], [current, upgrading, failed]);
  const dangling = Object.fromEntries(inventory.sandboxes.map(sandbox => [sandbox.id, sandbox.dangling]));
  assert.deepEqual(dangling, {
    old: true,
    current: false,
    candidate: false,
    'failed-candidate': true,
    legacy: false,
    foreign: false,
  });
});
