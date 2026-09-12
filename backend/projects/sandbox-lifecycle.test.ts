import assert from 'node:assert/strict';
import test from 'node:test';
import type { Project } from '../../protocol/types.js';
import { SandboxLifecycleService } from './sandbox-lifecycle.js';

const sandbox = { id: 'sandbox-1', status: 'ready' as const, template: 'base', workingDirectory: '/home/user/workspace' };
const project = (id: string, overrides: Partial<Project> = {}): Project => ({
  id, name: id, requirementUrl: null, executionMode: 'e2b', workingDirectory: sandbox.workingDirectory,
  sandbox: { ...sandbox, id: `sandbox-${id}` }, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
  ...overrides,
});

test('sweep reclaims only idle E2B projects with a current sandbox', async () => {
  const now = Date.parse('2026-04-01T00:00:00.000Z');
  const threshold = 7 * 24 * 60 * 60 * 1000;
  const projects = [
    project('idle', { sandbox: { ...sandbox, lastActiveAt: new Date(now - threshold).toISOString() } }),
    project('active', { sandbox: { ...sandbox, lastActiveAt: new Date(now - threshold + 1).toISOString() } }),
    project('local', { executionMode: 'local' }),
    project('missing', { sandbox: undefined }),
  ];
  const reclaimed: string[] = [];
  const service = new SandboxLifecycleService({ listProjects: () => projects, reclaim: async id => { reclaimed.push(id); }, now: () => now });
  await service.sweep();
  assert.deepEqual(reclaimed, ['idle']);
  await service.close();
});

test('lastActiveAt takes precedence and updatedAt is the fallback', async () => {
  const now = Date.parse('2026-04-01T00:00:00.000Z');
  const day = 24 * 60 * 60 * 1000;
  const projects = [
    project('recent-activity', { updatedAt: new Date(now - 10 * day).toISOString(), sandbox: { ...sandbox, lastActiveAt: new Date(now - day).toISOString() } }),
    project('fallback', { updatedAt: new Date(now - 8 * day).toISOString(), sandbox: { ...sandbox } }),
  ];
  const reclaimed: string[] = [];
  const service = new SandboxLifecycleService({ listProjects: () => projects, reclaim: async id => { reclaimed.push(id); }, now: () => now });
  await service.sweep();
  assert.deepEqual(reclaimed, ['fallback']);
  await service.close();
});

test('overlapping sweeps share one serial pass', async () => {
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const reclaimed: string[] = [];
  let concurrent = 0;
  let maximumConcurrent = 0;
  const service = new SandboxLifecycleService({
    listProjects: () => [project('one'), project('two')], idleReclaimAfterMs: 0, now: () => 1,
    reclaim: async id => {
      reclaimed.push(id); concurrent++; maximumConcurrent = Math.max(maximumConcurrent, concurrent);
      if (id === 'one') await blocked;
      concurrent--;
    },
  });
  const first = service.sweep();
  const overlapping = service.sweep();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(reclaimed, ['one']);
  release();
  await Promise.all([first, overlapping]);
  assert.deepEqual(reclaimed, ['one', 'two']);
  assert.equal(maximumConcurrent, 1);
  await service.close();
});

test('one reclaim failure does not stop the pass or cause an immediate retry', async () => {
  const calls: string[] = [];
  const service = new SandboxLifecycleService({
    listProjects: () => [project('fails'), project('succeeds')], idleReclaimAfterMs: 0, now: () => 1,
    reclaim: async id => { calls.push(id); if (id === 'fails') throw new Error('busy'); },
  });
  await service.sweep();
  assert.deepEqual(calls, ['fails', 'succeeds']);
  await service.sweep();
  assert.deepEqual(calls, ['fails', 'succeeds', 'fails', 'succeeds']);
  await service.close();
});

test('close waits for the current reclaim and stops the remaining pass', async () => {
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const calls: string[] = [];
  const service = new SandboxLifecycleService({
    listProjects: () => [project('one'), project('two')], idleReclaimAfterMs: 0, now: () => 1,
    reclaim: async id => { calls.push(id); await blocked; },
  });
  void service.sweep();
  await new Promise(resolve => setImmediate(resolve));
  const closing = service.close();
  release();
  await closing;
  assert.deepEqual(calls, ['one']);
  await service.sweep();
  assert.deepEqual(calls, ['one']);
});
