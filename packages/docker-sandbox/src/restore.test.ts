import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { DockerSandboxClient } from './client.js';

test('CellBox proxy is copied before the managed process starts', async () => {
  const client = new DockerSandboxClient('cellbox:latest', 'docker', 'bridge', undefined, undefined, undefined, [], {}, '/app/backend/cellbox-proxy.mjs', 'process.exit(0)');
  const calls: string[] = [];
  client['call'] = async args => {
    calls.push(args[0]);
    return { stdout: args[0] === 'create' ? 'cellbox-id\n' : '', stderr: '' } as Awaited<ReturnType<typeof client['call']>>;
  };
  client['containerDetails'] = async () => ({ status: 'ready', createdAt: '2026-01-01T00:00:00.000Z', imageIdentity: { reference: 'cellbox:latest', id: 'sha256:test', repoDigests: [] } });

  await client.create('project-id', '/home/user/workspace');

  assert.deepEqual(calls, ['create', 'cp', 'start']);
});

for (const failCopy of [false, true]) {
  test(`archive restoration copies offline and only starts after successful copies (failCopy=${failCopy})`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'hive-restore-test-'));
    const codex = join(root, 'home/user/.codex');
    const workspace = join(root, 'home/user/workspace');
    let stagedCodex = '';
    try {
      await mkdir(codex, { recursive: true });
      await mkdir(workspace, { recursive: true });
      await writeFile(join(codex, 'state.sqlite'), 'database snapshot');
      await writeFile(join(codex, 'queue.sqlite'), 'queue snapshot');
      await writeFile(join(codex, 'queue.sqlite-wal'), 'archived WAL');
      await writeFile(join(codex, 'AGENTS.md'), 'obsolete global rules');
      const archive = join(root, 'backup.tar.gz');
      await promisify(execFile)('tar', ['-czf', archive, '-C', root, 'home']);
      const client = new DockerSandboxClient('test');
      const calls: string[] = [];
      client['call'] = async args => {
        calls.push(args[0]);
        if (args[0] === 'cp') {
          assert.equal(calls[0], 'stop');
          assert.equal(args[1], '-a');
          if (args[3].endsWith('/.codex')) {
            stagedCodex = args[2];
            assert.equal(await readFile(join(stagedCodex, 'state.sqlite'), 'utf8'), 'database snapshot');
            assert.equal(await readFile(join(stagedCodex, 'state.sqlite-wal'), 'utf8'), '');
            assert.equal(await readFile(join(stagedCodex, 'state.sqlite-shm'), 'utf8'), '');
            assert.equal(await readFile(join(stagedCodex, 'queue.sqlite-wal'), 'utf8'), 'archived WAL');
            await assert.rejects(access(join(stagedCodex, 'AGENTS.md')));
            if (failCopy) throw new Error('copy failed');
          }
        }
        return { stdout: '', stderr: '' } as Awaited<ReturnType<typeof client['call']>>;
      };
      if (failCopy) await assert.rejects(client.restoreArchive('sandbox', archive), /copy failed/);
      else await client.restoreArchive('sandbox', archive);
      assert.deepEqual(calls, failCopy ? ['stop', 'cp', 'cp'] : ['stop', 'cp', 'cp', 'start']);
      await assert.rejects(access(stagedCodex));
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}
