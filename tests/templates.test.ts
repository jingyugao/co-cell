import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, type TestContext } from 'node:test';
import { TemplateManager, templateManifestSchema, type TemplateManagerOptions, type TemplateRunner } from '../server/templates.js';
import { HttpError } from '../server/manager.js';
import type { TemplateManifest } from '../shared/template-types.js';

const fails = (status: number) => (error: unknown) => error instanceof HttpError && error.status === status;
const manifest = JSON.parse(await readFile(new URL('../scripts/e2b/toolchains.json', import.meta.url), 'utf8')) as TemplateManifest;
async function fixture(t: TestContext, extra: Partial<TemplateManagerOptions> = {}) {
  const base = fileURLToPath(new URL('../data/.tests/', import.meta.url));
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, 'templates-'));
  const options = { directory, initialDefault: 'base', legacyDirectory: join(directory, 'legacy'), ...extra };
  const manager = new TemplateManager(options); await manager.init();
  t.after(async () => { await manager.close(); await rm(directory, { recursive: true, force: true }); });
  return { manager, directory, options, template: (await manager.list()).templates[0]! };
}
const successful: TemplateRunner = async ({ script, args, onLog }) => {
  const directory = args[args.indexOf('--output') + 1]!;
  const snapshot = JSON.parse(await readFile(args[args.indexOf('--manifest') + 1]!, 'utf8'));
  const alias = args[args.indexOf('--alias') + 1]!;
  onLog('completed step\n');
  if (script.endsWith('/build-template.mjs')) {
    await writeFile(join(directory, 'template-build.json'), JSON.stringify({ alias, manifest: snapshot, builtAt: new Date().toISOString() }));
  } else {
    await writeFile(join(directory, 'template-verification.json'), JSON.stringify({ template: alias, passed: true, deleted: true, checks: [{ name: 'compile', output: 'ok', exitCode: 0 }] }));
  }
};
async function settled(manager: TemplateManager, id: string) {
  for (let n = 0; n < 200; n++) {
    const job = await manager.job(id);
    if (!['building', 'verifying'].includes(job.status)) return job;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Job did not settle');
}

test('template validation rejects shell payloads, moving versions and invalid defaults', () => {
  for (const change of [
    { systemPackages: ['curl;id'] }, { systemPackages: ['--allow-unauthenticated'] },
    { extraMiseTools: ['node@22.1.0'] }, { extraMiseTools: ['cargo:foo@1.0.0'] },
    { extraMiseTools: ['foo@latest'] }, { go: ['1.25'] }, { go: ['1.25.14', '1.25.14'] },
    { defaults: { ...manifest.defaults, go: '1.0.0' } }, { memoryMB: 513 }, { template: '../escape' },
    { unexpected: 'x' },
  ]) assert.equal(templateManifestSchema.safeParse({ ...manifest, ...change }).success, false, JSON.stringify(change));
  assert.equal(templateManifestSchema.safeParse({ ...manifest, extraMiseTools: ['ruby@3.4.5'] }).success, true);
});

test('PHP configuration is optional for old manifests and requires the supported version and pinned Composer', () => {
  const { php: _php, ...legacy } = manifest;
  const php = { version: '8.0.30' as const, composer: { version: '2.8.12', sha256: 'a'.repeat(64) } };
  const parsedLegacy = templateManifestSchema.parse(legacy);
  assert.deepEqual(parsedLegacy, legacy);
  assert.equal('php' in parsedLegacy, false);
  assert.deepEqual(templateManifestSchema.parse({ ...legacy, php }).php, php);
  for (const invalid of [
    null, {}, { ...php, version: '8.0' }, { ...php, version: '8.0.31' }, { ...php, version: '8.1.0' },
    { ...php, version: '8.0.30;id' }, { ...php, extensions: ['redis'] },
    { version: '8.0.30' }, { ...php, composer: { version: 'latest', sha256: 'a'.repeat(64) } },
    { ...php, composer: { version: '2.8.12', sha256: 'not-a-checksum' } },
    { ...php, composer: { ...php.composer, url: 'https://example.test/unverified.phar' } },
  ]) assert.equal(templateManifestSchema.safeParse({ ...legacy, php: invalid }).success, false, JSON.stringify(invalid));
  for (const extraMiseTools of [['php@8.0.30'], ['php@8.3.0']]) {
    assert.equal(templateManifestSchema.safeParse({ ...legacy, extraMiseTools }).success, false);
    assert.equal(templateManifestSchema.safeParse({ ...legacy, php, extraMiseTools }).success, false);
  }
});

test('adding and removing PHP preserves versioned drafts and immutable build snapshots', async t => {
  const { manager, directory } = await fixture(t, { runner: successful });
  const { php: _php, ...legacy } = manifest;
  const original = await manager.create({ name: 'legacy without PHP', manifest: legacy });
  assert.equal('php' in original.manifest, false);
  const php = { version: '8.0.30' as const, composer: { version: '2.8.12', sha256: 'a'.repeat(64) } };
  const updated = await manager.update(original.id, { name: original.name, manifest: { ...legacy, php }, version: original.version });
  assert.notEqual(updated.version, original.version);
  const job = await manager.build(updated.id, updated.version);
  const result = await settled(manager, job.id);
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(result.manifest.php, php);
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'jobs', job.id, 'manifest.json'), 'utf8')).php, php);
  const removed = await manager.update(updated.id, { name: original.name, manifest: legacy, version: updated.version });
  assert.equal('php' in removed.manifest, false);
  assert.deepEqual((await manager.job(job.id)).manifest.php, php);
});

test('template edits serialize and stale edits/deletes cannot overwrite a newer draft', async t => {
  const { manager, template } = await fixture(t);
  const results = await Promise.allSettled([
    manager.update(template.id, { name: 'one', manifest, version: template.version }),
    manager.update(template.id, { name: 'two', manifest, version: template.version }),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  await assert.rejects(manager.delete(template.id, template.version), fails(409));
  const copy = await manager.create({ name: 'copy', manifest });
  assert.notEqual(copy.id, template.id);
  await manager.delete(copy.id, copy.version);
  assert.equal((await manager.list()).templates.length, 1);
});

test('build locks globally, uses immutable snapshot and activates only after successful verification', async t => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const calls: string[][] = [];
  const { manager, template, directory } = await fixture(t, { runner: async request => {
    calls.push(request.args); await gate; await successful(request);
  } });
  const job = await manager.build(template.id, template.version);
  await assert.rejects(manager.build(template.id, template.version), fails(409));
  await assert.rejects(manager.activate(job.id), fails(409));
  await assert.rejects(manager.delete(template.id, template.version), fails(409));
  await manager.update(template.id, { name: 'changed', manifest: { ...manifest, systemPackages: [...manifest.systemPackages, 'jq'] }, version: template.version });
  release();
  const completed = await settled(manager, job.id);
  assert.equal(completed.status, 'succeeded');
  assert.deepEqual(completed.manifest, manifest);
  assert.equal(completed.reference, `codex-web-${job.id}`);
  assert.equal(calls.length, 2);
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'jobs', job.id, 'manifest.json'), 'utf8')), manifest);
  assert.equal((await manager.list()).defaultTemplate, 'base');
  assert.equal((await manager.activate(job.id)).defaultTemplate, completed.reference);
  const current = (await manager.list()).templates[0]!;
  await assert.rejects(manager.delete(current.id, current.version), fails(409));
});

test('failed verification keeps current default and exposes its report', async t => {
  const { manager, template } = await fixture(t, { runner: async request => {
    await successful(request);
    if (request.script.endsWith('/verify-template.mjs')) {
      const directory = request.args[request.args.indexOf('--output') + 1]!;
      await writeFile(join(directory, 'template-verification.json'), JSON.stringify({ template: 'wrong', passed: false, checks: [{ name: 'compile', exitCode: 1, failed: true }] }));
      throw new Error('verification failed');
    }
  } });
  const job = await manager.build(template.id, template.version);
  const result = await settled(manager, job.id);
  assert.equal(result.status, 'failed'); assert.equal(result.verification?.passed, false);
  await assert.rejects(manager.activate(job.id), fails(409));
  assert.equal((await manager.list()).defaultTemplate, 'base');
});

test('logs redact configured secrets across chunks and bound retained output', async t => {
  const secret = 'private-test-credential';
  const { manager, template } = await fixture(t, { secrets: [secret], runner: async request => {
    request.onLog(secret.slice(0, 10)); request.onLog(secret.slice(10) + '\n');
    request.onLog('x '.repeat(90000) + '\n');
    request.onLog(`Bearer abcdefghijk https://alice:password@example.test/ ${secret}\n`);
    await successful(request);
  } });
  const job = await manager.build(template.id, template.version);
  const completed = await settled(manager, job.id);
  assert.ok(completed.logs.length <= 128 * 1024);
  assert.ok(!completed.logs.includes(secret)); assert.ok(!completed.logs.includes('alice:password'));
  assert.ok(!completed.logs.includes('abcdefghijk')); assert.match(completed.logs, /REDACTED/);
  assert.equal((await manager.list()).builds[0]!.logs, '');
});

test('restart persists default and marks unfinished jobs interrupted', async t => {
  const { manager, directory, options, template } = await fixture(t, { runner: successful });
  const job = await manager.build(template.id, template.version); await settled(manager, job.id); await manager.activate(job.id); await manager.close();
  const statePath = join(directory, 'state.json');
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  state.builds.push({ ...state.builds[0], id: 'unfinished', status: 'building', reference: undefined });
  await writeFile(statePath, JSON.stringify(state));
  const restarted = new TemplateManager(options); await restarted.init(); t.after(() => restarted.close());
  assert.equal((await restarted.list()).defaultTemplate, `codex-web-${job.id}`);
  assert.equal((await restarted.job('unfinished')).status, 'interrupted');
  assert.equal((await restarted.list()).activeBuildId, null);
});

test('shutdown cancels its child and retains interrupted status', async t => {
  const { manager, template } = await fixture(t, { runner: async ({ signal }) => {
    await new Promise<void>((_, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
  } });
  const job = await manager.build(template.id, template.version);
  await manager.close();
  assert.equal((await manager.job(job.id)).status, 'interrupted');
  await assert.rejects(manager.build(template.id, template.version), fails(503));
});

test('legacy import requires matching manifest and successful later verification', async t => {
  const base = fileURLToPath(new URL('../data/.tests/', import.meta.url)); await mkdir(base, { recursive: true });
  const legacy = await mkdtemp(join(base, 'template-legacy-')); t.after(() => rm(legacy, { recursive: true, force: true }));
  await writeFile(join(legacy, 'template-build.json'), JSON.stringify({ alias: manifest.template, manifest, builtAt: '2026-09-01T00:00:00Z' }));
  await writeFile(join(legacy, 'template-verification.json'), JSON.stringify({ template: manifest.template, passed: true, startedAt: '2026-09-01T00:00:01Z', checks: [{ name: 'compile', exitCode: 0 }] }));
  const first = await fixture(t, { legacyDirectory: legacy });
  assert.equal((await first.manager.list()).builds.length, 1);
  await writeFile(join(legacy, 'template-build.json'), JSON.stringify({ alias: manifest.template, manifest: { ...manifest, cpuCount: 4 }, builtAt: '2026-09-01T00:00:00Z' }));
  const second = await fixture(t, { legacyDirectory: legacy });
  assert.equal((await second.manager.list()).builds.length, 0);
});
