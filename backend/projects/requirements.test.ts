import assert from 'node:assert/strict';
import test from 'node:test';
import { HttpError } from '../../util/errors.js';
import { readSystemRequirementInfo } from './requirements.js';
import type { SystemToolCommand } from '../execution/system-tools.js';

test('requirement lookup uses one system tool environment and distinguishes auth/network failures', async () => {
  for (const mode of ['ok', 'missing', 'network', 'malformed', 'truncated']) {
    let entries = 0;
    const calls: string[][] = [];
    const tools = { async withTools<T>(action: (run: SystemToolCommand) => Promise<T>) {
      entries++;
      return action(async (tool, args) => {
        assert.equal(tool, 'meegle'); calls.push(args);
        let data: unknown, exitCode = 0;
        const host = 'project.example.test';
        if (args[0] === 'url') data = { url_kind: 'workitem_detail', host, simple_name: 'sample', work_item_id: '42' };
        else if (args[0] === 'auth') {
          data = mode === 'ok' ? { authenticated: true, host } : mode === 'malformed' ? 'synthetic-private-error' : { authenticated: false, host };
          exitCode = mode === 'ok' ? 0 : mode === 'network' ? 2 : 1;
        } else if (args[0] === 'project') data = { projects: [{ project_key: 'canonical', simple_name: 'sample' }] };
        else if (args[0] === 'workitem') {
          assert(args.includes('canonical'));
          data = { work_item_attribute: { work_item_id: '42', work_item_name: 'Requirement', owned_project: { key: 'canonical' }, status: { name: '进行中' } } };
        } else assert.fail('unexpected command');
        return { stdout: JSON.stringify(data), stderr: 'synthetic-private-error', exitCode, truncated: mode === 'truncated' };
      });
    } };
    const result = readSystemRequirementInfo('https://project.example.test/sample/story/detail/42', tools);
    if (mode === 'ok') {
      assert.deepEqual(await result, { name: 'Requirement', status: '进行中' });
      assert.equal(calls.length, 4);
    } else await assert.rejects(result, (error: unknown) => {
      assert(error instanceof HttpError);
      assert.equal(error.status, mode === 'missing' ? 409 : 502);
      assert(!error.message.includes('synthetic-private'));
      return true;
    });
    assert.equal(entries, 1);
  }
});
