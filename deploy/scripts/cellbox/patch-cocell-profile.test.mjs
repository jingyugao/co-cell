import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('CoCell profile enables automatic import trust and migrates native tools to one dispatcher', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cocell-auto-trust-'));
  try {
    const mounts = join(root, 'mounts.json');
    await writeFile(mounts, JSON.stringify({ sharedDirectory: { enabled: true, hostPath: '/operator/shared', nodeName: 'test-node' } }));
    const peer = { id: 'other', provider: 'docker', image: `registry.example/other@sha256:${'a'.repeat(64)}`, guest: { tools: [] } };
    const values = { api: { manageSecrets: true, config: { clientId: 'cocell', profiles: [
      { id: 'cocell', provider: 'resumable-k8s-pod', nodeName: 'test-node', image: `registry.example/old@sha256:${'a'.repeat(64)}`,
        guest: { tools: [
          { id: 'operator-backup', executable: '/operator/backup' },
          { id: 'cocell_git', executable: '/opt/cellbox/tools/cocell-proxy', args: ['git', '-'] },
          { id: 'cocell_mysql', executable: '/opt/cellbox/tools/cocell-proxy', args: ['mysql', '-'] },
          { id: 'cocell_tool', executable: '/old/proxy', args: ['old'] },
          { id: 'cocell_archive_backup', executable: '/opt/cellbox/tools/cocell-archive-backup', args: ['legacy'] },
          { id: 'cocell_archive_restore', executable: '/opt/cellbox/tools/cocell-archive-restore', args: ['restore'] },
          { id: 'other-archive-tool', executable: '/operator/archive' },
        ] } }, peer,
    ] } } };
    const image = `registry.example/new@sha256:${'b'.repeat(64)}`;
    const update = input => JSON.parse(execFileSync('uv', ['run', '--no-project', 'python', 'deploy/scripts/cellbox/patch-cocell-profile.py',
      'cocell', image, 'deploy/box-wrap/profile.sample.json'], { input: JSON.stringify(input), encoding: 'utf8',
      env: { ...process.env, COCELL_MOUNTS_CONFIG: mounts, COCELL_DEBUG_READ_ONLY_HOST_PATH: '', COCELL_DEBUG_READ_WRITE_HOST_PATH: '', COCELL_DEBUG_HOME_VERSION: '1' } }));
    const patched = update(values), profile = patched.api.config.profiles[0];
    assert.equal(profile.autoTrustImportedImages, true);
    assert.equal(profile.debugReadWriteHostPath, '/operator/shared/runtime/debug-homes');
    assert.deepEqual(patched.api.config.profiles[1], peer);
    const dispatchers = profile.guest.tools.filter(tool => tool.executable === '/opt/cellbox/tools/cocell-proxy');
    assert.deepEqual(dispatchers.map(tool => tool.id), ['cocell_tool']);
    assert.deepEqual(dispatchers[0].args, ['--dynamic', '-']);
    assert.equal(dispatchers[0].credentialEnv.COCELL_TOOL_RUNTIME, 'cocell_tool_runtime');
    assert.equal(dispatchers[0].passThroughArgs, true);
    assert.equal(dispatchers[0].workspaceRead, true);
    assert.equal(dispatchers[0].workspaceWrite, false);
    assert(profile.guest.tools.some(tool => tool.id === 'operator-backup'));
    assert(profile.guest.tools.some(tool => tool.id === 'cocell_archive_restore'), 'Cellbox archive restore must remain registered');
    assert(profile.guest.tools.some(tool => tool.id === 'other-archive-tool'), 'unrelated tools must remain registered');
    assert.equal(profile.guest.tools.some(tool => tool.id === 'cocell_archive_backup'), false,
      'the removed CoCell backup payload must not remain registered');
    assert.deepEqual(update({ api: { ...values.api, config: patched.api.config } }), {}, 'An identical profile must not trigger another rollout');
  } finally { await rm(root, { recursive: true, force: true }); }
});
