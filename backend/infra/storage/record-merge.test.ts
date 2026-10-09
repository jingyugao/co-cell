import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HttpError } from '../../../util/errors.js';
import { mergeRecord } from './record-merge.js';

test('three-way merge keeps independent nested fields from concurrent writers', () => {
  const baseline = { title: 'old', settings: { model: 'a', effort: 'low' } };
  const incoming = { ...baseline, title: 'new' };
  const latest = { title: 'old', settings: { model: 'b', effort: 'low' } };
  assert.deepEqual(mergeRecord(baseline, incoming, latest), {
    title: 'new', settings: { model: 'b', effort: 'low' },
  });
});

test('three-way merge rejects conflicting writes to the same field', () => {
  assert.throws(() => mergeRecord({ title: 'old' }, { title: 'mine' }, { title: 'theirs' }), error => {
    assert.ok(error instanceof HttpError);
    assert.equal(error.status, 409);
    return true;
  });
});

test('turn records merge by stable id and retain updates from separate writers', () => {
  const baseline = { turns: [{ id: 'one', status: 'running', userInputRequests: [{ id: 'q', status: 'pending' }] }] };
  const incoming = { turns: [{ id: 'one', status: 'completed', userInputRequests: [{ id: 'q', status: 'pending' }] }] };
  const latest = { turns: [{ id: 'one', status: 'running', userInputRequests: [{ id: 'q', status: 'answered', answers: ['yes'] }] }] };
  assert.deepEqual(mergeRecord(baseline, incoming, latest), {
    turns: [{ id: 'one', status: 'completed', userInputRequests: [{ id: 'q', status: 'answered', answers: ['yes'] }] }],
  });
});

test('ordinary arrays are atomic and conflict when concurrently replaced', () => {
  assert.throws(() => mergeRecord({ labels: ['a'] }, { labels: ['b'] }, { labels: ['c'] }), error =>
    error instanceof HttpError && error.status === 409);
});

test('updatedAt values merge monotonically at every object depth', () => {
  const result = mergeRecord(
    { updatedAt: '2026-01-01T00:00:00.000Z', operation: { updatedAt: '2026-01-01T00:00:00.000Z' } },
    { updatedAt: '2026-01-03T00:00:00.000Z', operation: { updatedAt: '2026-01-03T00:00:00.000Z' } },
    { updatedAt: '2026-01-02T00:00:00.000Z', operation: { updatedAt: '2026-01-04T00:00:00.000Z' } },
  );
  assert.equal(result.updatedAt, '2026-01-03T00:00:00.000Z');
  assert.equal(result.operation.updatedAt, '2026-01-04T00:00:00.000Z');
});

test('concurrent Sandbox activity timestamps merge monotonically, including legacy missing values', () => {
  const result = mergeRecord(
    { sandbox: { id: 'box', lastActiveAt: '2026-01-01T00:00:00.000Z' } },
    { sandbox: { id: 'box', lastActiveAt: '2026-01-03T00:00:00.000Z' } },
    { sandbox: { id: 'box', lastActiveAt: '2026-01-02T00:00:00.000Z' } },
  );
  assert.equal(result.sandbox.lastActiveAt, '2026-01-03T00:00:00.000Z');

  const migrated = mergeRecord(
    { sandbox: { id: 'legacy-box' } },
    { sandbox: { id: 'legacy-box', lastActiveAt: '2026-01-03T00:00:00.000Z' } },
    { sandbox: { id: 'legacy-box', lastActiveAt: '2026-01-02T00:00:00.000Z' } },
  );
  assert.equal(migrated.sandbox.lastActiveAt, '2026-01-03T00:00:00.000Z');
});

test('JSON persistence omits undefined baseline fields without turning their updates into conflicts', () => {
  const previous = { pendingTurns: [{ id: 'turn', codexAccepted: false, nativeTurnId: undefined }],
    sandboxOperation: { id: 'op', status: 'running', error: undefined } };
  const incoming = { pendingTurns: [{ id: 'turn', codexAccepted: true, nativeTurnId: 'native-turn' }],
    sandboxOperation: { id: 'op', status: 'failed', error: 'original executor went offline' } };
  const latest = JSON.parse(JSON.stringify(previous));
  assert.deepEqual(mergeRecord(previous, incoming, latest), incoming);
});

test('JSON object key ordering does not create false conflicts in stored values', () => {
  const previous = { metadata: [{ first: 1, second: 2 }] };
  const incoming = { metadata: [{ first: 3 }] };
  const latest = { metadata: [{ second: 2, first: 1 }] };
  assert.deepEqual(mergeRecord(previous, incoming, latest), incoming);
});
