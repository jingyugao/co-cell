import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { execFileSync, execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
/** Optional transport only: use the existing service and Secret; create no Pods. */
export async function liveTransport(env) {
  if (env.COCELL_E2E_BASE_URL || !env.COCELL_E2E_KUBE_CONTEXT) return { env: {}, close() {} };
  const context = env.COCELL_E2E_KUBE_CONTEXT;
  const namespace = env.COCELL_E2E_NAMESPACE ?? env.COCELL_NAMESPACE ?? 'co-cell';
  const release = env.COCELL_E2E_HELM_RELEASE ?? env.COCELL_HELM_RELEASE ?? 'co-cell';
  const service = env.COCELL_E2E_SERVICE ?? release;
  const read = async (command, args) => {
    try { return JSON.parse((await exec(command, args, { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 })).stdout); }
    catch { throw new Error(`Cannot read live test configuration using ${command}; context=${context}, namespace=${namespace}`); }
  };
  const values = await read('helm', ['--kube-context', context, '-n', namespace, 'get', 'values', release, '-o', 'json']);
  if (!values.existingSecret || !values.publicUrl) throw new Error('Helm release must define existingSecret and publicUrl');
  const secret = await read('kubectl', ['--context', context, '-n', namespace, 'get', 'secret', values.existingSecret, '-o', 'json']);
  const token = env.COCELL_E2E_ACCESS_TOKEN ?? Buffer.from(secret.data?.COCELL_ACCESS_TOKEN ?? '', 'base64').toString();
  if (!token) throw new Error('The existing CoCell Secret has no operator access token');
  const transport = await forwardService(context, namespace, service, 3001);
  return { env: { COCELL_E2E_BASE_URL: transport.base, COCELL_E2E_PUBLIC_URL: values.publicUrl, COCELL_E2E_ACCESS_TOKEN: token }, close: transport.close };
}

async function forwardService(context, namespace, service, servicePort) {
  const forward = spawn('kubectl', ['--context', context, '-n', namespace, 'port-forward', `service/${service}`, `:${servicePort}`, '--address=127.0.0.1'], { stdio: ['ignore', 'pipe', 'pipe'] });
  forward.stderr.resume();
  const close = async () => {
    if (forward.exitCode !== null) return;
    forward.kill('SIGTERM');
    await new Promise(resolve => {
      const timer = setTimeout(() => { forward.kill('SIGKILL'); resolve(); }, 3000);
      forward.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  };
  try {
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Live test port-forward did not become ready')), 15_000);
      forward.once('error', () => { clearTimeout(timer); reject(new Error('Cannot start kubectl port-forward')); });
      forward.once('exit', () => { clearTimeout(timer); reject(new Error('Live test port-forward exited')); });
      forward.stdout.on('data', data => {
        const match = /Forwarding from 127\.0\.0\.1:(\d+)/.exec(String(data));
        if (match) { clearTimeout(timer); resolve(match[1]); }
      });
    });
    return { base: `http://127.0.0.1:${port}`, close };
  } catch (error) { await close(); throw error; }
}

/** Prepare deterministic workspace fixtures through the real Cellbox file API. */
export async function testWorkspaceWriter(env, projectId) {
  assert(env.projects.has(projectId), 'Fixture writes require a project owned by this test');
  const context = process.env.COCELL_E2E_KUBE_CONTEXT;
  assert(context, 'Workspace fixture requires COCELL_E2E_KUBE_CONTEXT');
  const namespace = process.env.COCELL_E2E_NAMESPACE ?? process.env.COCELL_NAMESPACE ?? 'co-cell';
  const release = process.env.COCELL_E2E_HELM_RELEASE ?? process.env.COCELL_HELM_RELEASE ?? 'co-cell';
  const values = JSON.parse((await exec('helm', ['--kube-context', context, '-n', namespace, 'get', 'values', release, '-o', 'json'], { timeout: 30_000 })).stdout);
  assert(values.cellbox?.clientId, 'Missing Cellbox client namespace');
  const transport = await forwardService(context, process.env.COCELL_E2E_CELLBOX_NAMESPACE ?? 'cell-box', 'cellbox-api', 8090);
  env.transports.push(transport);
  return async (filename, content) => {
    assert(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(filename), 'Fixture must be a plain workspace filename');
    assert(env.projects.has(projectId));
    const project = await env.json(`/api/projects/${projectId}`);
    assert(project.name.startsWith(`${env.prefix} `));
    assert.equal(project.sandbox.status, 'ready');
    const response = await fetch(`${transport.base}/v1/boxes/${encodeURIComponent(project.sandbox.id)}/files?path=${encodeURIComponent(filename)}`, {
      method: 'PUT', headers: { 'X-Cellbox-Client-ID': values.cellbox.clientId, 'Content-Type': 'application/octet-stream' },
      body: content, signal: AbortSignal.any([env.controller.signal, AbortSignal.timeout(30_000)]), redirect: 'error',
    });
    const detail = await response.text();
    assert(response.ok, `Workspace fixture write failed: HTTP ${response.status}; ${env.redact(detail).slice(0, 500)}`);
  };
}

/** Explicitly delete only an unreferenced Cellbox volume owned by one test project. */
export async function testOwnedVolumeCleaner(env, projectId) {
  assert(env.projects.has(projectId), 'Volume cleanup requires a project owned by this test');
  const context = process.env.COCELL_E2E_KUBE_CONTEXT;
  assert(context, 'Volume cleanup requires COCELL_E2E_KUBE_CONTEXT');
  const namespace = process.env.COCELL_E2E_CELLBOX_NAMESPACE ?? 'cell-box';
  const release = process.env.COCELL_E2E_HELM_RELEASE ?? process.env.COCELL_HELM_RELEASE ?? 'co-cell';
  const values = JSON.parse((await exec('helm', ['--kube-context', context, '-n', process.env.COCELL_E2E_NAMESPACE ?? process.env.COCELL_NAMESPACE ?? 'co-cell',
    'get', 'values', release, '-o', 'json'], { timeout: 30_000 })).stdout);
  assert(values.cellbox?.clientId, 'Missing Cellbox client namespace');
  const transport = await forwardService(context, namespace, 'cellbox-api', 8090);
  env.transports.push(transport);
  const request = async (method, path, allowNonJson = false) => {
    const response = await fetch(`${transport.base}${path}`, {
      method, headers: { 'X-Cellbox-Client-ID': values.cellbox.clientId },
      signal: AbortSignal.any([env.controller.signal, AbortSignal.timeout(30_000)]), redirect: 'error',
    });
    const text = await response.text();
    let data;
    try { data = text ? JSON.parse(text) : undefined; }
    catch {
      if (!allowNonJson) throw new Error(`Cellbox ${method} ${path} returned invalid JSON`);
    }
    return { response, data, text };
  };
  const capability = await request('GET', '/v1/volumes', true);
  assert([200, 404].includes(capability.response.status),
    `Cellbox volume capability lookup failed: HTTP ${capability.response.status}`);
  const cleanup = async volumeIds => {
    const project = await env.json(`/api/projects/${projectId}`);
    assert(project.name.startsWith(`${env.prefix} `), 'Project ownership changed; refusing volume cleanup');
    env.report.volumeCleanup ??= [];
    for (const volumeId of [...new Set(volumeIds)]) {
      const record = { projectId, volumeId, status: 'checking' };
      env.report.volumeCleanup.push(record);
      await env.persist();
      const volumeResult = await request('GET', `/v1/volumes/${encodeURIComponent(volumeId)}`);
      if (volumeResult.response.status === 404) { record.status = 'already-absent'; await env.persist(); continue; }
      assert.equal(volumeResult.response.status, 200, `Cellbox volume lookup failed: HTTP ${volumeResult.response.status}`);
      assert.equal(volumeResult.data.ownerKey, `project:${projectId}`, 'Volume is not owned by this test project');

      const boxesResult = await request('GET', '/v1/boxes');
      assert.equal(boxesResult.response.status, 200, `Cellbox Box inventory failed: HTTP ${boxesResult.response.status}`);
      const references = boxesResult.data.filter(box => box.phase !== 'deleted'
        && (box.homeVolumeId === volumeId || (box.mounts ?? []).some(mount => mount.volumeId === volumeId)));
      assert.deepEqual(references, [], 'Refusing to delete a volume still referenced by any Box');

      const deleted = await request('DELETE', `/v1/volumes/${encodeURIComponent(volumeId)}`);
      assert.equal(deleted.response.status, 202, `Cellbox volume delete was not accepted: HTTP ${deleted.response.status}`);
      assert(deleted.data?.id, 'Cellbox volume delete response has no operation ID');
      record.operationId = deleted.data.id; record.status = 'deleting'; await env.persist();
      const deadline = Date.now() + env.config.operationTimeout;
      for (;;) {
        const operation = await request('GET', `/v1/operations/${encodeURIComponent(record.operationId)}`);
        assert.equal(operation.response.status, 200, `Cellbox volume operation lookup failed: HTTP ${operation.response.status}`);
        if (operation.data.status === 'failed') throw new Error(`Cellbox volume deletion failed: ${env.redact(operation.data.error?.message ?? 'unknown error')}`);
        if (operation.data.status === 'unknown') {
          record.status = 'unknown'; await env.persist();
          throw new Error(`Cellbox volume deletion outcome is unknown; operation ${record.operationId} was not replayed`);
        }
        if (operation.data.status === 'succeeded') break;
        assert(Date.now() < deadline, 'Timed out waiting for the single Cellbox volume deletion request');
        await delay(250, undefined, { signal: env.controller.signal });
      }
      const final = await request('GET', `/v1/volumes/${encodeURIComponent(volumeId)}`);
      assert.equal(final.response.status, 200, 'Deleted volume tombstone is missing');
      assert.equal(final.data.phase, 'deleted', 'Volume deletion did not reach the deleted tombstone phase');
      record.status = 'deleted'; await env.persist();
    }
  };
  cleanup.supportsVolumes = capability.response.status === 200;
  return cleanup;
}

/** Fault injection is limited to the existing execution Pod of this test's project. */
export async function failTestSandbox(env, projectId) {
  assert(env.projects.has(projectId), 'Fault injection requires a project owned by this test');
  const context = process.env.COCELL_E2E_KUBE_CONTEXT;
  assert(context, 'Mounted HOME rebuild test requires COCELL_E2E_KUBE_CONTEXT');
  const namespace = process.env.COCELL_E2E_CELLBOX_NAMESPACE ?? 'cell-box';
  const project = await env.json(`/api/projects/${projectId}`);
  assert(project.name.startsWith(`${env.prefix} `));
  assert.equal(project.sandbox.status, 'ready');
  const cli = ['--context', context, '-n', namespace];
  const read = async args => JSON.parse((await exec('kubectl', [...cli, ...args, '-o', 'json'], { timeout: 30_000 })).stdout);
  const box = await read(['get', 'cellboxes.cellbox.local', `cellbox-${project.sandbox.id}`]);
  assert(box.spec.persistentHome, 'Fault injection requires persistent HOME');
  assert.equal(box.status.phase, 'Running');
  const pod = await read(['get', 'pod', box.status.podName]);
  assert.equal(pod.metadata.uid, box.status.podUID);
  assert(pod.metadata.ownerReferences.some(ref => ref.controller && ref.uid === box.metadata.uid));
  const path = `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods/${encodeURIComponent(pod.metadata.name)}`;
  execFileSync('kubectl', ['--context', context, 'delete', '--raw', path, '-f', '-'], {
    input: JSON.stringify({ apiVersion: 'v1', kind: 'DeleteOptions', preconditions: { uid: pod.metadata.uid } }),
    timeout: 30_000, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const deadline = Date.now() + env.config.operationTimeout;
  for (;;) {
    const current = await read(['get', 'cellboxes.cellbox.local', box.metadata.name]);
    assert.equal(current.metadata.uid, box.metadata.uid, 'Fault injection changed HOME ownership');
    if (current.status.phase === 'Failed') break;
    assert(Date.now() < deadline, 'Lost test execution did not reach the failed state');
    await delay(250, undefined, { signal: env.controller.signal });
  }
  return { sandboxId: project.sandbox.id, ownerUID: box.metadata.uid, podUID: pod.metadata.uid };
}
