import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applySdkEvent, applyTurnEvent } from '../shared/session-events.js';
import type { AgentEvent, RetryState, Session, Turn } from '../shared/types.js';

const waiting: RetryState = {
  attempt: 1, maxRetries: 4, delayMs: 10_000,
  nextRetryAt: '2026-09-07T01:00:10.000Z', status: 'waiting',
};
const usage = { input_tokens: 12, cached_input_tokens: 0, output_tokens: 3, cache_write_input_tokens: 0, reasoning_output_tokens: 0 };
function turn(overrides: Partial<Turn> = {}): Turn {
  return {
    id: 'turn-current', prompt: 'Complete the task', images: [], status: 'running', phase: 'running',
    startedAt: '2026-09-07T01:00:00.000Z',
    items: [{ id: 'reply', type: 'agent_message', text: 'Previous progress' }],
    ...overrides,
  };
}

test('retry progress restores an interrupted attempt while preserving existing turn content', () => {
  const original = turn({ status: 'failed', phase: 'finalizing', error: 'Model is at capacity' });
  const event: AgentEvent = { type: 'runtime.retry', retry: { ...waiting } };
  const next = applyTurnEvent(original, event);
  assert.equal(next.status, 'running');
  assert.equal(next.phase, 'running');
  assert.equal(next.error, undefined);
  assert.equal(next.items, original.items);
  assert.equal(next.prompt, original.prompt);
  assert.deepEqual(next.retry, waiting);
  assert.notEqual(next.retry, event.retry);
  assert.equal(original.status, 'failed');
  assert.equal(original.error, 'Model is at capacity');
  assert.equal(original.retry, undefined);
});

test('retry lifecycle updates waiting and retrying states and clears only the progress when reset', () => {
  const first = applyTurnEvent(turn(), { type: 'runtime.retry', retry: waiting });
  const retrying: RetryState = { ...waiting, status: 'retrying' };
  const second = applyTurnEvent(first, { type: 'runtime.retry', retry: retrying });
  assert.deepEqual(second.retry, retrying);
  assert.equal(first.retry?.status, 'waiting');
  const third = applyTurnEvent(second, { type: 'runtime.retry', retry: { ...waiting, attempt: 2, delayMs: 20_000, nextRetryAt: '2026-09-07T01:00:30.000Z' } });
  assert.equal(third.retry?.attempt, 2);
  assert.equal(third.retry?.delayMs, 20_000);
  const diagnostic = { ...third, error: 'Current diagnostic' };
  const cleared = applyTurnEvent(diagnostic, { type: 'runtime.retry', retry: null });
  assert.equal(cleared.retry, undefined);
  assert.equal(cleared.status, 'running');
  assert.equal(cleared.phase, diagnostic.phase);
  assert.equal(cleared.error, diagnostic.error);
  assert.equal(cleared.items, diagnostic.items);
});

test('starting a turn and terminal SDK events clear stale retry progress', () => {
  const pending = turn({ retry: waiting });
  const started = applyTurnEvent(pending, { type: 'turn.started' });
  assert.equal(started.retry, undefined);
  assert.equal(started.status, 'running');
  assert.equal(started.phase, 'running');
  const completed = applyTurnEvent(pending, { type: 'turn.completed', usage });
  assert.equal(completed.retry, undefined);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.phase, 'finalizing');
  assert.deepEqual(completed.usage, usage);
  const failed = applyTurnEvent(pending, { type: 'turn.failed', error: { message: 'Retry limit reached' } });
  assert.equal(failed.retry, undefined);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.phase, 'finalizing');
  assert.equal(failed.error, 'Retry limit reached');
  assert.deepEqual(pending.retry, waiting, 'Reducers must not mutate their input');
});

test('late retry notifications do not restart completed or cancelled turns', () => {
  for (const status of ['completed', 'cancelled'] as const) {
    const ended = turn({ status, phase: undefined });
    assert.equal(applyTurnEvent(ended, { type: 'runtime.retry', retry: waiting }), ended);
    const stale = { ...ended, retry: waiting };
    const cleared = applyTurnEvent(stale, { type: 'runtime.retry', retry: null });
    assert.equal(cleared.retry, undefined);
    assert.equal(cleared.status, status);
  }
});

test('browser retry events affect only their target turn and preserve session execution state', () => {
  const previous = turn({ id: 'turn-previous', status: 'completed', phase: undefined });
  const current = turn();
  const session: Session = {
    id: 'session-current', threadId: 'sdk-thread', title: 'Demo', status: 'running',
    createdAt: current.startedAt, updatedAt: current.startedAt,
    settings: { workingDirectory: '/workspace', model: '', modelReasoningEffort: 'high', sandboxMode: 'danger-full-access', webSearchMode: 'disabled', networkAccessEnabled: true },
    turns: [previous, current],
  };
  const changed = applySdkEvent(session, current.id, { type: 'runtime.retry', retry: waiting });
  assert.equal(changed.status, 'running');
  assert.equal(changed.threadId, 'sdk-thread');
  assert.equal(changed.turns[0], previous);
  assert.deepEqual(changed.turns[1].retry, waiting);
  assert.equal(session.turns[1].retry, undefined);
  const unknown = applySdkEvent(session, 'missing-turn', { type: 'runtime.retry', retry: waiting });
  assert.deepEqual(unknown, session);
  const completed = applySdkEvent(changed, current.id, { type: 'turn.completed', usage });
  assert.equal(completed.status, 'running', 'The session stays locked until the final server state arrives');
  assert.equal(completed.turns[1].status, 'completed');
  assert.equal(completed.turns[1].retry, undefined);
});
