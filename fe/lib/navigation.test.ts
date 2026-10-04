import assert from 'node:assert/strict';
import test from 'node:test';
import type { ProjectSummary, SessionSummary } from '../../protocol/types.js';
import { resolveSelection } from './navigation.js';

const project = (id: string, archivedAt: string | null): ProjectSummary => ({
  id, name: id, requirementUrl: null, executionMode: 'sandbox', workingDirectory: '/home/agent/workspace',
  archivedAt, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
  sessionCount: 0, activeSessionId: null,
  sandbox: { id: `sandbox-${id}`, status: 'ready', template: 'default', workingDirectory: '/home/agent/workspace' },
});

test('workspace routes open pending and checkpointed projects before their runtime is ready', () => {
  storage.clear();
  const pending = { ...project('pending', null), sandbox: undefined,
    sandboxOperation: { kind: 'create' as const, status: 'running' as const, phase: '创建 Sandbox', updatedAt: '2026-09-30T00:00:00Z' } };
  const paused = project('paused', null); paused.sandbox!.status = 'paused';
  const ready = project('ready', null);
  const route = { page: 'chat' as const, sessionId: null, projectId: null, explicit: false, invalid: false };
  assert.equal(resolveSelection(route, [], [pending, paused, ready]).projectId, pending.id);
  for (const value of [pending, paused, { ...pending, sandboxOperation: undefined }]) {
    const result = resolveSelection({ ...route, projectId: value.id, explicit: true }, [], [value]);
    assert.equal(result.projectId, value.id);
    assert.equal(result.error, undefined);
    const session = { id: `session-${value.id}`, projectId: value.id } as SessionSummary;
    assert.equal(resolveSelection({ ...route, sessionId: session.id, explicit: true }, [session], [value]).sessionId, session.id);
  }
});

const storage = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (key: string) => storage.get(key) ?? null } });

test('default project selection excludes archived projects and cached archived sessions', () => {
  const archived = project('archived', '2026-09-01T00:00:00.000Z');
  const active = project('active', null);
  const archivedSession = { id: 'session-1', projectId: archived.id } as SessionSummary;
  storage.set('codex-project', archived.id);
  storage.set('codex-session', archivedSession.id);

  const selected = resolveSelection({ page: 'chat', sessionId: null, projectId: null, explicit: false, invalid: false }, [archivedSession], [archived, active]);
  assert.deepEqual(selected, { sessionId: null, projectId: active.id });
});

test('direct project and session routes cannot enter an archived project', () => {
  const archived = project('archived', '2026-09-01T00:00:00.000Z');
  const archivedSession = { id: 'session-1', projectId: archived.id } as SessionSummary;
  const projectRoute = resolveSelection({ page: 'chat', sessionId: null, projectId: archived.id, explicit: true, invalid: false }, [archivedSession], [archived]);
  const sessionRoute = resolveSelection({ page: 'chat', sessionId: archivedSession.id, projectId: null, explicit: true, invalid: false }, [archivedSession], [archived]);

  assert.match(projectRoute.error ?? '', /已归档/);
  assert.match(sessionRoute.error ?? '', /已归档/);
  assert.equal(projectRoute.projectId, null);
  assert.equal(sessionRoute.sessionId, null);
});
