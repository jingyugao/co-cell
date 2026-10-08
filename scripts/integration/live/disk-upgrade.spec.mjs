import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { test } from '../support/fixtures.mjs';

const exec = promisify(execFile);

test('disk image upgrade retains the same HOME and latest files without an archive', async ({ environment: env }) => {
  const fromId = process.env.COCELL_E2E_UPGRADE_FROM_VERSION_ID;
  const toId = process.env.COCELL_E2E_UPGRADE_TO_VERSION_ID;
  test.skip(!fromId || !toId, 'Requires two admitted versions of the same managed image');
  const context = process.env.COCELL_E2E_KUBE_CONTEXT;
  assert(context, 'Requires explicit Kubernetes context for the owned Sandbox');
  const kubectl = async args => (await exec('kubectl', ['--context', context, '-n', process.env.COCELL_E2E_CELLBOX_NAMESPACE ?? 'cell-box', ...args], { timeout: 60_000 })).stdout;
  const images = await env.json('/api/images');
  const image = images.find(image => image.versions.some(version => version.id === fromId));
  const to = image?.versions.find(version => version.id === toId);
  assert.equal(to?.status, 'succeeded');
  assert.notEqual(fromId, toId);
  let project;
  const workload = async () => {
    assert(env.projects.has(project.id), 'Only test-owned resources may be changed');
    return JSON.parse(await kubectl(['get', 'cellbox', `cellbox-${project.sandbox.id}`, '-o', 'json']));
  };
  const run = async code => {
    const w = await workload();
    return JSON.parse(await kubectl(['exec', w.status.podName, '--', '/usr/local/bin/node', '-e', code]));
  };
  const read = `const fs=require('fs');const h=fs.statSync('/home/agent');const p='/home/agent/workspace/disk-upgrade.txt';console.log(JSON.stringify({dev:h.dev,ino:h.ino,data:fs.readFileSync(p,'utf8'),history:fs.readFileSync('/home/agent/.upgrade-history-marker','utf8')}));`;
  await env.step('Create an isolated project with the previous image', async () => {
    const value = await env.json('/api/projects', { method: 'POST', expectedStatus: 201,
      body: { name: env.name('disk-upgrade'), type: 1, imageId: image.id, imageVersionId: fromId } });
    project = await env.waitProject(value.id, { kind: 'create', status: 'ready' });
  });
  const old = await workload();
  const before = await env.step('Write latest workspace and HOME state without a backup', () => run(`{
    const fs=require('fs');fs.writeFileSync('/home/agent/workspace/disk-upgrade.txt','latest disk content');
    fs.writeFileSync('/home/agent/.upgrade-history-marker','HOME survives image upgrade');
  }${read}`));
  await env.step('Upgrade directly on the same disk', async () => {
    await env.json(`/api/projects/${project.id}/sandbox/upgrade`, { method: 'POST', expectedStatus: 202, body: { imageVersionId: toId } });
    project = await env.waitProject(project.id, { kind: 'upgrade', status: 'ready' });
    const current = await workload();
    assert.equal(current.metadata.uid, old.metadata.uid);
    assert.notEqual(current.status.podUID, old.status.podUID);
    assert.equal(current.spec.container.image, to.image);
    assert.equal(project.imageSelection.versionId, toId);
    assert.deepEqual(await run(read), before);
    assert.equal(project.remoteArchives?.length ?? 0, 0);
    return { projectId: project.id, sandboxId: project.sandbox.id, owner: current.metadata.uid, fromId, toId, ...before };
  });
  await env.step('Paused Sandbox can switch back using its current disk and discard the old checkpoint', async () => {
    await env.json(`/api/projects/${project.id}/sandbox/checkpoint`, { method: 'POST', expectedStatus: 202 });
    project = await env.waitProject(project.id, { kind: 'checkpoint', status: 'paused' });
    await env.json(`/api/projects/${project.id}/sandbox/upgrade`, { method: 'POST', expectedStatus: 202, body: { imageVersionId: fromId } });
    project = await env.waitProject(project.id, { kind: 'upgrade', status: 'ready' });
    assert.equal(project.imageSelection.versionId, fromId);
    assert.equal((await workload()).metadata.uid, old.metadata.uid);
    assert.deepEqual(await run(read), before);
    assert.equal((await workload()).status.snapshot ?? '', '');
  });
});
