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

test('archive routes expose only project-owned Cellbox references and clean private downloads', async () => {
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
      listProjects: () => [{ id: 'project-1', name: 'Project', remoteArchives: [reference] }],
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
      async pruneArchivedProjectArchives() { return 0; },
    } as unknown as SessionManager;
    const app = new Hono();
    installArchiveRoutes(app, manager);

    assert.equal((await app.request('/api/archives')).status, 200);
    assert.equal((await app.request(`/api/archives/${reference.id}/versions`)).status, 200);
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
