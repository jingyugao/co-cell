import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, type TestContext } from 'node:test';
import { createApp } from '../server/app.js';
import { HttpError, SessionManager, type CodexClient } from '../server/manager.js';
import { SharedFiles } from '../server/shared-files.js';
import type { AppConfig } from '../shared/types.js';

const fails = (status: number) => (error: unknown) => error instanceof HttpError && error.status === status;
async function fixture(t: TestContext) {
  const base = fileURLToPath(new URL('../data/.tests/', import.meta.url));
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, 'shared-files-'));
  const root = join(directory, 'managed');
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, root, files: new SharedFiles(root) };
}

test('shared files support nested UTF-8 text CRUD, expose metadata only in listings, and preserve BOMs', async t => {
  const { files, root } = await fixture(t);
  assert.deepEqual(await files.list(), { files: [] });
  const rules = await files.write('AGENTS.md', '规则\n');
  const created = await files.write('docs/指南/入门.txt', '\ufeff你好，世界\n');
  assert.deepEqual(await files.read(created.path), created);
  assert.equal(await readFile(join(root, created.path), 'utf8'), created.content);
  const listing = (await files.list()).files;
  assert.deepEqual(listing.map(file => file.path), ['AGENTS.md', created.path]);
  assert.equal(listing[1]!.size, Buffer.byteLength(created.content));
  assert.equal(listing[1]!.editable, true);
  assert.equal('content' in listing[1]!, false);
  assert.ok(Number.isFinite(Date.parse(listing[1]!.updatedAt)));
  assert.match(created.version, /^[a-f0-9]{64}$/);
  const edited = await files.write(created.path, '新内容\n', created.version);
  assert.notEqual(edited.version, created.version);
  assert.equal((await files.read(created.path)).content, edited.content);
  assert.deepEqual(await files.delete(created.path, edited.version), { ok: true });
  await assert.rejects(files.read(created.path), fails(404));
  await files.delete('AGENTS.md', rules.version);
  assert.deepEqual(await files.list(), { files: [] });
  assert.deepEqual(await readdir(join(root, 'docs/指南')), []);
});

test('stale changes cannot overwrite or delete newer content, including concurrent same-version saves', async t => {
  const { files } = await fixture(t);
  const created = await files.write('docs/conflict.txt', 'initial');
  await assert.rejects(files.write(created.path, 'duplicate'), fails(409));
  const results = await Promise.allSettled([
    files.write(created.path, 'writer one', created.version),
    files.write(created.path, 'writer two', created.version),
  ]);
  const successful = results.filter(result => result.status === 'fulfilled');
  const rejected = results.filter(result => result.status === 'rejected');
  assert.equal(successful.length, 1);
  assert.equal(rejected.length, 1);
  assert.ok(fails(409)(rejected[0]!.reason));
  assert.equal((await files.read(created.path)).content, successful[0]!.value.content);
  await assert.rejects(files.delete(created.path, created.version), fails(409));
  await assert.rejects(files.write(created.path, 'stale', created.version), fails(409));
  assert.equal((await files.read(created.path)).version, successful[0]!.value.version);
  await assert.rejects(files.write('docs/missing.txt', 'edit', created.version), fails(404));
  await assert.rejects(files.delete('docs/missing.txt', created.version), fails(404));
});

test('size limits count UTF-8 bytes and binary documents remain listed and deletable without text reads', async t => {
  const { files, root } = await fixture(t);
  await files.write('docs/boundary.txt', 'x'.repeat(1024 * 1024));
  for (const content of ['x'.repeat(1024 * 1024 + 1), '界'.repeat(350_000), 'text\0binary']) {
    await assert.rejects(files.write('docs/rejected.txt', content), fails(400));
  }
  const binary = [
    ['null.bin', Buffer.from([65, 0, 66])],
    ['invalid-utf8.bin', Buffer.from([0xc3, 0x28])],
    ['large.txt', Buffer.alloc(1024 * 1024 + 1, 65)],
  ] as const;
  for (const [name, content] of binary) await writeFile(join(root, 'docs', name), content);
  const listing = (await files.list()).files;
  assert.equal(listing.find(file => file.path === 'docs/boundary.txt')?.editable, true);
  for (const [name, content] of binary) {
    const file = listing.find(file => file.path === `docs/${name}`)!;
    assert.equal(file.editable, false);
    assert.equal(file.size, content.length);
    await assert.rejects(files.read(file.path), fails(415));
    await files.delete(file.path, file.version);
  }
  assert.deepEqual((await files.list()).files.map(file => file.path), ['docs/boundary.txt']);
});

test('paths and symlinks cannot escape the managed documents or expose sibling data', async t => {
  const { files, root, directory } = await fixture(t);
  await files.write('docs/inside.txt', 'inside');
  await writeFile(join(root, 'secret.txt'), 'private sibling');
  const outside = join(directory, 'outside');
  await mkdir(outside);
  await writeFile(join(outside, 'secret.txt'), 'outside secret');
  await symlink(outside, join(root, 'docs/linked-directory'));
  await symlink(join(outside, 'secret.txt'), join(root, 'docs/linked-file.txt'));
  await symlink(join(outside, 'secret.txt'), join(root, 'AGENTS.md'));
  for (const path of [
    'secret.txt', '/etc/passwd', '../outside/secret.txt', 'docs/../secret.txt',
    'docs//a.txt', 'docs/./a.txt', 'docs/a\\b.txt', 'docs/a\0.txt',
    'docs/a\n.txt', 'docs/.shared-write-private', 'docs/',
    'docs/linked-directory/secret.txt', 'docs/linked-file.txt', 'AGENTS.md',
  ]) {
    await assert.rejects(files.read(path), fails(400), path);
    await assert.rejects(files.write(path, 'overwrite'), fails(400), path);
    await assert.rejects(files.delete(path, '0'.repeat(64)), fails(400), path);
  }
  assert.equal(await readFile(join(outside, 'secret.txt'), 'utf8'), 'outside secret');
  assert.equal(await readFile(join(root, 'secret.txt'), 'utf8'), 'private sibling');
  assert.deepEqual((await files.list()).files.map(file => file.path), ['docs/inside.txt']);
  await assert.rejects(files.read('docs/missing.txt'), fails(404));
});

async function apiFixture(t: TestContext) {
  const storage = await fixture(t);
  const config: AppConfig = {
    defaults: { workingDirectory: storage.directory, model: '', modelReasoningEffort: 'high', sandboxMode: 'read-only', webSearchMode: 'disabled', networkAccessEnabled: false },
    sdkVersion: 'test', auth: 'local-codex', approvalPolicy: 'never',
    capabilities: { interactiveApprovals: false, tokenDeltas: false },
  };
  const client: CodexClient = { startThread() { throw Error('unexpected turn'); }, resumeThread() { throw Error('unexpected turn'); } };
  const manager = new SessionManager(client, join(storage.directory, 'sessions'), config.defaults);
  await manager.init();
  t.after(() => manager.close());
  const app = createApp(manager, config, ['localhost:3001'], undefined, undefined, storage.files);
  const request = (path: string, init: RequestInit = {}) => app.request(`http://localhost:3001${path}`, {
    ...init, headers: { host: 'localhost:3001', ...init.headers },
  });
  const json = (method: string, body: unknown, headers: Record<string, string> = {}) => request('/api/shared-files', {
    method, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
  return { ...storage, request, json };
}

test('shared file API supports versioned CRUD and rejects untrusted hosts and origins before mutation', async t => {
  const { json, request, files } = await apiFixture(t);
  const body = { path: 'AGENTS.md', content: 'shared rules' };
  assert.equal((await json('POST', body, { host: 'attacker.example' })).status, 403);
  assert.equal((await json('POST', body, { origin: 'https://attacker.example' })).status, 403);
  assert.deepEqual(await files.list(), { files: [] });
  const response = await json('POST', body, { origin: 'http://localhost:3001' });
  assert.equal(response.status, 201);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const created = await response.json();
  assert.deepEqual(await (await request('/api/shared-files/content?path=AGENTS.md')).json(), created);
  assert.equal((await json('POST', body)).status, 409);
  const updated = await json('PUT', { ...created, content: 'updated rules' });
  assert.equal(updated.status, 200);
  const current = await updated.json();
  assert.equal((await json('PUT', { ...created, content: 'stale' })).status, 409);
  assert.equal((await json('DELETE', { path: created.path, version: created.version })).status, 409);
  assert.equal((await json('DELETE', { path: current.path, version: current.version })).status, 200);
  assert.equal((await request('/api/shared-files/content?path=AGENTS.md')).status, 404);
  assert.deepEqual(await (await request('/api/shared-files')).json(), { files: [] });
});

test('shared file API validates JSON shapes, paths, versions and byte limits without modifying files', async t => {
  const { json, request, files } = await apiFixture(t);
  for (const [method, body] of [
    ['POST', {}], ['POST', { path: 'docs/a.txt', content: 3 }],
    ['POST', { path: 'docs/a.txt', content: '', version: '0'.repeat(64) }],
    ['POST', { path: 'docs/../secret.txt', content: '' }],
    ['POST', { path: 'docs/a.txt', content: '界'.repeat(350_000) }],
    ['PUT', { path: 'docs/a.txt', content: '' }],
    ['PUT', { path: 'docs/a.txt', content: '', version: 'invalid' }],
    ['DELETE', { path: 'docs/a.txt' }],
    ['DELETE', { path: 'docs/a.txt', version: '0'.repeat(64), extra: true }],
  ] as const) assert.equal((await json(method, body)).status, 400);
  assert.equal((await request('/api/shared-files', { method: 'POST', body: '{', headers: { 'content-type': 'application/json' } })).status, 400);
  assert.equal((await request('/api/shared-files/content')).status, 400);
  assert.equal((await request('/api/shared-files/content?path=docs%2F..%2Fsecret.txt')).status, 400);
  assert.deepEqual(await files.list(), { files: [] });
});
