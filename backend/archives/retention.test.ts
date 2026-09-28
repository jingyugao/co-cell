import assert from 'node:assert/strict';
import test from 'node:test';
import type { RemoteArchiveRef } from '../../protocol/remote-archive-types.js';
import type { RemoteArchives } from './remote.js';
import { pruneRemoteArchives } from './retention.js';

const ref = (id: string): RemoteArchiveRef => ({ id, createdAt: '2026-09-20T00:00:00.000Z',
  sizeBytes: 1, sha256: 'a'.repeat(64), imageId: `sha256:${'b'.repeat(64)}`,
  sourceSandboxId: 'box-1', threadIds: [] });

test('remote retention keeps latest and removes product refs only after Cellbox deletion', async () => {
  const references = [ref('latest'), ref('second'), ref('third')];
  const calls: string[] = [];
  const remote = { async remove(value: RemoteArchiveRef) { calls.push(`remove:${value.id}`); } } as RemoteArchives;
  assert.equal(await pruneRemoteArchives(references, 2, remote, async id => { calls.push(`forget:${id}`); }), 1);
  assert.deepEqual(calls, ['remove:third', 'forget:third']);
  calls.length = 0;
  remote.remove = async value => { calls.push(`remove:${value.id}`); throw new Error('busy'); };
  await assert.rejects(pruneRemoteArchives(references, 1, remote, async id => { calls.push(`forget:${id}`); }), /busy/);
  assert.deepEqual(calls, ['remove:second']);
});
