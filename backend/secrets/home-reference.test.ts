import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture } from './service.test.js';
import { SecretService } from './service.js';

test('shared HOME references need no source project, preserve CLI state, and enforce tool grants', async () => {
  const { repository, projectId, crypto } = fixture();
  const service = new SecretService(repository, crypto); await service.init();
  const root = await mkdtemp(join(tmpdir(), 'cocell-home-ref-'));
  await service.mountHomes(root);
  try {
    const secret = await service.create({ name: 'Tool login', tool: 'custom-cli', path: '.custom/config', format: 'home', mutable: true });
    const role = await service.roles.save({ name: 'Operators', permissions: [{ tool: 'custom-cli', enabled: true }] });
    await service.roles.assign(projectId, role.id); await service.publishHome();
    const source = join(root, 'runtime/debug-homes', '.custom/config');
    await mkdir(join(root, 'runtime/debug-homes', '.custom'), { recursive: true });
    await writeFile(source, 'native-refresh-state');
    assert.equal((await service.content(secret.id)).content, '');
    assert.equal((await service.content(secret.id)).format, 'home');
    assert.equal(await readFile(source, 'utf8'), 'native-refresh-state', 'publishing preserves CLI-owned shared state');
    const consumer = randomUUID(); await service.roles.assign(consumer, role.id);
    await service.registerRuntime('owner-box', projectId, 1); await service.registerRuntime('consumer-box', consumer, 1);
    const owner = await service.authorize('owner-box', 'custom-cli', ['status']);
    const other = await service.authorize('consumer-box', 'custom-cli', ['status']);
    assert.equal(owner.home, '/home/debug'); assert.equal(other.home, owner.home);
    await service.update(secret.id, { name: 'Renamed' });
    const restarted = new SecretService(repository, crypto); await restarted.mountHomes(root); await restarted.init();
    assert.equal(await readFile(source, 'utf8'), 'native-refresh-state');
    await service.roles.assign(consumer, null);
    await assert.rejects(service.authorize('consumer-box', 'custom-cli', ['status']), /未授权/);
    assert.equal((await service.authorize('owner-box', 'custom-cli', ['status'])).home, owner.home);
    await service.update(secret.id, { enabled: false });
    assert.equal((await service.authorize('owner-box', 'custom-cli', ['status'])).path, undefined,
      'an enabled tool uses native defaults when its optional config registration is disabled');
    assert.equal(await readFile(source, 'utf8'), 'native-refresh-state', 'revocation does not delete an operator-managed HOME');
  } finally { await rm(root, { recursive: true, force: true }); }
});
