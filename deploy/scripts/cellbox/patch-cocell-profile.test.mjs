import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('CoCell profile enables automatic import trust and registers all proxy tools without changing other profiles', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cocell-auto-trust-'));
  try {
    const mounts = join(root, 'mounts.json');
    await writeFile(mounts, JSON.stringify({ sharedDirectory: { enabled: true, hostPath: '/operator/shared', nodeName: 'test-node' } }));
    const peer = { id: 'other', provider: 'docker', image: `registry.example/other@sha256:${'a'.repeat(64)}`, guest: { tools: [] } };
    const values = { api: { manageSecrets: true, config: { clientId: 'cocell', profiles: [
      { id: 'cocell', provider: 'resumable-k8s-pod', nodeName: 'test-node', image: `registry.example/old@sha256:${'a'.repeat(64)}`,
        guest: { tools: [{ id: 'operator-backup', executable: '/operator/backup' }] } }, peer,
    ] } } };
    const image = `registry.example/new@sha256:${'b'.repeat(64)}`;
    const update = input => JSON.parse(execFileSync('uv', ['run', '--no-project', 'python', 'deploy/scripts/cellbox/patch-cocell-profile.py',
      'cocell', image, 'deploy/box-wrap/profile.sample.json'], { input: JSON.stringify(input), encoding: 'utf8',
      env: { ...process.env, COCELL_MOUNTS_CONFIG: mounts, COCELL_DEBUG_READ_ONLY_HOST_PATH: '', COCELL_DEBUG_READ_WRITE_HOST_PATH: '', COCELL_DEBUG_HOME_VERSION: '1' } }));
    const patched = update(values), profile = patched.api.config.profiles[0];
    assert.equal(profile.autoTrustImportedImages, true);
    assert.equal(profile.debugReadWriteHostPath, '/operator/shared/runtime/debug-homes');
    assert.deepEqual(patched.api.config.profiles[1], peer);
    for (const id of ['git', 'glab', 'kubectl', 'mysql', 'meegle', 'lark_cli']) {
      const tool = profile.guest.tools.find(tool => tool.id === 'cocell_' + id);
      assert(tool, `Missing protected entry for ${id}`);
      assert.equal(tool.credentialEnv.COCELL_TOOL_RUNTIME, 'cocell_tool_runtime');
      assert.equal(tool.passThroughArgs, true);
    }
    assert(profile.guest.tools.some(tool => tool.id === 'operator-backup'));
    assert.deepEqual(update({ api: { ...values.api, config: patched.api.config } }), {}, 'An identical profile must not trigger another rollout');
  } finally { await rm(root, { recursive: true, force: true }); }
});
