import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture } from './service.test.js';
import { SecretService } from './service.js';

test('HOME references share native tool state, preserve migration and refresh, and enforce project grants', async () => {
  const { repository, projectId, crypto } = fixture();
  const service = new SecretService(repository, crypto, async id => id === projectId); await service.init();
  const root = await mkdtemp(join(tmpdir(), 'cocell-home-ref-'));
  await service.mountHomes(root);
  try {
    const secret = await service.create({ name: 'Tool login', tool: 'custom-cli', path: '.custom/config', format: 'text', content: 'seed', mutable: true });
    const role = await service.roles.save({ name: 'Operators', connections: [{ tool: 'custom-cli', secretId: secret.id }] });
    await service.roles.assign(projectId, role.id); await service.publishHome(projectId);
    const source = join(root, 'runtime/debug-homes', projectId, '.custom/config');
    await writeFile(source, 'native-refresh-state');
    await service.update(secret.id, { format: 'home', homeProjectId: projectId });
    assert.equal((await service.content(secret.id)).content, '');
    assert.equal((await service.content(secret.id)).homeProjectId, projectId);
    assert.equal(await readFile(source, 'utf8'), 'native-refresh-state', 'migration releases seed ownership without overwriting native state');
    const consumer = randomUUID(); await service.roles.assign(consumer, role.id); await service.publishHome(consumer);
    await service.registerRuntime('owner-box', projectId, 1); await service.registerRuntime('consumer-box', consumer, 1);
    const owner = await service.authorize('owner-box', 'custom-cli', ['status']);
    const other = await service.authorize('consumer-box', 'custom-cli', ['status']);
    assert.equal(other.home, owner.home); assert.equal(other.home, `/home/debug/${projectId}`);
    await assert.rejects(readFile(join(root, 'runtime/debug-homes', consumer, '.custom/config')), { code: 'ENOENT' });
    await service.update(secret.id, { name: 'Renamed' });
    const restarted = new SecretService(repository, crypto, async id => id === projectId); await restarted.mountHomes(root); await restarted.init();
    assert.equal(await readFile(source, 'utf8'), 'native-refresh-state');
    await service.roles.assign(consumer, null);
    await assert.rejects(service.authorize('consumer-box', 'custom-cli', ['status']), /未授权/);
    assert.equal((await service.authorize('owner-box', 'custom-cli', ['status'])).home, owner.home);
    const missing = new SecretService(repository, crypto, async () => false); await missing.mountHomes(root);
    await assert.rejects(missing.authorize('owner-box', 'custom-cli', ['status']), /来源项目不可用/);
    await service.update(secret.id, { enabled: false });
    await assert.rejects(service.authorize('owner-box', 'custom-cli', ['status']), /未授权/);
    assert.equal(await readFile(source, 'utf8'), 'native-refresh-state', 'revocation does not delete an operator-managed HOME');
  } finally { await rm(root, { recursive: true, force: true }); }
});
