import assert from 'node:assert/strict';
import test from 'node:test';
import { Sandbox, SandboxNotFoundError, type SandboxInfo } from 'e2b';
import { deleteDanglingSandbox, pauseDanglingSandbox } from './sandbox-upgrade.js';

const connection = {};
const info = (app = 'codex-web', state: 'running' | 'paused' = 'running') => ({
  sandboxId: 'sandbox-1', templateId: 'template-1', metadata: { app }, state,
  startedAt: new Date(0), endAt: new Date(Date.now() + 60_000), cpuCount: 2, memoryMB: 512, envdVersion: 'test',
}) as SandboxInfo;
const legacyArchive = (sourceProjectId = 'project-1'): import('../../protocol/sandbox-types.js').SandboxDataArchive => ({
  key: 'archive.tar.gz', sizeBytes: 1, sha256: 'a'.repeat(64), createdAt: new Date(0).toISOString(),
  format: 'codex-workspace-v1', workingDirectory: '/home/user/workspace', threadIds: [],
  manifestSha256: 'b'.repeat(64), sourceSandboxId: 'sandbox-1', sourceProjectId,
});

test('an explicit E2B not-found response makes dangling pause and deletion idempotent', async t => {
  const getInfo = t.mock.method(Sandbox, 'getInfo', async () => { throw new SandboxNotFoundError('sandbox no longer exists'); });

  await pauseDanglingSandbox('sandbox-1', connection);
  await deleteDanglingSandbox('sandbox-1', connection);
  assert.equal(getInfo.mock.callCount(), 2);
});

test('ordinary errors containing 404 or not-found text are still reported', async t => {
  let calls = 0;
  t.mock.method(Sandbox, 'getInfo', async () => {
    calls += 1;
    throw new Error(calls === 1 ? 'gateway returned 404' : 'network route not found');
  });

  await assert.rejects(deleteDanglingSandbox('sandbox-1', connection), /gateway returned 404/);
  await assert.rejects(pauseDanglingSandbox('sandbox-1', connection), /network route not found/);
});

test('foreign sandbox metadata blocks pause and deletion before either mutation', async t => {
  let pauses = 0;
  let kills = 0;
  t.mock.method(Sandbox, 'getInfo', async () => info('another-application'));
  t.mock.method(Sandbox, 'pause', async () => { pauses += 1; return true; });
  t.mock.method(Sandbox, 'kill', async () => { kills += 1; return true; });

  await assert.rejects(pauseDanglingSandbox('sandbox-1', connection), { status: 403 });
  await assert.rejects(deleteDanglingSandbox('sandbox-1', connection), { status: 403 });
  assert.equal(pauses, 0);
  assert.equal(kills, 0);
});

test('a matching host-issued archive permits cleanup of a legacy project sandbox', async t => {
  let pauses = 0;
  let kills = 0;
  t.mock.method(Sandbox, 'getInfo', async () => ({ ...info(undefined), metadata: { projectId: 'project-1', recoveredFrom: 'old' } }));
  t.mock.method(Sandbox, 'pause', async () => { pauses += 1; return true; });
  t.mock.method(Sandbox, 'kill', async () => { kills += 1; return true; });

  await pauseDanglingSandbox('sandbox-1', connection, legacyArchive());
  await deleteDanglingSandbox('sandbox-1', connection, legacyArchive());
  assert.equal(pauses, 1);
  assert.equal(kills, 1);
});

test('legacy project metadata is rejected without exact archive provenance', async t => {
  let kills = 0;
  t.mock.method(Sandbox, 'getInfo', async () => ({ ...info(undefined), metadata: { projectId: 'project-1' } }));
  t.mock.method(Sandbox, 'kill', async () => { kills += 1; return true; });

  await assert.rejects(deleteDanglingSandbox('sandbox-1', connection), { status: 403 });
  await assert.rejects(deleteDanglingSandbox('sandbox-1', connection, legacyArchive('another-project')), { status: 403 });
  await assert.rejects(deleteDanglingSandbox('different-sandbox', connection, legacyArchive()), { status: 403 });
  assert.equal(kills, 0);
});

test('an explicit foreign app cannot use matching project provenance', async t => {
  let kills = 0;
  t.mock.method(Sandbox, 'getInfo', async () => ({
    ...info('another-application'), metadata: { app: 'another-application', projectId: 'project-1' },
  }));
  t.mock.method(Sandbox, 'kill', async () => { kills += 1; return true; });

  await assert.rejects(deleteDanglingSandbox('sandbox-1', connection, legacyArchive()), { status: 403 });
  assert.equal(kills, 0);
});

test('not-found responses from the actual pause and kill mutations are idempotent', async t => {
  let pauses = 0;
  let kills = 0;
  t.mock.method(Sandbox, 'getInfo', async () => info());
  t.mock.method(Sandbox, 'pause', async () => {
    pauses += 1;
    throw new SandboxNotFoundError('sandbox disappeared before pause');
  });
  t.mock.method(Sandbox, 'kill', async () => {
    kills += 1;
    throw new SandboxNotFoundError('sandbox disappeared before kill');
  });

  await pauseDanglingSandbox('sandbox-1', connection);
  await deleteDanglingSandbox('sandbox-1', connection);
  assert.equal(pauses, 1);
  assert.equal(kills, 1);
});
