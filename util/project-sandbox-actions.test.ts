import assert from 'node:assert/strict';
import test from 'node:test';
import type { ProjectSummary } from '../protocol/types.js';
import { projectSandboxActions } from './project-sandbox-actions.js';

const now = '2026-10-18T00:00:00Z';
function project(overrides: Partial<ProjectSummary> = {}): ProjectSummary {
  return { id: 'project', name: 'Project', requirementUrl: null, executionMode: 'sandbox', workingDirectory: '/workspace',
    createdAt: now, updatedAt: now, sessionCount: 0, activeSessionId: null, ...overrides };
}
const box = { id: 'box', template: 'template', status: 'ready' as const, workingDirectory: '/workspace' };

test('observed Cellbox phase overrides stale SDK status, but active remote operations remain processing', () => {
  const value = project({ sandbox: { ...box, status: 'paused', phase: 'running' },
    sandboxOperation: { kind: 'resume', status: 'succeeded', phase: '完成', updatedAt: now } });
  const running = projectSandboxActions(value);
  assert.equal(running.state, 'running');
  assert.deepEqual(running.actions.map(action => action.id), ['checkpoint', 'release']);
  for (const sandbox of [{ ...box, phase: 'running', operationId: 'remote-operation' }, { ...box, phase: 'suspending' }]) {
    const view = projectSandboxActions({ ...value, sandbox });
    assert.equal(view.state, 'processing');
    assert.deepEqual(view.actions.map(action => action.id), ['refresh']);
  }
});

test('pending and unknown lifecycle results remain actionable as observations even before the Box phase changes', () => {
  const value = project({ sandbox: { ...box, phase: 'running' },
    sandboxOperation: { kind: 'checkpoint', status: 'running', phase: '提交暂停', updatedAt: now } });
  assert.equal(projectSandboxActions(value).state, 'processing');
  assert.deepEqual(projectSandboxActions(value).actions.map(action => action.id), ['refresh']);
  value.sandboxOperation!.status = 'unknown';
  assert.equal(projectSandboxActions(value).state, 'unknown');
  assert.deepEqual(projectSandboxActions(value).actions.map(action => action.id), ['refresh', 'release']);
});

test('a running backup only disables its own duplicate action and never changes paused resume/release actions', () => {
  const value = project({ sandbox: { ...box, status: 'paused' },
    sandboxOperation: { kind: 'backup', status: 'running', phase: '备份中', updatedAt: now },
    sandboxBackup: { id: 'backup', sandboxId: box.id, status: 'running', phase: '上传中', updatedAt: now } });
  const view = projectSandboxActions(value);
  assert.equal(view.state, 'paused');
  assert.equal(view.actions.find(action => action.id === 'resume')?.disabledReason, undefined);
  assert.equal(view.actions.find(action => action.id === 'release')?.disabledReason, undefined);
  assert(view.actions.find(action => action.id === 'backup')?.disabledReason);
  value.sandboxBackup!.sandboxId = 'old-box';
  assert.equal(projectSandboxActions(value).actions.find(action => action.id === 'backup')?.disabledReason, undefined);
});

test('retained volumes distinguish released from never created without exposing unsupported backup as executable', () => {
  const value = project({ sandboxMounts: [{ volumeId: 'volume', mountPath: '/workspace' }] });
  const released = projectSandboxActions(value);
  assert.equal(released.state, 'released');
  assert.match(released.actions.find(action => action.id === 'backup')?.disabledReason ?? '', /不支持直接备份/);
  assert.equal(released.actions.some(action => action.id === 'restore'), false);
  value.latestBackup = { createdAt: now, sizeBytes: 1, checksum: 'a'.repeat(64) };
  assert.equal(projectSandboxActions(value).actions.some(action => action.id === 'restore'), true);
  const fresh = projectSandboxActions(project());
  assert.equal(fresh.state, 'missing');
  assert.equal(fresh.actions.some(action => action.id === 'backup'), false);
});

test('unknown create outcome without a Box only offers observation, not a second create or an impossible release', () => {
  const value = project({ sandboxOperation: { kind: 'create', status: 'unknown', phase: '响应丢失', updatedAt: now } });
  assert.deepEqual(projectSandboxActions(value).actions.map(action => action.id), ['refresh']);
  value.sandbox = { ...box, status: 'unknown' };
  assert.deepEqual(projectSandboxActions(value).actions.map(action => action.id), ['refresh', 'release']);
  delete value.sandbox;
  value.sandboxOperation!.status = 'running';
  assert.equal(projectSandboxActions(value).state, 'processing');
});

test('failed backup availability follows the explicit Cellbox phase and restore still requires a saved backup', () => {
  const value = project({ sandbox: { ...box, status: 'unavailable' } });
  assert(projectSandboxActions(value).actions.find(action => action.id === 'backup')?.disabledReason);
  value.sandbox!.phase = 'failed';
  assert.equal(projectSandboxActions(value).actions.find(action => action.id === 'backup')?.disabledReason, undefined);
  assert.equal(projectSandboxActions(value).actions.some(action => action.id === 'create'), false);
});
