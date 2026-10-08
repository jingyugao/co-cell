import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { test } from '../support/fixtures.mjs';

const exec = promisify(execFile);

test('native archive restore preserves a non-default image and a file larger than 64 MiB', async ({ environment: env }) => {
  const versionId = process.env.COCELL_E2E_ARCHIVE_IMAGE_VERSION_ID;
  test.skip(!versionId, 'Requires an admitted image with a Guest supporting 1 GiB archives');
  const context = process.env.COCELL_E2E_KUBE_CONTEXT;
  assert(context, 'Requires an explicit Kubernetes context for the owned Sandbox');
  const namespace = process.env.COCELL_E2E_CELLBOX_NAMESPACE ?? 'cell-box';
  const kubectl = async args => (await exec('kubectl', ['--context', context, '-n', namespace, ...args], { timeout: 60_000 })).stdout;
  const images = await env.json('/api/images');
  const image = images.find(image => image.versions.some(version => version.id === versionId));
  const version = image?.versions.find(version => version.id === versionId);
  assert.equal(version?.status, 'succeeded');
  assert(image.defaultVersionId && image.defaultVersionId !== versionId, 'Select a non-default version to exercise the regression');
  let project;
  const runInSandbox = async code => {
    assert(env.projects.has(project.id), 'Only the test-owned Sandbox may be modified');
    const workload = JSON.parse(await kubectl(['get', 'cellbox', `cellbox-${project.sandbox.id}`, '-o', 'json']));
    assert.equal(workload.spec.container.image, version.image);
    return JSON.parse(await kubectl(['exec', workload.status.podName, '--', '/usr/local/bin/node', '-e', code]));
  };
  const hashCode = `const fs=require('fs'),crypto=require('crypto');const p='/home/agent/workspace/archive-image-test.bin';
    const h=crypto.createHash('sha256');const s=fs.createReadStream(p);s.on('data',b=>h.update(b));
    s.on('end',()=>console.log(JSON.stringify({size:fs.statSync(p).size,sha256:h.digest('hex')})));`;
  await env.step('Create a project explicitly pinned to the non-default image', async () => {
    const created = await env.json('/api/projects', { method: 'POST', expectedStatus: 201,
      body: { name: env.name('archive-image'), type: 1, imageId: image.id, imageVersionId: versionId } });
    project = await env.waitProject(created.id, { kind: 'create', status: 'ready' });
    assert.equal(project.imageSelection.versionId, versionId);
    return { projectId: project.id, sandboxId: project.sandbox.id, versionId };
  });
  const before = await env.step('Create a 102 MiB file with a nonzero tail', () => runInSandbox(`
    {const fs=require('fs');const p='/home/agent/workspace/archive-image-test.bin';const f=fs.openSync(p,'wx',0o640);
    fs.ftruncateSync(f,102*1024*1024+7);fs.writeSync(f,Buffer.from('archive-tail'),0,12,102*1024*1024-5);
    const owner=fs.statSync('/home/agent/workspace');fs.fchownSync(f,owner.uid,owner.gid);fs.closeSync(f);}${hashCode}`));
  await env.step('Archive through CoCell and restore without choosing another image', async () => {
    await env.json(`/api/projects/${project.id}/archive`, { method: 'POST', expectedStatus: 202, timeoutMs: env.config.operationTimeout });
    await env.json(`/api/projects/${project.id}/sandbox/rebuild`, { method: 'POST', expectedStatus: 202 });
    project = await env.waitProject(project.id, { kind: 'restore', status: 'ready' });
    assert.equal(project.imageSelection.versionId, versionId);
    assert.equal(project.sandbox.image.id, version.image);
    const after = await runInSandbox(hashCode);
    assert.deepEqual(after, before);
    assert.equal((await env.json('/api/images')).find(value => value.id === image.id).defaultVersionId, image.defaultVersionId);
    return { sandboxId: project.sandbox.id, versionId, ...after };
  });
});
