import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { publishSharedDirectory } from './mount.js';
import { SharedFiles } from './service.js';
import { loadSharedMountConfig } from './config.js';
import { MemoryCoordinator } from '../infra/storage/coordination.js';

test('mounted shared files migrate once, retain edits/deletions and publish readable atomic configuration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cocell-shared-'));
  const legacy = join(root, 'data'), shared = join(root, 'shared');
  const config = { version: 1, appServerArgs: [], env: { CODEX_API_KEY: 'first' } };
  try {
    await mkdir(join(legacy, 'docs'), { recursive: true });
    await writeFile(join(legacy, 'AGENTS.md'), 'instructions');
    await writeFile(join(legacy, 'docs', 'old.txt'), 'document', { mode: 0o600 });
    await writeFile(join(legacy, 'private.json'), 'not shared');
    const mounts = join(root, 'mounts.json');
    await writeFile(mounts, JSON.stringify({ sharedDirectory: { enabled: true, hostPath: '/srv/shared', nodeName: 'test-node' } }));
    assert.equal(await loadSharedMountConfig(mounts), true);
    await writeFile(mounts, JSON.stringify({ sharedDirectory: { enabled: true, hostPath: '/', nodeName: '' } }));
    await assert.rejects(loadSharedMountConfig(mounts), /hostPath and nodeName/);
    await publishSharedDirectory(shared, legacy, config);
    assert.equal(await readFile(join(shared, 'AGENTS.md'), 'utf8'), 'instructions');
    assert.equal(await stat(join(shared, 'private.json')).catch(() => null), null);
    assert.equal((await stat(join(shared, 'docs', 'old.txt'))).mode & 0o777, 0o644);
    const files = new SharedFiles(shared, true);
    const old = await files.read('docs/old.txt');
    await files.delete(old.path, old.version);
    await files.write('docs/nested/new.txt', 'new content');
    assert.equal((await stat(join(shared, 'docs', 'nested', 'new.txt'))).mode & 0o777, 0o644);
    await publishSharedDirectory(shared, legacy, { ...config, env: { CODEX_API_KEY: 'second' } });
    assert.equal(await stat(join(shared, 'docs', 'old.txt')).catch(() => null), null);
    assert.equal((await files.read('docs/nested/new.txt')).content, 'new content');
    assert.equal(JSON.parse(await readFile(join(shared, 'runtime', 'config.json'), 'utf8')).env.CODEX_API_KEY, 'second');
    await assert.rejects(files.read('runtime/config.json'), /路径须为/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('shared file version checks serialize writes across API instances', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cocell-shared-lock-'));
  const coordinator = new MemoryCoordinator();
  try {
    const first = new SharedFiles(root, false, coordinator), second = new SharedFiles(root, false, coordinator);
    const initial = await first.write('docs/guide.md', 'initial');
    const results = await Promise.allSettled([
      first.write('docs/guide.md', 'first writer', initial.version),
      second.write('docs/guide.md', 'second writer', initial.version),
    ]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    const rejected = results.find(result => result.status === 'rejected');
    assert.ok(rejected && rejected.status === 'rejected');
    assert.match(String(rejected.reason), /已被修改/);
    assert.ok(['first writer', 'second writer'].includes((await first.read('docs/guide.md')).content));
  } finally {
    await coordinator.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('Agent profiles migrate effective rules once, publish isolated revisions and reject stale edits', async () => {
  const { AgentProfiles } = await import('./agent-profiles.js');
  const { profileFiles } = await import('./agent-routes.js');
  const root = await mkdtemp(join(tmpdir(), 'cocell-agents-'));
  try {
    const sha = 'a'.repeat(64), assets = join(root,'harness/versions',sha,'assets');
    await mkdir(join(assets,'skills/review'),{recursive:true});
    await writeFile(join(root,'AGENTS.md'),'legacy');
    await writeFile(join(assets,'AGENTS.md'),'bundled');
    await writeFile(join(assets,'skills/review/SKILL.md'),'review');
    await writeFile(join(root,'harness/current'),sha);
    let rejectPublish = false;
    const catalog = new AgentProfiles(root,undefined,async () => { if (rejectPublish) throw Error('OSS unavailable'); });
    await Promise.all([catalog.init(),catalog.init()]);
    const initial = await catalog.get('default'), clone = await catalog.create('研发','',initial.id);
    const files = profileFiles(catalog,clone.id), original = await files.read('AGENTS.md');
    assert.equal(original.content,'bundled');
    const results = await Promise.allSettled(['first','second'].map(content => files.write('AGENTS.md',content,original.version)));
    assert.deepEqual(results.map(r=>r.status).sort(),['fulfilled','rejected']);
    assert.equal(await readFile(join(catalog.assets(initial.revision),'AGENTS.md'),'utf8'),'bundled');
    assert.equal((await catalog.files(initial).read('skills/review/SKILL.md')).content,'review');
    const current = await catalog.get(clone.id);
    rejectPublish = true;
    await assert.rejects(files.write('docs/failure.md','draft'),/OSS unavailable/);
    assert.deepEqual(await catalog.get(clone.id),current);
    const reopened = new AgentProfiles(root);
    await reopened.init();
    assert.equal((await reopened.get('default')).revision,initial.revision);
    assert.equal((await reopened.get(clone.id)).revision,current.revision);
  } finally { await rm(root,{recursive:true,force:true}); }
});

test('project Agent changes invalidate native skill discovery until the running server acknowledges it', async () => {
  const { AgentProfiles } = await import('./agent-profiles.js');
  const { AgentRuntime } = await import('./agent-runtime.js');
  const root = await mkdtemp(join(tmpdir(), 'cocell-agent-pin-'));
  try {
    const profiles = new AgentProfiles(root);
    await profiles.init();
    const other = await profiles.create('Review', '', 'default');
    let agent = 'default';
    let calls = 0;
    const runtime = new AgentRuntime(profiles, async () => agent, '/usr/local/bin/node', async (_box, cwd) => {
      assert.equal(cwd, '/home/agent/workspace');
      if (++calls === 1) throw Error('Codex not ready');
    });
    const handle = { sandboxId: 'box-1', commands: { run: async () => ({ exitCode: 0 }) } } as unknown as Parameters<typeof runtime.apply>[0];
    const apply = (cwd?: string) => runtime.apply(handle, 'project-1', true, false, AbortSignal.timeout(2000), cwd);
    await apply();
    await assert.rejects(apply('/home/agent/workspace'), /Codex not ready/);
    await apply('/home/agent/workspace');
    await apply('/home/agent/workspace');
    assert.equal(calls, 2);
    agent = other.id;
    await apply(); // A Claude session can switch the profile before the next Codex turn.
    await apply('/home/agent/workspace');
    assert.equal(calls, 3);
  } finally { await rm(root, { recursive: true, force: true }); }
});
