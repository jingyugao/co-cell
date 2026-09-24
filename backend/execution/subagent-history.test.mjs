import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readSubagentConversations } from './native-history.mjs';

test('subagent history follows thread ancestry and hides injected prompts', async () => {
  const home = await mkdtemp(join(tmpdir(), 'cocell-subagents-'));
  const parent = randomUUID(), child = randomUUID(), grandchild = randomUUID(), unrelated = randomUUID();
  const day = join(home, 'sessions', '2026', '09', '24');
  await mkdir(day, { recursive: true });
  async function rollout(id, parentId, path) {
    const records = [
      { timestamp: '2026-09-24T09:00:00.000Z', type: 'session_meta', payload: { id, source: { subagent: { thread_spawn: { parent_thread_id: parentId, agent_path: path, depth: path.split('/').length - 1 } } } } },
      { timestamp: '2026-09-24T09:00:01.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: id } },
      { timestamp: '2026-09-24T09:00:02.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ text: 'private injected rules' }] } },
      { timestamp: '2026-09-24T09:00:03.000Z', type: 'event_msg', payload: { type: 'item_completed', item: { id: `${id}-answer`, type: 'AgentMessage', content: [{ text: path }] } } },
      { timestamp: '2026-09-24T09:00:04.000Z', type: 'event_msg', payload: { type: 'task_complete' } },
    ];
    await writeFile(join(day, `rollout-2026-09-24T09-00-00-${id}.jsonl`), `${records.map(record => JSON.stringify(record)).join('\n')}\n`);
  }
  try {
    await rollout(child, parent, '/root/worker');
    await rollout(grandchild, child, '/root/worker/helper');
    await rollout(unrelated, randomUUID(), '/root/other');
    const result = await readSubagentConversations(parent, home);
    assert.deepEqual(result.map(agent => agent.path), ['/root/worker', '/root/worker/helper']);
    assert.deepEqual(result.map(agent => agent.turns[0].prompt), ['', '']);
    assert.deepEqual(result.map(agent => agent.turns[0].items[0].text), ['/root/worker', '/root/worker/helper']);
  } finally { await rm(home, { recursive: true, force: true }); }
});
