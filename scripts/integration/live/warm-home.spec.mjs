import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from '../support/fixtures.mjs';

const exec = promisify(execFile);
const warmLabel = 'cellbox.local/warm-pool';
const warmSpec = 'cellbox.local/warm-spec';

test('persistent HOME restores from a shared warm pool with per-Box isolation', async ({ environment: env }) => {
  test.skip(process.env.COCELL_E2E_WARM_HOME_TEST !== '1', 'Requires a Cellbox installation with persistent HOME warm-pool support');
  const context = process.env.COCELL_E2E_KUBE_CONTEXT;
  assert(context, 'Set COCELL_E2E_KUBE_CONTEXT to inspect the test installation');
  const namespace = process.env.COCELL_E2E_CELLBOX_NAMESPACE ?? 'cell-box';
  const kubectl = async args => (await exec('kubectl', ['--context', context, '-n', namespace, ...args], {
    timeout: 40_000, maxBuffer: 2 * 1024 * 1024,
  })).stdout;
  const readJSON = async args => JSON.parse(await kubectl([...args, '-o', 'json']));
  const runId = randomUUID();
  const statePath = `/home/agent/.cocell-warm-${runId}.json`;
  const markerPath = '/home/agent/.cocell-warm-isolation-marker';
  const cases = [];
  const imageName = process.env.COCELL_E2E_WARM_HOME_IMAGE;
  const images = await env.json('/api/images');
  const defaults = images.flatMap(image => image.versions.filter(version => version.isDefault).map(version => ({ image, version })));
  assert.equal(defaults.length, 1, 'Configure exactly one global default image');
  const { image, version } = defaults[0];
  assert(version.status === 'succeeded' && version.projectReady !== false && !version.deprecatedAt && !version.cleanup, 'Global default must be ready');
  if (imageName) assert.equal(image.name, imageName, 'Warm HOME tests must use the global default image');
  const selection = { imageId: image.id, imageVersionId: version.id, image: version.image ?? version.source };

  const inspectBox = async (project, { active = true } = {}) => {
    const box = await readJSON(['get', 'cellboxes.cellbox.local', `cellbox-${project.sandbox.id}`]);
    assert(box.spec.persistentHome, `Box ${project.sandbox.id} must use persistent HOME`);
    if (selection) assert.equal(box.spec.container.image, selection.image, 'Box did not use the selected image');
    assert(box.status.specHash, `Box ${project.sandbox.id} has no finalized template hash`);
    if (!active) return { box };
    assert(box.status.podName && box.status.podUID, `Box ${project.sandbox.id} has no active Pod identity`);
    const pod = await readJSON(['get', 'pod', box.status.podName]);
    assert.equal(pod.metadata.uid, box.status.podUID, 'Cellbox status points at a different Pod UID');
    assert.equal(pod.spec.containers.length, 1, 'The integration fixture expects one business container');
    return { box, pod };
  };

  const eligibleCandidates = async box => {
    const configured = await readJSON(['get', 'configmap', 'cellbox-warm-default']);
    const targets = Object.values(configured.data ?? {}).map(value => JSON.parse(value));
    assert(targets.some(target => target.nodeName === box.spec.nodeName && target.image === selection.image), 'Warm target differs from the global default');
    const pods = await readJSON(['get', 'pods', '-l', `${warmLabel}=true`]);
    for (const pod of pods.items) {
      if (pod.spec.nodeSelector?.['kubernetes.io/hostname'] !== box.spec.nodeName || pod.metadata.deletionTimestamp || pod.metadata.ownerReferences?.some(ref => ref.controller)) continue;
      assert.equal(pod.spec.containers[0].image, selection.image, 'A nondefault image occupies the unclaimed warm pool');
    }
    const now = Date.now();
    return pods.items.filter(pod => {
      const ageMs = now - Date.parse(pod.metadata.creationTimestamp);
      return pod.metadata.labels?.[warmLabel] === 'true'
        && pod.metadata.annotations?.[warmSpec] === box.status.specHash
        && pod.spec.nodeSelector?.['kubernetes.io/hostname'] === box.spec.nodeName
        && pod.spec.nodeName === box.spec.nodeName
        && !pod.metadata.deletionTimestamp
        && !pod.metadata.ownerReferences?.some(ref => ref.controller)
        && !pod.metadata.labels?.['cellbox.local/owner']
        && !(pod.spec.schedulingGates?.length)
        // Warm leases have a short lifetime. Recent, still-unowned, ungated
        // matching Pods are the Kubernetes-visible candidates for acquisition.
        && ageMs >= 2_000 && ageMs < 50_000;
    });
  };

  const waitForCandidates = async (box, minimum) => {
    const deadline = Date.now() + Math.min(env.config.operationTimeout, 55_000);
    let candidates = [];
    while (Date.now() < deadline) {
      candidates = await eligibleCandidates(box);
      if (candidates.length >= minimum) return candidates;
      await delay(500, undefined, { signal: env.controller.signal });
    }
    assert(candidates.length >= minimum,
      `Expected ${minimum} recent, ungated, unowned warm Pod candidate(s) for template ${box.status.specHash}; found ${candidates.length}`);
  };

  const guestJSON = async (podName, code) => JSON.parse(await kubectl([
    // kubectl exec inherits the base image's HOME, while CoCell tools select
    // the mounted agent HOME. Match that tool environment for these probes.
    'exec', podName, '--', '/usr/bin/env', 'HOME=/home/agent', '/usr/local/bin/node', '-e', code,
  ]));

  const startWorker = async (podName, marker) => {
    const worker = `const fs=require('node:fs'),crypto=require('node:crypto');const fd=fs.openSync(${JSON.stringify(statePath)},'a');const state={pid:process.pid,count:0,marker:${JSON.stringify(marker)},memoryToken:crypto.randomUUID()};const write=()=>{state.count++;fs.writeSync(fd,JSON.stringify(state)+'\\n');fs.fsyncSync(fd)};write();setInterval(write,150);`;
    const launcher = `const {spawn}=require('node:child_process');const c=spawn('/usr/local/bin/node',['-e',${JSON.stringify(worker)}],{detached:true,stdio:'ignore'});c.unref();process.stdout.write(JSON.stringify({pid:c.pid,uid:process.getuid(),home:process.env.HOME}));`;
    // gVisor intentionally kills runtime-exec descendants during restore.
    // Start via the same init-owned guest supervisor used by CoCell commands.
    const request = JSON.stringify({ argv: ['/usr/local/bin/node', '-e', launcher], timeoutMs: 10_000 });
    const executed = await guestJSON(podName,
      `fetch('http://127.0.0.1:40000/v1/exec',{method:'POST',headers:{'Content-Type':'application/json'},body:${JSON.stringify(request)},signal:AbortSignal.timeout(15000)}).then(async r=>{if(!r.ok)throw new Error(await r.text());console.log(JSON.stringify(await r.json()))}).catch(e=>{console.error(e);process.exitCode=1});`);
    assert.equal(executed.exitCode, 0, executed.stderr);
    const started = JSON.parse(executed.stdout);
    assert.equal(started.home, '/home/agent');
    return started.pid;
  };

  const workerState = async podName => guestJSON(podName,
    `const fs=require('node:fs');const p=${JSON.stringify(statePath)};let text;try{text=fs.readFileSync(p,'utf8')}catch(e){if(e.code==='ENOENT'){console.log(JSON.stringify({ready:false,reason:'state file not created'}));process.exit(0)}throw e}const rows=text.split('\\n');let s;for(let i=rows.length-1;i>=0&&!s;i--){try{s=JSON.parse(rows[i])}catch{}}if(!s){console.log(JSON.stringify({ready:false,reason:'no complete state record'}));process.exit(0)}let alive=false;try{alive=!/^State:\\s+Z/m.test(fs.readFileSync('/proc/'+s.pid+'/status','utf8'))}catch{}console.log(JSON.stringify({...s,ready:true,alive,uid:process.getuid(),markerFile:fs.readFileSync(${JSON.stringify(markerPath)},'utf8')}));`);

  const waitForWorkerState = async (podName, predicate, description, timeoutMs = 10_000) => {
    const deadline = Date.now() + timeoutMs;
    let current;
    while (Date.now() < deadline) {
      current = await workerState(podName);
      if (current.ready && predicate(current)) return current;
      await delay(150, undefined, { signal: env.controller.signal });
    }
    assert(current?.ready && predicate(current),
      `Timed out waiting for ${description}; last worker state: ${JSON.stringify(current)}`);
    return current;
  };

  const waitForWorkerAdvance = async (podName, before, marker) => {
    return waitForWorkerState(podName, current => current.count > before && current.marker === marker,
      'restored process to advance its open HOME file', 15_000);
  };

  await env.step('Create two same-template projects with independent persistent HOME directories', async () => {
    for (const index of [0, 1]) {
      const created = selection
        ? await env.json('/api/projects', { method: 'POST', expectedStatus: 201,
          body: { name: env.name(`warm-home-${index}`), type: 1,
            imageId: selection.imageId, imageVersionId: selection.imageVersionId } })
        : await env.createProject(`warm-home-${index}`);
      const ready = await env.waitProject(created.id, { kind: 'create', status: 'ready', operationId: created.sandboxOperation.id });
      cases.push({ project: ready, marker: `home-${index}-${runId}` });
    }
    const inspected = await Promise.all(cases.map(({ project }) => inspectBox(project)));
    assert.equal(inspected[0].box.status.specHash, inspected[1].box.status.specHash,
      'Projects must have identical templates to share the warm pool');
    return inspected.map(({ box }) => ({ boxUID: box.metadata.uid, specHash: box.status.specHash, podName: box.status.podName }));
  });

  await env.step('Start a checkpointed process and unique HOME marker in each Box', async () => {
    const before = await Promise.all(cases.map(async ({ project, marker }) => {
      const { box, pod } = await inspectBox(project);
      await guestJSON(pod.metadata.name,
        `require('node:fs').writeFileSync(${JSON.stringify(markerPath)},${JSON.stringify(marker)},{mode:0o600});console.log(JSON.stringify({uid:process.getuid(),home:process.env.HOME}));`)
        .then(result => { assert.equal(result.uid, 0); assert.equal(result.home, '/home/agent'); });
      const pid = await startWorker(pod.metadata.name, marker);
      const state = await waitForWorkerState(pod.metadata.name,
        current => current.pid === pid && current.marker === marker, 'detached HOME worker to initialize');
      assert.equal(state.pid, pid);
      assert.equal(state.marker, marker);
      const evidence = { boxUID: box.metadata.uid, podName: pod.metadata.name, pid, count: state.count, marker, memoryToken: state.memoryToken };
      cases.find(item => item.project.id === project.id).before = evidence;
      return evidence;
    }));
    return before;
  });

  await env.step('Checkpoint both Boxes and wait for paused state', async () => {
    for (const { project } of cases) {
      const checkpointed = await env.json(`/api/projects/${project.id}/sandbox/checkpoint`, { method: 'POST', expectedStatus: 200, timeoutMs: env.config.operationTimeout });
      assert.equal(checkpointed.sandboxOperation.status, 'succeeded');
      assert.equal(checkpointed.sandbox.status, 'paused');
      await env.waitProject(project.id, { kind: 'checkpoint', status: 'paused' });
    }
    return { paused: cases.map(({ project }) => project.sandbox.id) };
  });

  for (const [index, testCase] of cases.entries()) {
    await env.step(`Resume Box ${index} from a matching warm pool Pod and verify HOME process continuity`, async () => {
      const before = await inspectBox(testCase.project, { active: false });
      assert.equal(before.box.status.phase, 'Suspended');
      const candidates = await waitForCandidates(before.box, 1);
      const candidateIdentities = candidates.map(pod => ({ name: pod.metadata.name, uid: pod.metadata.uid }));
      const opened = await env.json(`/api/projects/${testCase.project.id}/open`, { method: 'POST', expectedStatus: 200, timeoutMs: env.config.operationTimeout });
      assert.equal(opened.sandboxOperation.kind, 'resume');
      assert.equal(opened.sandboxOperation.status, 'succeeded');
      assert.equal(opened.sandbox.status, 'ready');
      const resumed = await env.waitProject(testCase.project.id, {
        kind: 'resume', status: 'ready', operationId: opened.sandboxOperation.id,
      });
      assert.equal(resumed.sandbox.id, testCase.project.sandbox.id);
      const after = await inspectBox(resumed);
      assert(candidateIdentities.some(candidate => candidate.uid === after.pod.metadata.uid),
        `Restore used ${after.pod.metadata.name}/${after.pod.metadata.uid}; captured eligible candidates were ${candidateIdentities.map(candidate => `${candidate.name}/${candidate.uid}`).join(', ')}`);
      assert.equal(after.pod.metadata.labels?.[warmLabel], 'true', 'Restored Pod lost its warm-pool label');
      assert(after.pod.metadata.ownerReferences?.some(ref => ref.controller && ref.uid === after.box.metadata.uid),
        'Claimed warm Pod is not owned by the restored Box');
      assert(!after.pod.spec.containers[0].volumeMounts?.some(mount => mount.mountPath === '/home/agent'),
        'A newly restored warm Pod must receive HOME through the runtime adapter, not a Pod volume');
      const peerCase = cases.find(item => item.project.id !== testCase.project.id);
      const peer = await inspectBox(peerCase.project, { active: false });
      const currentState = await workerState(after.pod.metadata.name);
      assert(currentState.ready, 'Restored process has not written a complete HOME state record');
      assert.equal(currentState.pid, testCase.before.pid, 'Checkpointed process PID changed immediately after restore');
      assert.equal(currentState.memoryToken, testCase.before.memoryToken, 'Checkpointed process memory token changed after restore');
      const minimumCount = Math.max(testCase.before.count, currentState.count);
      const state = await waitForWorkerAdvance(after.pod.metadata.name, minimumCount, testCase.marker);
      assert.equal(state.pid, testCase.before.pid, 'Checkpointed process did not retain its PID');
      assert.equal(state.memoryToken, testCase.before.memoryToken, 'Checkpointed process memory token changed while continuing');
      assert(state.alive, 'Restored process is not alive');
      assert.equal(state.uid, 0, 'Peer HOME isolation check did not run as root');
      assert.equal(state.markerFile, testCase.marker, 'Restored Box can see another Box HOME marker');
      const peerPath = `/var/lib/cellbox/homes/${peer.box.metadata.uid}/data/.cocell-warm-isolation-marker`;
      const peerAccess = await guestJSON(after.pod.metadata.name,
        `const fs=require('node:fs');let readable=false;try{fs.readFileSync(${JSON.stringify(peerPath)});readable=true}catch{}console.log(JSON.stringify({uid:process.getuid(),readable}));`);
      assert.equal(peerAccess.uid, 0, 'Peer path probe must run as container root');
      assert.equal(peerAccess.readable, false, 'Container root can read the sibling Box HOME through its node-local path');
      return { projectId: testCase.project.id, boxUID: after.box.metadata.uid, pod: after.pod.metadata.name,
        usedCapturedWarmCandidate: true, warmCandidateUID: after.pod.metadata.uid,
        warmLabel: after.pod.metadata.labels[warmLabel], processPid: state.pid,
        processCountBeforeCheckpoint: testCase.before.count, processCountAfterRestore: state.count,
        memoryTokenPreserved: state.memoryToken, homeMarker: state.markerFile, rootUid: state.uid,
        siblingHostPathReadable: peerAccess.readable };
    });
  }

  await env.step('Verify the two root-visible HOME directories retained different markers', async () => {
    const states = await Promise.all(cases.map(async ({ project, marker }) => {
      const { pod } = await inspectBox(project);
      const state = await workerState(pod.metadata.name);
      assert.equal(state.markerFile, marker);
      return { projectId: project.id, marker: state.markerFile };
    }));
    assert.notEqual(states[0].marker, states[1].marker, 'Two Boxes share a HOME directory');
    return states;
  });
});
