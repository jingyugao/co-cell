import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Session, Turn } from '../../../protocol/types.js';
import { mergeSession } from './useSessionStream.js';

const now = '2026-09-24T00:00:00.000Z';
const turn = (id: string, startedAt: string): Turn => ({ id, prompt: id, images: [], status: 'completed',
  items: [{ id: `${id}-answer`, type: 'agent_message', text: id }], startedAt });
const base: Session = { id: 'session', threadId: 'thread', title: 'task', status: 'completed',
  settings: { executionMode: 'sandbox', workingDirectory: '/workspace', model: 'test', modelReasoningEffort: 'low',
    sandboxMode: 'danger-full-access', webSearchMode: 'disabled', networkAccessEnabled: true },
  startedAt: now, createdAt: now, updatedAt: now, archivedAt: null, turns: [] };

test('paged history remains visible after an SSE state update', () => {
  const older = turn('older', '2026-09-23T00:00:00.000Z');
  const latest = turn('latest', now);
  const loaded = { ...base, turns: [older, latest], historyNextCursor: 'next-old-page' };
  const state = { ...base, turns: [{ ...latest, items: [] }] };
  const merged = mergeSession(loaded, state);
  assert.deepEqual(merged.turns.map(item => item.id), ['older', 'latest']);
  assert.deepEqual(merged.turns[1].items, latest.items);
  assert.equal(merged.historyNextCursor, 'next-old-page');
});

test('an accepted failed turn is not labelled as a failed browser submission', () => {
  const running = { ...turn('native', now), status: 'running' as const, codexAccepted: true };
  const failed = { ...running, status: 'failed' as const };
  const merged = mergeSession({ ...base, turns: [running] }, { ...base, turns: [failed] });
  assert.equal(merged.turns[0].clientFailure, undefined);
});
