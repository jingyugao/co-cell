import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture } from './service.test.js';
import { larkCredential } from './lark-credential.js';
import type { SecretInput, SecretSupportFile } from '../../protocol/secret-types.js';
const config = JSON.stringify({ apps: [{ appId: 'cli_fixture', appSecret: { source: 'keychain', id: 'appsecret:cli_fixture' }, brand: 'feishu', defaultAs: 'user', users: [{ userOpenId: 'ou_fixture', userName: 'Test User' }] }] });
const supports = (): SecretSupportFile[] => [
  { path: '.local/share/lark-cli/master.key', encoding: 'base64', content: Buffer.alloc(32, 1).toString('base64') },
  { path: '.local/share/lark-cli/appsecret_cli_fixture.enc', encoding: 'base64', content: Buffer.alloc(40, 2).toString('base64') },
  { path: '.local/share/lark-cli/cli_fixture_ou_fixture.enc', encoding: 'base64', content: Buffer.alloc(80, 3).toString('base64') },
];
const input = (): SecretInput => ({ name: 'Lark user fixture', tool: 'lark-cli', path: '.lark-cli/config.json', format: 'text', mutable: true, content: config, supportFiles: supports() });

test('converting a native Lark credential to shared HOME preserves all CLI-managed keychain files', async () => {
  const { service, projectId } = fixture(); await service.init();
  const root = await mkdtemp(join(tmpdir(), 'cocell-lark-home-ref-')); await service.mountHomes(root);
  try {
    const secret = await service.create(input());
    const role = await service.roles.save({ name: 'Lark owner', permissions: [{ tool: 'lark-cli', enabled: true }] });
    await service.roles.assign(projectId, role.id); await service.publishHome();
    const home = join(root, 'runtime/debug-homes'), token = join(home, supports()[2].path);
    await writeFile(token, 'refreshed-lark-token');
    await service.update(secret.id, { format: 'home' });
    assert.equal(await readFile(token, 'utf8'), 'refreshed-lark-token');
    for (const file of supports().slice(0, 2)) assert.deepEqual(await readFile(join(home, file.path)), Buffer.from(file.content, 'base64'));
    await service.publishHome(); assert.equal(await readFile(token, 'utf8'), 'refreshed-lark-token');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Lark user import provisions and revokes all native files while preserving token refresh and editable config', async () => {
  const { service, repository, projectId } = fixture(); await service.init();
  const root = await mkdtemp(join(tmpdir(), 'cocell-lark-'));
  await service.mountHomes(root);
  try {
    const secret = await service.create(input());
    assert.equal(secret.requiresTextImport, false);
    assert.equal(secret.supportFilePaths?.length, 3);
    assert.equal((await repository.get(secret.id))?.format, 'lark');
    assert(!(await repository.get(secret.id))!.ciphertext.includes(config));
    const role = await service.roles.save({ name: 'Lark user', permissions: [{ tool: 'lark-cli', enabled: true }] });
    await service.roles.assign(projectId, role.id); await service.publishHome();
    await service.registerRuntime('lark-box', projectId, 1);
    const auth = await service.authorize('lark-box', 'lark-cli', ['whoami', '--as', 'user']);
    assert.equal(auth.home, '/home/debug');
    assert.equal(auth.path, '.lark-cli/config.json');
    const home = join(root, 'runtime/debug-homes');
    assert.equal(await readFile(join(home, auth.path), 'utf8'), config);
    for (const file of supports()) assert.deepEqual(await readFile(join(home, file.path)), Buffer.from(file.content, 'base64'));
    const tokenPath = join(home, supports()[2].path);
    await writeFile(tokenPath, 'native-refreshed-token');
    await service.publishHome();
    assert.equal(await readFile(tokenPath, 'utf8'), 'native-refreshed-token');
    const content = await service.content(secret.id);
    assert.equal(content.content, config);
    assert(!('supportFiles' in content));
    const updated = JSON.stringify({ ...JSON.parse(config), riskControl: true });
    await service.update(secret.id, { content: updated, format: 'text' });
    assert.equal((await service.content(secret.id)).supportFilePaths?.length, 3);
    assert.equal(await readFile(join(home, auth.path), 'utf8'), updated);
    assert.equal(await readFile(tokenPath, 'utf8'), 'native-refreshed-token');
    await service.update(secret.id, { supportFiles: supports() });
    assert.deepEqual(await readFile(tokenPath), Buffer.from(supports()[2].content, 'base64'));
    await assert.rejects(service.update(secret.id, { tool: 'other' }), /Lark/);
    await assert.rejects(service.create({ name: 'Conflicting file', tool: 'other', path: supports()[0].path, format: 'text', mutable: false, content: 'fixture' }), /路径冲突/);
    const companion = await service.create({ name: 'Independent file', tool: 'other', path: '.local/share/lark-cli/custom', format: 'text', mutable: false, content: 'fixture' });
    await service.roles.save({ name: 'Shared tools', permissions: [{ tool: 'lark-cli', enabled: true }, { tool: 'other', enabled: true }] });
    await service.roles.assign(projectId, null);
    for (const path of [auth.path, ...supports().map(file => file.path)]) await readFile(join(home, path));
    await assert.rejects(service.authorize('lark-box', 'lark-cli', ['whoami']), /未授权/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Lark companion import rejects unrelated accounts, bad encoding, missing key files and unrelated tools', () => {
  const check = (files: SecretSupportFile[], tool = 'lark-cli', path = '.lark-cli/config.json') => larkCredential(tool, path, config, files);
  assert.throws(() => check(supports().slice(1)), /Lark/);
  assert.throws(() => check(supports().map((file, index) => index === 2 ? { ...file, path: '.local/share/lark-cli/other_user.enc' } : file)), /Lark/);
  assert.throws(() => check(supports().map((file, index) => index === 0 ? { ...file, content: 'invalid-base64' } : file)), /Lark/);
  assert.throws(() => check(supports(), 'git'), /Lark/);
  assert.throws(() => check(supports(), '../config.json'), /Lark/);
});
