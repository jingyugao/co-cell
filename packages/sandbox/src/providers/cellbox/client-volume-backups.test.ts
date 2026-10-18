import assert from 'node:assert/strict';
import test from 'node:test';
import { CellboxClient, CellboxError } from './client.js';

const backupId = 'a'.repeat(64);
const operation = { id: 'op-a', kind: 'volume-backup', targetId: 'volume-a', status: 'queued', version: 1, createdAt: '2026-10-18T00:00:00Z' };
const backup = { id: backupId, createdAt: '2026-10-18T00:00:00Z', volumeId: 'volume-a', ownerKey: 'project:p1', profileId: 'profile-a', sizeBytes: 1024 };

test('volume backup API methods use Cellbox routes, bodies, and client headers', async () => {
  const calls: Array<{ method: string; path: string; body?: unknown; headers: Headers; signal?: AbortSignal | null }> = [];
  const client = new CellboxClient({ baseUrl: 'http://cellbox.test', clientId: 'tenant-a', fetch: async (input, init) => {
    const url = new URL(String(input));
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ method: init?.method ?? 'GET', path: url.pathname, body, headers: new Headers(init?.headers), signal: init?.signal });
    if (url.pathname === '/v1/backup-policy') return Response.json({ engine: 'restic', scope: 'volume', keepLast: 3, enabled: true });
    if (url.pathname === '/v1/volumes/volume-a/backups' && init?.method === 'GET') return Response.json([backup]);
    if (url.pathname === `/v1/volumes/volume-a/backups/${backupId}`) return Response.json(backup);
    return Response.json(operation, { status: 202 });
  } });

  const abort = new AbortController();
  assert.deepEqual(await client.getBackupPolicy(abort.signal), { engine: 'restic', scope: 'volume', keepLast: 3, enabled: true });
  await client.createVolumeBackup('volume-a');
  assert.deepEqual(await client.listVolumeBackups('volume-a'), [backup]);
  assert.deepEqual(await client.getVolumeBackup('volume-a', backupId), backup);
  await client.restoreVolume({ sourceVolumeId: 'volume-a', backupId, ownerKey: 'project:p1', id: 'volume-b' });

  assert.deepEqual(calls.map(({ method, path, body }) => ({ method, path, body })), [
    { method: 'GET', path: '/v1/backup-policy', body: undefined },
    { method: 'POST', path: '/v1/volumes/volume-a/backups', body: {} },
    { method: 'GET', path: '/v1/volumes/volume-a/backups', body: undefined },
    { method: 'GET', path: `/v1/volumes/volume-a/backups/${backupId}`, body: undefined },
    { method: 'POST', path: '/v1/volumes:restore', body: { sourceVolumeId: 'volume-a', backupId, ownerKey: 'project:p1', id: 'volume-b' } },
  ]);
  for (const call of calls) assert.equal(call.headers.get('X-Cellbox-Client-ID'), 'tenant-a');
  assert.ok(calls[0].signal, 'policy GET forwards the supplied AbortSignal');
  for (const call of calls.filter(({ method }) => method === 'POST')) {
    assert.equal(call.headers.get('Content-Type'), 'application/json');
    assert.equal(call.headers.has('Idempotency-Key'), false);
  }
});

test('BUSY backup is submitted once and surfaced without a retry', async () => {
  let submissions = 0;
  const client = new CellboxClient({ baseUrl: 'http://cellbox.test', fetch: async (_input, init) => {
    submissions++;
    assert.equal(init?.method, 'POST');
    assert.equal(init?.body, '{}');
    assert.equal(new Headers(init?.headers).has('Idempotency-Key'), false);
    return Response.json({ error: { code: 'BUSY', message: 'volume has an active operation' } }, { status: 409 });
  } });
  await assert.rejects(client.createVolumeBackup('volume-a'),
    error => error instanceof CellboxError && error.code === 'BUSY');
  assert.equal(submissions, 1);
});

test('unknown restore outcome is not resubmitted', async () => {
  let submissions = 0;
  const client = new CellboxClient({ baseUrl: 'http://cellbox.test', fetch: async (_input, init) => {
    submissions++;
    assert.equal(init?.method, 'POST');
    assert.equal(new Headers(init?.headers).has('Idempotency-Key'), false);
    throw new Error('connection dropped after submission');
  } });
  await assert.rejects(client.restoreVolume({ sourceVolumeId: 'volume-a', backupId, ownerKey: 'project:p1' }),
    error => error instanceof CellboxError && error.code === 'UNKNOWN_OUTCOME');
  assert.equal(submissions, 1);
});

test('invalid full backup IDs and restore identities fail before network access', async () => {
  let requests = 0;
  const client = new CellboxClient({ baseUrl: 'http://cellbox.test', fetch: async () => {
    requests++;
    return Response.json({});
  } });
  assert.throws(() => client.getVolumeBackup('volume-a', 'a'.repeat(63)),
    error => error instanceof CellboxError && error.code === 'INVALID_REQUEST');
  assert.throws(() => client.getVolumeBackup('volume-a', 'A'.repeat(64)),
    error => error instanceof CellboxError && error.code === 'INVALID_REQUEST');
  assert.throws(() => client.restoreVolume({ sourceVolumeId: 'volume-a', backupId: 'prefix', ownerKey: 'project:p1' }),
    error => error instanceof CellboxError && error.code === 'INVALID_REQUEST');
  assert.throws(() => client.restoreVolume({ sourceVolumeId: 'volume-a', backupId, ownerKey: 'project:p1', id: 'Bad-ID' }),
    error => error instanceof CellboxError && error.code === 'INVALID_REQUEST');
  assert.throws(() => client.restoreVolume({ sourceVolumeId: 'volume-a', backupId, ownerKey: '', id: 'volume-b' }),
    error => error instanceof CellboxError && error.code === 'INVALID_REQUEST');
  assert.throws(() => client.restoreVolume({ sourceVolumeId: 'volume-a', backupId, ownerKey: '界'.repeat(86) }),
    error => error instanceof CellboxError && error.code === 'INVALID_REQUEST');
  assert.throws(() => client.listVolumeBackups('v'.repeat(56)),
    error => error instanceof CellboxError && error.code === 'INVALID_REQUEST');
  assert.equal(requests, 0);
});
