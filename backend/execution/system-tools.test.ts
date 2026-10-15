import assert from 'node:assert/strict';
import test from 'node:test';
import type { Project, ProjectSummary } from '../../protocol/types.js';
import { SystemTools } from './system-tools.js';

test('system tools use the active project, enter its current sandbox and hold usage across the full operation', async () => {
  const events: string[] = [];
  const tools = new SystemTools({
    projects: async () => [{ id: 'old', name: 'system', status: 'archived' }, { id: 'current', name: 'system', status: 'active' }] as Project[],
    enter: async id => { assert.equal(id, 'current'); events.push('enter'); return { sandbox: { id: 'box-current', status: 'ready' } } as ProjectSummary; },
    acquireUsage: async id => { assert.equal(id, 'box-current'); events.push('acquire'); return async () => { events.push('release'); }; },
    execute: async (boxId, tool, args) => {
      assert.equal(boxId, 'box-current'); assert.equal(tool, 'cocell_meegle'); assert.deepEqual(args, ['auth', 'status']);
      events.push('execute'); return { stdout: '{}', stderr: '', exitCode: 0 };
    },
  });
  assert.equal(await tools.withTools(async run => { await run('meegle', ['auth', 'status']); return 42; }), 42);
  assert.deepEqual(events, ['enter', 'acquire', 'execute', 'release']);
  events.length = 0;
  await assert.rejects(tools.withTools(async () => { throw new Error('failed'); }), /failed/);
  assert.deepEqual(events, ['enter', 'acquire', 'release']);
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
