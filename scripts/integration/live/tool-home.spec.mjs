import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { test, expect } from '../support/fixtures.mjs';

const exec = promisify(execFile);
const ownedProjectIds = new Set();
const ownedBoxIds = new Set();
let ownedTemporaryHomeFile;
let ownedRoleId;

test.afterEach(async ({ environment: env }) => {
  if (!ownedProjectIds.size && !ownedRoleId && !ownedTemporaryHomeFile) return;
  const errors = [];
  if (ownedTemporaryHomeFile) {
    const context = process.env.COCELL_E2E_KUBE_CONTEXT;
    const namespace = process.env.COCELL_E2E_CELLBOX_NAMESPACE ?? 'cell-box';
    let removed = false;
    if (context) for (const boxId of ownedBoxIds) {
      try {
        const workloads = JSON.parse((await exec('kubectl', ['--context', context, '-n', namespace, 'get', 'cellboxes',
          '-l', `cellbox.local/box-id=${boxId}`, '-o', 'json'], { timeout: 40_000, maxBuffer: 1024 * 1024 })).stdout);
        const pod = workloads.items.find(item => item.status.podName)?.status.podName;
        if (!pod) continue;
        const cleanup = `require('node:fs').rmSync(${JSON.stringify(ownedTemporaryHomeFile)},{force:true})`;
        await exec('kubectl', ['--context', context, '-n', namespace, 'exec', pod, '--', '/usr/local/bin/node', '-e', cleanup],
          { timeout: 40_000, maxBuffer: 1024 * 1024 });
        removed = true;
        break;
      } catch { /* Try another owned Box that may still have a live Pod. */ }
    }
    if (removed) ownedTemporaryHomeFile = undefined;
    else errors.push(new Error('Could not remove the temporary shared-HOME test file from an owned live Box'));
  }
  for (const projectId of ownedProjectIds) {
    try { await env.json(`/api/projects/${projectId}/tool-role`, { method: 'PUT', body: { roleId: null } }); }
    catch (error) { errors.push(error); }
  }
  if (ownedRoleId) {
    try { await env.json(`/api/tool-roles/${ownedRoleId}`, { method: 'DELETE' }); }
    catch (error) { errors.push(error); }
  }
  ownedProjectIds.clear();
  ownedBoxIds.clear();
  ownedTemporaryHomeFile = undefined;
  ownedRoleId = undefined;
  if (errors.length) throw new AggregateError(errors, 'Tool HOME integration cleanup failed');
});

test('native tool HOME: deployed permission UI, revocation, checkpoint continuity and archive restore', async ({ livePage: page, environment: env }) => {
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
  ownedProjectIds.add(created.id);
  const project = await env.waitProject(created.id, { kind: 'create', status: 'ready' });
  ownedBoxIds.add(project.sandbox.id);
  const [definitions, toolCatalog] = await Promise.all([env.json('/api/tool-definitions'), env.json('/api/tools')]);
  const kubeDefinition = definitions.find(tool => tool.name === 'kubectl' && tool.enabled);
  const credential = toolCatalog.find(tool => tool.name === 'kubectl' && tool.kind === 'tool-with-credential');
  const mysqlCredential = toolCatalog.find(tool => tool.name === 'mysql' && tool.kind === 'tool-with-credential');
  assert(kubeDefinition?.credentialPath && credential?.credentials.length, 'Configure a named kubectl tool with native contexts');
  assert(mysqlCredential?.credentials.length, 'Configure a named MySQL tool with native login paths');
  const role = await env.json('/api/tool-roles', { method: 'POST', expectedStatus: 201, body: { name: env.name('native-home-role'), permissions: [
    { tool: 'kubectl', enabled: true, credentials: credential.credentials }, { tool: 'mysql', enabled: true, credentials: mysqlCredential.credentials },
  ] } });
  ownedRoleId = role.id;
  await env.json(`/api/projects/${project.id}/tool-role`, { method: 'PUT', body: { roleId: role.id } });
  let pod;
  const findWorkload = async boxId => {
    const workloads = JSON.parse(await kubectl(['get', 'cellboxes', '-l', `cellbox.local/box-id=${boxId}`, '-o', 'json']));
    assert.equal(workloads.items.length, 1);
    const workload = workloads.items[0];
    assert(workload.spec.debugReadWriteHostPath?.endsWith('/runtime/debug-homes'));
    assert(workload.status.podName);
    return workload;
  };
  const findPod = async boxId => (await findWorkload(boxId)).status.podName;
  const guest = async (targetPod, code) => JSON.parse(await kubectl(['exec', targetPod, '--', '/usr/local/bin/node', '-e', code]));
  const cli = (args, targetPod = pod) => guest(targetPod, `const {spawnSync}=require('node:child_process');const r=spawnSync('/usr/local/bin/cocell',${JSON.stringify(['kubectl', ...args])},{uid:11000,gid:11000,cwd:'/home/agent/workspace',env:{HOME:'/home/agent',PATH:'/usr/local/bin:/usr/bin:/bin'},encoding:'utf8',timeout:25000});console.log(JSON.stringify({status:r.status,stdout:r.stdout,stderr:r.stderr,error:r.error?.message}));`);
  const home = '/home/debug';
  const kubectlPath = kubeDefinition.credentialPath;
  assert(credential.credentials?.length && mysqlCredential.credentials?.length, 'Native context/profile metadata is required');
  const kubeContext = process.env.COCELL_E2E_TOOL_KUBE_CONTEXT ?? credential.credentials[0], mysqlProfile = process.env.COCELL_E2E_TOOL_MYSQL_PROFILE ?? mysqlCredential.credentials[0];
  const fileState = (targetPod = pod) => guest(targetPod, `const fs=require('node:fs'),crypto=require('node:crypto');const p=${JSON.stringify(home + '/' + kubectlPath)};console.log(JSON.stringify(fs.existsSync(p)?{exists:true,sha256:crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')}:{exists:false}));`);
  const fileHash = (targetPod, path) => guest(targetPod, `const fs=require('node:fs'),crypto=require('node:crypto');const p=${JSON.stringify(path)};console.log(JSON.stringify(fs.existsSync(p)?{exists:true,sha256:crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')}:{exists:false}));`);
  const nativeKubectl = (targetPod, args) => guest(targetPod, `const fs=require('node:fs'),{spawnSync}=require('node:child_process');const native=['/opt/cellbox/debug-bin/kubectl','/usr/local/bin/kubectl','/usr/bin/kubectl'].find(path=>fs.existsSync(path));const r=spawnSync(native,${JSON.stringify(args)},{cwd:'/home/agent/workspace',env:{HOME:'/home/debug',KUBECONFIG:${JSON.stringify(ownedTemporaryHomeFile)},PATH:'/usr/local/bin:/usr/bin:/bin'},encoding:'utf8',timeout:25000});console.log(JSON.stringify({status:r.status,stdout:r.stdout,stderr:r.stderr,error:r.error?.message}));`);
  const dialog = page.getByRole('dialog', { name: `${env.name('native-home')} 工具权限`, exact: true });
  const catalog = await env.json('/api/tool-roles');
  const defaultRole = catalog.roles.find(item => item.id === catalog.defaultRoleId);
  assert(defaultRole);
  const group = dialog.getByRole('group', { name: '项目角色', exact: true });
  const openPermissions = async () => {
    await page.goto('/#projects');
    await page.getByRole('article', { name: env.name('native-home'), exact: true }).getByRole('button', { name: '工具权限', exact: true }).click();
    await expect(group.getByRole('radio')).toHaveCount(catalog.roles.length + 1);
  };
  const savePermission = async enabled => {
    await openPermissions();
    await group.getByRole('radio', { name: enabled ? `${role.name}` : `${defaultRole.name} 默认角色`, exact: true }).check();
    const response = page.waitForResponse(response => response.request().method() === 'PUT'
      && new URL(response.url()).pathname === `/api/projects/${project.id}/tool-role`);
    await dialog.getByRole('button', { name: '保存', exact: true }).click();
    assert.equal((await response).status(), 200);
    await expect(dialog).toHaveCount(0);
  };
  await env.step('Enable kubectl through the deployed two-option UI without replacing its Pod', async () => {
    pod = await findPod(project.sandbox.id);
    await savePermission(true);
    assert.equal(await findPod(project.sandbox.id), pod);
    const version = await cli([`--context=${kubeContext}`, 'version', '--client']);
    assert.equal(version.status, 0, version.stderr || version.error);
    assert.match(version.stdout, /Client Version:/);
    const connection = await cli([`--context=${kubeContext}`, 'config', 'current-context']);
    assert.equal(connection.status, 0, connection.stderr || connection.error);
    const pods = await cli([`--context=${kubeContext}`, '-n', 'co-cell', 'get', 'pods', '-o', 'name']);
    assert.equal(pods.status, 0, pods.stderr);
    assert.match(pods.stdout, /^pod\//m);
    assert.equal((await fileState()).exists, true);
    await openPermissions();
    await expect(group.getByRole('radio', { name: role.name, exact: true })).toBeChecked();
    const screenshot = test.info().outputPath('tool-permissions.png');
    await page.screenshot({ path: screenshot });
    await test.info().attach('deployed-tool-permissions', { path: screenshot, contentType: 'image/png' });
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    return { projectId: project.id, sandboxId: project.sandbox.id, pod, mountedHome: home };
  });
  await env.step('Revocation denies one project without changing the HOME shared by another project', async () => {
    const before = await fileState();
    await savePermission(false);
    assert.equal(await findPod(project.sandbox.id), pod);
    const denied = await cli([`--context=${kubeContext}`, 'config', 'current-context']);
    assert.notEqual(denied.status, 0);
    assert.match(denied.stderr, /Tool authorization failed \(HTTP 403\)/);
    assert.deepEqual(await fileState(), before, 'Revoking a project role must not remove or rewrite shared HOME files');

    const secondCreated = await env.json('/api/projects', { method: 'POST', expectedStatus: 201,
      body: { name: env.name('native-home-shared'), type: 1, imageId: image.id, imageVersionId: image.defaultVersionId } });
    ownedProjectIds.add(secondCreated.id);
    const secondProject = await env.waitProject(secondCreated.id, { kind: 'create', status: 'ready' });
    ownedBoxIds.add(secondProject.sandbox.id);
    await env.json(`/api/projects/${secondProject.id}/tool-role`, { method: 'PUT', body: { roleId: role.id } });
    const sharedWorkload = await findWorkload(secondProject.sandbox.id);
    const originalWorkload = await findWorkload(project.sandbox.id);
    assert.equal(sharedWorkload.spec.debugReadWriteHostPath, originalWorkload.spec.debugReadWriteHostPath,
      'Different Boxes must mount the same shared HOME root');
    let secondPod = sharedWorkload.status.podName;
    assert.deepEqual(await fileState(secondPod), before, 'The second project must see the unchanged shared native credential');
    const allowed = await cli([`--context=${kubeContext}`, 'config', 'current-context'], secondPod);
    assert.equal(allowed.status, 0, allowed.stderr || allowed.error);

    const checkpointed = await env.json(`/api/projects/${secondProject.id}/sandbox/checkpoint`, { method: 'POST', expectedStatus: 200, timeoutMs: env.config.operationTimeout });
    assert.equal(checkpointed.sandboxOperation.status, 'succeeded');
    assert.equal(checkpointed.sandbox.status, 'paused');
    await env.waitProject(secondProject.id, { kind: 'checkpoint', status: 'paused' });
    const resumed = await env.json(`/api/projects/${secondProject.id}/sandbox/resume`, { method: 'POST', expectedStatus: 200, timeoutMs: env.config.operationTimeout });
    assert.equal(resumed.sandboxOperation.status, 'succeeded');
    const ready = await env.waitProject(secondProject.id, { kind: 'resume', status: 'ready', operationId: resumed.sandboxOperation.id });
    secondPod = await findPod(ready.sandbox.id);
    ownedBoxIds.add(ready.sandbox.id);
    assert.notEqual(secondPod, sharedWorkload.status.podName, 'Checkpoint resume must recreate the Pod');
    assert.deepEqual(await fileState(secondPod), before, 'Shared HOME credentials must survive checkpoint and Pod recreation');
    const stillAllowed = await cli([`--context=${kubeContext}`, 'config', 'current-context'], secondPod);
    assert.equal(stillAllowed.status, 0, stillAllowed.stderr || stillAllowed.error);
    return { revokedProjectDenied: true, sharedHomeUnchanged: true, secondProjectAllowed: true, recreatedPod: secondPod, credentialPreserved: true };
  });
  await env.step('Isolated CLI state survives pause and resume while the shared kubeconfig stays unchanged', async () => {
    await savePermission(true);
    const before = await fileState();
    assert.equal(before.exists, true);
    ownedTemporaryHomeFile = `${home}/.cocell-e2e-${randomUUID()}.kubeconfig`;
    await guest(pod, `const fs=require('node:fs');const source=${JSON.stringify(home + '/' + kubectlPath)},target=${JSON.stringify(ownedTemporaryHomeFile)};fs.copyFileSync(source,target);fs.chmodSync(target,0o600);console.log(JSON.stringify({copied:true}));`);
    try {
      const changed = await nativeKubectl(pod, ['config', 'set-context', '--current', '--namespace=cocell-home-integration']);
      assert.equal(changed.status, 0, changed.stderr || changed.error);
      const refreshed = await fileHash(pod, ownedTemporaryHomeFile);
      assert.equal(refreshed.exists, true);
      assert.notEqual(refreshed.sha256, before.sha256, 'The isolated CLI config should record the change');
      assert.deepEqual(await fileState(), before, 'The configured shared connection must remain byte-for-byte unchanged');
      const checkpointed = await env.json(`/api/projects/${project.id}/sandbox/checkpoint`, { method: 'POST', expectedStatus: 200, timeoutMs: env.config.operationTimeout });
      assert.equal(checkpointed.sandboxOperation.status, 'succeeded');
      assert.equal(checkpointed.sandbox.status, 'paused');
      await env.waitProject(project.id, { kind: 'checkpoint', status: 'paused' });
      const start = performance.now();
      const resumed = await env.json(`/api/projects/${project.id}/sandbox/resume`, { method: 'POST', expectedStatus: 200, timeoutMs: env.config.operationTimeout });
      assert.equal(resumed.sandboxOperation.status, 'succeeded');
      assert.equal(resumed.sandbox.status, 'ready');
      const ready = await env.waitProject(project.id, { kind: 'resume', status: 'ready', operationId: resumed.sandboxOperation.id });
      const observedReadyMs = performance.now() - start;
      assert.equal(ready.sandbox.id, project.sandbox.id);
      const previousPod = pod; pod = await findPod(project.sandbox.id);
      assert.notEqual(pod, previousPod);
      assert.deepEqual(await fileState(), before, 'Resume must leave the shared connection file unchanged');
      assert.deepEqual(await fileHash(pod, ownedTemporaryHomeFile), refreshed, 'The isolated CLI file must survive Pod recreation');
      const current = await nativeKubectl(pod, ['config', 'current-context']);
      assert.equal(current.status, 0, current.stderr || current.error);
      assert.equal((await cli([`--context=${kubeContext}`, 'config', 'current-context'])).status, 0);
      return { observedReadyMs, pod, sharedKubeconfigPreserved: true, isolatedCliStatePreserved: true, operationId: ready.sandboxOperation.id };
    } finally {
      try {
        await guest(pod, `require('node:fs').rmSync(${JSON.stringify(ownedTemporaryHomeFile)},{force:true});console.log(JSON.stringify({removed:true}));`);
        ownedTemporaryHomeFile = undefined;
      } catch { /* The afterEach hook removes it through another live owned Box if resume failed. */ }
    }
  });
  await env.step('Archive and explicit restore create a new Sandbox with the updated native credentials', async () => {
    const before = await fileState();
    const previousPod = pod;
    const checkpointed = await env.json(`/api/projects/${project.id}/sandbox/checkpoint`, { method: 'POST', expectedStatus: 200, timeoutMs: env.config.operationTimeout });
    assert.equal(checkpointed.sandbox.status, 'paused');
    await env.waitProject(project.id, { kind: 'checkpoint', status: 'paused' });
    const backedUp = await env.json(`/api/projects/${project.id}/backup`, { method: 'POST', expectedStatus: 200,
      timeoutMs: env.config.operationTimeout });
    assert.equal(backedUp.sandboxOperation.kind, 'backup');
    assert.equal(backedUp.sandboxOperation.status, 'succeeded');
    assert.equal(backedUp.sandboxBackup?.status, 'succeeded');
    assert(backedUp.remoteArchives?.length, 'Explicit backup must publish a durable archive before project archival');
    const archived = await env.json(`/api/projects/${project.id}/archive`, { method: 'POST', expectedStatus: 200,
      timeoutMs: env.config.operationTimeout, body: { useExistingBackup: true } });
    assert.equal(archived.status, 'archived');
    assert.equal(archived.sandbox, undefined);
    const restored = await env.json(`/api/projects/${project.id}/sandbox/restore`, { method: 'POST', expectedStatus: 200, timeoutMs: env.config.operationTimeout });
    assert.equal(restored.sandboxOperation.status, 'succeeded');
    assert.equal(restored.sandbox.status, 'ready');
    const ready = await env.waitProject(project.id, { kind: 'restore', status: 'ready' });
    assert.notEqual(ready.sandbox.id, project.sandbox.id, 'Archive restore must create a new runtime resource');
    pod = await findPod(ready.sandbox.id);
    assert.notEqual(pod, previousPod);
    assert.equal((await fileState()).sha256, before.sha256);
    const resources = await cli([`--context=${kubeContext}`,
      '-n', 'co-cell', 'get', 'pods', '-o', 'name']);
    assert.equal(resources.status, 0, resources.stderr);
    assert.match(resources.stdout, /^pod\//m);
    const args = [`--login-path=${mysqlProfile}`, '-e', 'SELECT 1'];
    const mysql = await guest(pod, `const {spawnSync}=require('node:child_process');const r=spawnSync('/usr/local/bin/cocell',${JSON.stringify(['mysql', ...args])},{uid:11000,gid:11000,cwd:'/home/agent/workspace',env:{HOME:'/home/agent',PATH:'/usr/local/bin:/usr/bin:/bin'},encoding:'utf8',timeout:20000});console.log(JSON.stringify({status:r.status,stdout:r.stdout,stderr:r.stderr,error:r.error?.code}));`);
    assert.equal(mysql.status, 0, mysql.stderr || mysql.error);
    assert.equal(mysql.stdout.trim().split('\n').at(-1), '1');
    return { sandboxId: ready.sandbox.id, pod, credentialPreserved: true, kubectl: 'passed', mysql: 'passed' };
  });
});
