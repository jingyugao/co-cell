import assert from 'node:assert/strict';
import test from 'node:test';
import type { Project, ProjectSummary } from '../../protocol/types.js';
import { providerError } from '../../util/errors.js';
import { CellboxError } from '../../packages/sandbox/src/providers/cellbox/client.js';
import { SystemTools } from './system-tools.js';

test('system tools use the active project without acquiring a remote usage lease', async () => {
  const events: string[] = [];
  const tools = new SystemTools({
    projects: async () => [{ id: 'old', name: 'system', status: 'archived' }, { id: 'current', name: 'system', status: 'active' }] as Project[],
    enter: async id => { assert.equal(id, 'current'); events.push('enter'); return { sandbox: { id: 'box-current', status: 'ready' } } as ProjectSummary; },
    acquireUsage: async () => { events.push('acquire'); throw new Error('remote lease must not be acquired'); },
    execute: async (boxId, tool, args) => {
      assert.equal(boxId, 'box-current'); assert.equal(tool, 'cocell_meegle'); assert.deepEqual(args, ['auth', 'status']);
      events.push('execute'); return { stdout: '{}', stderr: '', exitCode: 0 };
    },
  });
  assert.equal(await tools.withTools(async run => { await run('meegle', ['auth', 'status']); return 42; }), 42);
  assert.deepEqual(events, ['enter', 'execute']);
  events.length = 0;
  await assert.rejects(tools.withTools(async () => { throw new Error('failed'); }), /failed/);
  assert.deepEqual(events, ['enter']);
});

test('provider errors survive cause chains with status and code while credentials are redacted', async () => {
  const { providerError } = await import('../../util/errors.js');
  const provider = Object.assign(new Error('authorization failed: Bearer very-secret password=hunter2 token=abc123'), {
    name: 'CellboxError', code: 'UNKNOWN_OUTCOME', status: 503,
  });
  const wrapper = new Error('resume failed', { cause: new Error('provider call failed', { cause: provider }) });
  assert.deepEqual(providerError(wrapper), {
    code: 'UNKNOWN_OUTCOME',
    message: 'authorization failed: Bearer [REDACTED] password=[REDACTED] token=[REDACTED]',
    status: 503,
  });

  const busy = Object.assign(new Error('resource busy'), { name: 'CellboxError', code: 'BUSY', status: 423 });
  assert.deepEqual(providerError(busy), { code: 'BUSY', message: 'resource busy', status: 423 });
});

test('system tools reject missing/ambiguous projects and never run an unready sandbox', async () => {
  for (const projects of [[], [{ id: 'a', name: 'system', status: 'active' }, { id: 'b', name: 'system', status: 'active' }]]) {
    const tools = new SystemTools({ projects: async () => projects as Project[], enter: async () => { assert.fail('must not enter'); },
      acquireUsage: async () => { assert.fail('must not acquire'); }, execute: async () => { assert.fail('must not execute'); } });
    await assert.rejects(tools.withTools(async () => {}), /system/);
  }
  const tools = new SystemTools({ projects: async () => [{ name: 'system', status: 'active', id: 'a' }] as Project[],
    enter: async () => ({ sandbox: { status: 'paused' } }) as ProjectSummary,
    acquireUsage: async () => { assert.fail('must not acquire'); }, execute: async () => { assert.fail('must not execute'); } });
  await assert.rejects(tools.withTools(async () => {}), /尚未就绪/);
});

test('an unreadable accepted mutation response is an upstream error, not an HTTP success', () => {
  const detail = providerError(new CellboxError('UNKNOWN_OUTCOME', 'Accepted response could not be decoded', 202));
  assert.equal(detail?.code, 'UNKNOWN_OUTCOME');
  assert.equal(detail?.status, 502);
  assert.equal(detail?.upstreamStatus, 202);
});

test('frontend API never treats an undecodable accepted mutation response as success', async t => {
  const { api, ApiError } = await import('../../fe/lib/api.js');
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => { requests++; return new Response('invalid JSON', { status: 202 }); });
  await assert.rejects(api('/api/projects/p/sandbox/resume', { method: 'POST' }),
    error => error instanceof ApiError && error.code === 'UNKNOWN_OUTCOME' && error.upstreamStatus === 202);
  assert.equal(requests, 1);
  await assert.rejects(api('/api/projects/p'), error => error instanceof ApiError && error.code === 'PROTOCOL');
  assert.equal(requests, 2);
});
