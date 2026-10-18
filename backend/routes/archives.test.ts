import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Hono } from 'hono';
import type { RemoteArchiveRef } from '../../protocol/remote-archive-types.js';
import type { SessionManager } from '../sessions/manager.js';
import { installArchiveRoutes } from './archives.js';

test('legacy archive routes expose the live archive directory and clean private downloads', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cocell-archive-route-'));
  try {
    await writeFile(join(directory, 'note.txt'), 'note');
    const source = join(directory, 'archive.tar.gz');
    execFileSync('tar', ['-czf', source, '-C', directory, 'note.txt']);
    const bytes = await readFile(source);
    const reference: RemoteArchiveRef = {
      id: 'arc-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', createdAt: '2026-09-20T01:00:00.000Z',
      sizeBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
      imageId: `sha256:${'b'.repeat(64)}`, sourceSandboxId: 'box-1', threadIds: ['thread-1'],
    };
    const calls: string[] = [];
    let downloadedPath: string | undefined;
    const manager = {
      listProjects: () => { throw new Error('archive listing must use the live backup directory'); },
      async listArchiveProjects() { return [{ id: 'project-1', name: 'Project', remoteArchives: [reference] }]; },
      remoteArchives: {
        async inspect(value: RemoteArchiveRef) {
          calls.push(`inspect:${value.id}`);
          const { threadIds: _threadIds, ...metadata } = reference;
          return metadata;
        },
        async download(value: RemoteArchiveRef, path: string) {
          calls.push(`download:${value.id}`);
          downloadedPath = path;
          await writeFile(path, bytes);
        },
      },
    } as unknown as SessionManager;
    const app = new Hono();
    installArchiveRoutes(app, manager);

    assert.equal((await app.request('/api/archives')).status, 200);
    assert.equal((await app.request(`/api/archives/${reference.id}/versions`)).status, 200);
    assert.equal((await app.request('/api/archives/prune', { method: 'POST' })).status, 404);
    const unknown = 'arc-cccccccccccccccccccccccccccccccc';
    assert.equal((await app.request(`/api/archives/${unknown}/versions`)).status, 404);
    assert.equal((await app.request(`/api/archives/${unknown}/files`)).status, 404);
    assert.equal((await app.request(`/api/archives/${reference.id}/files?version=${unknown}`)).status, 404);
    assert.equal(calls.length, 0);

    const files = await app.request(`/api/archives/${reference.id}/files`);
    assert.equal(files.status, 200);
    assert.equal((await files.json()).entries[0].name, 'note.txt');
    assert.deepEqual(calls, [`inspect:${reference.id}`, `download:${reference.id}`]);
    assert.ok(downloadedPath);
    await assert.rejects(stat(downloadedPath!));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('volume backups preserve unknown size and reject file browsing without remote calls', async () => {
  const reference: RemoteArchiveRef = {
    storageType: 'cellbox-volume', id: 'volume:vol-a:backup-a', volumeId: 'vol-a', snapshotId: 'a'.repeat(64),
    ownerKey: 'project:project-1:home', profileId: 'profile-a', mounts: [{ volumeId: 'vol-a', mountPath: '/home/agent' }],
    createdAt: '2026-10-18T01:00:00.000Z', threadIds: ['thread-1'], addedBytes: 27,
  };
  let remoteCalls = 0;
  const manager = {
    async listArchiveProjects() { return [{ id: 'project-1', name: 'Project', remoteArchives: [reference] }]; },
    remoteArchives: {
      async inspect() { remoteCalls++; throw new Error('must not inspect a volume backup for file browsing'); },
      async download() { remoteCalls++; throw new Error('must not download a volume backup'); },
    },
  } as unknown as SessionManager;
  const app = new Hono();
  installArchiveRoutes(app, manager);

  const listing = await app.request('/api/archives');
  const projectArchives = (await listing.json())[0].archives;
  assert.equal(projectArchives[0].size, undefined);
  assert.equal(projectArchives[0].browsable, false);
  assert.equal(projectArchives[0].storageType, 'cellbox-volume');
  assert.equal(projectArchives[0].volumeId, reference.volumeId);
  assert.equal(projectArchives[0].snapshotId, reference.snapshotId);
  assert.equal(projectArchives[0].addedBytes, 27);

  const versions = await app.request(`/api/archives/${reference.id}/versions`);
  const version = (await versions.json())[0];
  assert.equal(version.sizeBytes, undefined);
  assert.equal(version.bytesAdded, 27);
  assert.equal(version.browsable, false);
  assert.equal(version.storageType, 'cellbox-volume');
  assert.equal(version.volumeId, reference.volumeId);
  assert.equal(version.snapshotId, reference.snapshotId);

  for (const path of ['files', 'file']) {
    const response = await app.request(`/api/archives/${reference.id}/${path}`);
    assert.equal(response.status, 422);
    assert.match((await response.json()).error, /暂不支持文件浏览/);
  }
  assert.equal(remoteCalls, 0);
});
