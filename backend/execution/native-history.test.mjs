import assert from 'node:assert/strict';
import test from 'node:test';
import { parseNativeHistory } from './native-history.mjs';

test('native history keeps the first prompt and images when user input is injected into its turn', () => {
  const records = [
    { type: 'event_msg', timestamp: '2026-10-09T00:00:00.000Z', payload: { type: 'task_started', turn_id: 'turn-one' } },
    { type: 'event_msg', timestamp: '2026-10-09T00:00:01.000Z', payload: { type: 'item_completed', turn_id: 'turn-one', item: {
      type: 'UserMessage', id: 'original', content: [{ type: 'text', text: '原始请求' }, { type: 'local_image', path: '/workspace/image.png' }],
    } } },
    { type: 'event_msg', timestamp: '2026-10-09T00:00:01.000Z', payload: { type: 'user_message', turn_id: 'turn-one', message: '原始请求' } },
    { type: 'event_msg', timestamp: '2026-10-09T00:00:02.000Z', payload: { type: 'item_completed', turn_id: 'turn-one', item: {
      type: 'AgentMessage', id: 'question', delivery: 'async', content: '需要一个偏好', questions: [{ title: '选择？', options: ['A', 'B'] }],
    } } },
    { type: 'event_msg', timestamp: '2026-10-09T00:00:03.000Z', payload: { type: 'user_message', turn_id: 'turn-one', message: '选择 A' } },
    { type: 'event_msg', timestamp: '2026-10-09T00:00:04.000Z', payload: { type: 'task_complete', turn_id: 'turn-one' } },
  ].map(record => JSON.stringify(record)).join('\n') + '\n';

  const [turn] = parseNativeHistory(records);
  assert.equal(turn.prompt, '原始请求\n');
  assert.deepEqual(turn.additionalUserInputs, ['选择 A']);
  assert.deepEqual(turn.images, ['/workspace/image.png']);
});
