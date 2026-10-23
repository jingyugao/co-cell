import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fixture } from './service.test.js';
import { SecretService } from './service.js';

test('shared debug HOME keeps CLI-owned files across service initialization and authorization', async t => {
  const { repository, service, projectId, tools, toolRoot } = fixture();
  t.after(() => rm(toolRoot, { recursive: true, force: true }));
  await tools.init();
  await service.init();
  const root = await mkdtemp(join(tmpdir(), 'cocell-shared-home-'));
  try {
    await service.mountHomes(root);
    const home = join(root, 'runtime/debug-homes');
    await mkdir(join(home, '.sample'), { recursive: true });
    const path = join(home, '.sample/config');
    await writeFile(path, 'cli-refreshed-native-state', { mode: 0o600 });

    const role = await service.roles.save({ name: 'Sample operators', permissions: [{ tool: 'sample', enabled: true }] });
    await service.roles.assign(projectId, role.id);
    await service.registerRuntime('sample-owner', projectId, 1);
    assert.equal((await service.authorize('sample-owner', 'sample', ['status'])).home, '/home/debug');
    assert.equal(await readFile(path, 'utf8'), 'cli-refreshed-native-state');

    const restarted = new SecretService(repository, tools);
    await restarted.mountHomes(root);
    await restarted.init();
    assert.equal(await readFile(path, 'utf8'), 'cli-refreshed-native-state');
    await repository.roles.assign(projectId, null);
    await assert.rejects(restarted.authorize('sample-owner', 'sample', ['status']), /未授权/);
    assert.equal(await readFile(path, 'utf8'), 'cli-refreshed-native-state', 'revoking access leaves shared HOME state intact');
  } finally { await rm(root, { recursive: true, force: true }); }
});
