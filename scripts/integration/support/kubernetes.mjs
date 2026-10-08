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
