import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { test, expect } from '../support/fixtures.mjs';

const exec = promisify(execFile);

test.afterEach(async ({ environment: env }) => {
  for (const id of env.projects.keys()) {
    await env.json(`/api/projects/${id}/tool-permissions`, { method: 'PUT', body: { permissions: [] } });
  }
});

test('native tool HOME: deployed permission UI, immediate revocation and checkpoint continuity', async ({ livePage: page, environment: env }) => {
  test.skip(process.env.COCELL_E2E_TOOL_HOME_TEST !== '1', 'Requires an installation with a mounted HOME image and a configured kubectl credential');
  const context = process.env.COCELL_E2E_KUBE_CONTEXT;
  assert(context, 'This installation test requires its explicit Kubernetes context');
  const namespace = process.env.COCELL_E2E_CELLBOX_NAMESPACE ?? 'cell-box';
  const kubectl = async args => (await exec('kubectl', ['--context', context, '-n', namespace, ...args], { timeout: 40_000, maxBuffer: 1024 * 1024 })).stdout;
  const images = await env.json('/api/images');
  const image = images.find(item => item.name === (process.env.COCELL_E2E_TOOL_HOME_IMAGE ?? 'mybox'));
  assert(image?.defaultVersionId, 'Configure a default version of the native HOME image');
  const created = await env.json('/api/projects', { method: 'POST', expectedStatus: 201,
    body: { name: env.name('native-home'), type: 1, imageId: image.id, imageVersionId: image.defaultVersionId } });
  const project = await env.waitProject(created.id, { kind: 'create', status: 'ready' });
  const credentialId = process.env.COCELL_E2E_TOOL_HOME_SECRET_ID;
  const secrets = await env.json('/api/secrets');
  const candidates = secrets.filter(secret => secret.tool === 'kubectl' && secret.enabled && secret.format === 'text');
  const credential = credentialId ? candidates.find(secret => secret.id === credentialId) : candidates.length === 1 ? candidates[0] : undefined;
  assert(credential?.path, 'Configure one enabled kubectl file, or select the legacy binding explicitly with COCELL_E2E_TOOL_HOME_SECRET_ID');
  if (credentialId) {
    // Installations migrating from multiple legacy credentials already have
    // explicit bindings. Seed only this test's binding; the deployed UI remains
    // the authority for enabling and revoking its access.
    await env.json(`/api/projects/${project.id}/tool-grants`, { method: 'POST',
      body: { tool: 'kubectl', enabled: false, files: [{ secretId: credential.id, path: credential.path }] } });
  }
  let pod;
  const findPod = async () => {
    const workloads = JSON.parse(await kubectl(['get', 'cellboxes', '-l', `cellbox.local/box-id=${project.sandbox.id}`, '-o', 'json']));
    assert.equal(workloads.items.length, 1);
    const workload = workloads.items[0];
    assert(workload.spec.debugReadWriteHostPath?.endsWith('/runtime/debug-homes'));
    assert(workload.status.podName);
    return workload.status.podName;
  };
  const guest = async code => JSON.parse(await kubectl(['exec', pod, '--', '/usr/local/bin/node', '-e', code]));
  const cli = args => guest(`const {spawnSync}=require('node:child_process');const r=spawnSync('/usr/local/bin/kubectl',${JSON.stringify(args)},{uid:11000,gid:11000,cwd:'/home/agent/workspace',env:{HOME:'/home/agent',PATH:'/usr/local/bin:/usr/bin:/bin'},encoding:'utf8',timeout:25000});console.log(JSON.stringify({status:r.status,stdout:r.stdout,stderr:r.stderr,error:r.error?.message}));`);
  const home = `/home/debug/${project.id}`;
  const fileState = () => guest(`const fs=require('node:fs'),crypto=require('node:crypto');const p=${JSON.stringify(home + '/' + credential.path)};console.log(JSON.stringify(fs.existsSync(p)?{exists:true,sha256:crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')}:{exists:false}));`);
  const dialog = page.getByRole('dialog', { name: `${env.name('native-home')} 工具权限`, exact: true });
  const group = dialog.getByRole('group', { name: 'kubectl', exact: true });
  const openPermissions = async () => {
    await page.goto('/#projects');
    await page.getByRole('article', { name: env.name('native-home'), exact: true }).getByRole('button', { name: '工具权限', exact: true }).click();
    await expect(group.getByRole('radio')).toHaveCount(2);
  };
  const savePermission = async enabled => {
    await openPermissions();
    await group.getByRole('radio', { name: enabled ? '有' : '无', exact: true }).check();
    const response = page.waitForResponse(response => response.request().method() === 'PUT'
      && new URL(response.url()).pathname === `/api/projects/${project.id}/tool-permissions`);
    await dialog.getByRole('button', { name: '保存', exact: true }).click();
    assert.equal((await response).status(), 200);
    await expect(dialog).toHaveCount(0);
  };
  await env.step('Enable kubectl through the deployed two-option UI without replacing its Pod', async () => {
    pod = await findPod();
    await savePermission(true);
    assert.equal(await findPod(), pod);
    const connection = await cli(['config', 'current-context']);
    assert.equal(connection.status, 0, connection.stderr || connection.error);
    const pods = await cli(['--context', process.env.COCELL_E2E_TOOL_KUBE_CONTEXT ?? context, '-n', 'co-cell', 'get', 'pods', '-o', 'name']);
    assert.equal(pods.status, 0, pods.stderr);
    assert.match(pods.stdout, /^pod\//m);
    assert.equal((await fileState()).exists, true);
    await openPermissions();
    await expect(group.getByRole('radio', { name: '有', exact: true })).toBeChecked();
    const screenshot = test.info().outputPath('tool-permissions.png');
    await page.screenshot({ path: screenshot });
    await test.info().attach('deployed-tool-permissions', { path: screenshot, contentType: 'image/png' });
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    return { projectId: project.id, sandboxId: project.sandbox.id, pod, mountedHome: home };
  });
  await env.step('Revocation immediately denies the agent CLI and removes its credential file', async () => {
    await savePermission(false);
    assert.equal(await findPod(), pod);
    const denied = await cli(['config', 'current-context']);
    assert.notEqual(denied.status, 0);
    assert.match(denied.stderr, /Tool authorization failed \(HTTP 403\)/);
    assert.equal((await fileState()).exists, false);
    return { podUnchanged: true, denied: true, credentialRemoved: true };
  });
  await env.step('Native CLI updates survive pause and resume without copying the original credential back', async () => {
    await savePermission(true);
    const before = await fileState();
    assert.equal((await cli(['config', 'set-context', '--current', '--namespace=cocell-home-integration'])).status, 0);
    const refreshed = await fileState();
    assert.notEqual(refreshed.sha256, before.sha256);
    await env.json(`/api/projects/${project.id}/sandbox/checkpoint`, { method: 'POST', expectedStatus: 202 });
    await env.waitProject(project.id, { kind: 'checkpoint', status: 'paused' });
    const start = performance.now();
    const opened = await env.json(`/api/projects/${project.id}/open`, { method: 'POST', expectedStatus: 202 });
    const resumed = await env.waitProject(project.id, { kind: 'resume', status: 'ready', operationId: opened.sandboxOperation.id });
    const observedReadyMs = performance.now() - start;
    assert.equal(resumed.sandbox.id, project.sandbox.id);
    const previousPod = pod; pod = await findPod();
    assert.notEqual(pod, previousPod);
    assert.equal((await fileState()).sha256, refreshed.sha256);
    assert.equal((await cli(['config', 'current-context'])).status, 0);
    return { observedReadyMs, pod, nativeCredentialPreserved: true };
  });
});
