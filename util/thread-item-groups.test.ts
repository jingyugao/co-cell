import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ThreadItem } from '../protocol/agent-protocol.js';
import { groupThreadItems } from './thread-item-groups.js';

const command = (id: string): ThreadItem => ({ id, type: 'command_execution', command: 'pwd', aggregated_output: '', status: 'completed', exit_code: 0 });
const ids = (items: ThreadItem[], boundaries?: ReadonlySet<number>, mobile = true) =>
  groupThreadItems(items, boundaries, mobile).map(group => ({ type: group.type, startIndex: group.startIndex,
    ids: group.type === 'item' ? [group.item.id] : group.items.map(item => item.id) }));

test('mobile groups consecutive mixed tools while desktop and single tools retain their layout', () => {
  const items: ThreadItem[] = [command('a'), { id: 'b', type: 'web_search', query: 'docs' },
    { id: 'c', type: 'file_change', changes: [], status: 'completed' },
    { id: 'd', type: 'mcp_tool_call', server: 'test', tool: 'read', arguments: {}, status: 'in_progress' }];
  assert.deepEqual(ids(items), [{ type: 'tools', startIndex: 0, ids: ['a', 'b', 'c', 'd'] }]);
  assert.deepEqual(ids(items, undefined, false), items.map((item, index) => ({ type: 'item', startIndex: index, ids: [item.id] })));
  assert.deepEqual(ids([items[0]]), [{ type: 'item', startIndex: 0, ids: ['a'] }]);
});

test('tool groups preserve replies, questions, reasoning, errors and compaction boundaries', () => {
  const separators: ThreadItem[] = [
    { id: 'reply', type: 'agent_message', text: '继续检查' },
    { id: 'question', type: 'agent_message', text: '请回答', delivery: 'async', questions: [{ title: '继续吗？' }] },
    { id: 'reasoning', type: 'reasoning', text: '下一步' },
    { id: 'compaction', type: 'context_compaction', status: 'completed' },
    { id: 'error', type: 'error', message: '失败' },
  ];
  for (const separator of separators) {
    assert.deepEqual(ids([command('a'), command('b'), separator, command('c'), command('d')]), [
      { type: 'tools', startIndex: 0, ids: ['a', 'b'] },
      { type: separator.type === 'reasoning' ? 'reasoning' : 'item', startIndex: 2, ids: [separator.id] },
      { type: 'tools', startIndex: 3, ids: ['c', 'd'] },
    ]);
  }
  assert.deepEqual(ids(['a', 'b', 'c', 'd'].map(command), new Set([2])), [
    { type: 'tools', startIndex: 0, ids: ['a', 'b'] }, { type: 'tools', startIndex: 2, ids: ['c', 'd'] },
  ]);
});
