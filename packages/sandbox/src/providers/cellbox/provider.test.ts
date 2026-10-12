import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import test from 'node:test';
import { CellboxClient, CellboxError, type CellboxBox, type CellboxOperation } from './client.js';
import { CellboxSandboxProvider } from './provider.js';

const wait = (milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds));

test('operation completion uses long polling immediately without a polling delay', async () => {
  let calls = 0;
  const operation = { id: 'op-resume', kind: 'resume', targetId: 'box-a', status: 'running' as const, version: 1, createdAt: new Date().toISOString() };
  const provider = new CellboxSandboxProvider({ baseUrl: 'http://cellbox.test', profileId: 'k8s', retryDelayMs: 5000,
    fetch: async input => {
      const url = new URL(String(input));
      assert.equal(url.pathname, '/v1/operations/op-resume');
      assert.ok(Number(url.searchParams.get('waitMs')) > 0);
      calls++;
      return Response.json({ ...operation, status: 'succeeded', version: 2 });
    },
  });
  const result = provider.waitForOperation(operation, 1000);
  assert.equal(calls, 1);
  assert.equal((await result).status, 'succeeded');
});

test('resume waits for synchronous terminal response and skips operation polling', async () => {
  const http = await fixture();
  let finishResume!: () => void;
  const gate = new Promise<void>(resolve => { finishResume = resolve; });
  try {
    const provider = new CellboxSandboxProvider({ baseUrl: http.baseUrl, profileId: 'k8s', operationTimeoutMs: 250 });
    const box = await provider.create('k8s', { timeoutMs: 60_000, lifecycle: { onTimeout: 'pause', autoResume: false },
      metadata: { cellboxIdempotencyKey: 'create-sync-resume', projectId: 'sync-resume' } });
    const checkpoint = await provider.checkpoint(box.sandboxId);
    http.setResumeResponseMode('terminal');
    http.setResumeGate(gate);
    let resumeTimeoutMs: number | undefined;
    let resumeExpectedGeneration: number | undefined;
    const actBox = provider.client.actBox.bind(provider.client);
    provider.client.actBox = (id, action, key, options) => {
      if (action === 'resume') {
        resumeTimeoutMs = options?.timeoutMs;
        resumeExpectedGeneration = options?.expectedGeneration;
      }
      return actBox(id, action, key, options);
    };
    const beforeResume = http.calls.length;
    let settled = false;
    const connecting = provider.restore(box.sandboxId, checkpoint.id).finally(() => { settled = true; });
    for (let attempt = 0; attempt < 50 && !http.calls.slice(beforeResume).some(call => call.path.endsWith(':resume')); attempt++) await wait(1);
    assert(http.calls.slice(beforeResume).some(call => call.path.endsWith(':resume')));
    await wait(10);
    assert.equal(settled, false, 'connect remains pending until the resume response is terminal');
    finishResume();
    await connecting;
    assert.equal(resumeTimeoutMs, 60_250, 'resume HTTP timeout includes the configured operation limit plus response margin');
    assert.equal(resumeExpectedGeneration, 1, 'resume is fenced to the observed Box generation');
    assert.equal((await provider.getInfo(box.sandboxId)).state, 'running');
    assert.equal(http.calls.slice(beforeResume).filter(call => call.method === 'GET' && call.path.startsWith('/v1/operations/')).length, 0);
  } finally { finishResume(); await http.close(); }
});

test('resume propagates a synchronous terminal error without polling', async () => {
  const http = await fixture();
  try {
    const provider = new CellboxSandboxProvider({ baseUrl: http.baseUrl, profileId: 'k8s' });
    const box = await provider.create('k8s', { timeoutMs: 60_000, lifecycle: { onTimeout: 'pause', autoResume: false },
      metadata: { cellboxIdempotencyKey: 'create-sync-resume-error', projectId: 'sync-resume-error' } });
    const checkpoint = await provider.checkpoint(box.sandboxId);
    http.setResumeResponseMode('error');
    const beforeResume = http.calls.length;
    await assert.rejects(provider.restore(box.sandboxId, checkpoint.id), error => error instanceof CellboxError
      && error.code === 'TIMEOUT' && error.message === 'resume startup timed out');
    assert.equal(http.calls.slice(beforeResume).filter(call => call.method === 'GET' && call.path.startsWith('/v1/operations/')).length, 0);
  } finally { await http.close(); }
});

test('resume request timeout reports unknown outcome without retrying the mutation', async () => {
  let submissions = 0;
  const client = new CellboxClient({ baseUrl: 'http://cellbox.test', fetch: async (_input, init) => {
    submissions++;
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (signal?.aborted) { reject(new Error('aborted')); return; }
      signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
  } });
  const keepAlive = setTimeout(() => {}, 100);
  try {
    await assert.rejects(client.actBox('box-a', 'resume', 'stable-resume-key', { timeoutMs: 10 }), error =>
      error instanceof CellboxError && error.code === 'UNKNOWN_OUTCOME' && !error.message.includes('aborted'));
  } finally { clearTimeout(keepAlive); }
  assert.equal(submissions, 1);
});

test('ensure-running returns its terminal Box snapshot without a follow-up GET or operation poll', async () => {
  const http = await fixture();
  try {
    const provider = new CellboxSandboxProvider({ baseUrl: http.baseUrl, profileId: 'k8s' });
    const handle = await provider.create('k8s', { timeoutMs: 60_000, lifecycle: { onTimeout: 'pause', autoResume: false },
      metadata: { cellboxIdempotencyKey: 'create-ensure-snapshot', projectId: 'ensure-snapshot' } });
    await provider.checkpoint(handle.sandboxId);
    http.boxes.get(handle.sandboxId)!.executionId = 'exec-current';
    const before = http.calls.length;
    const result = await provider.ensureRunning(handle.sandboxId, { operationKey: 'resume-operation-1', expectedGeneration: 1 });
    const calls = http.calls.slice(before);
    assert.deepEqual(calls.map(call => [call.method, call.path]), [['POST', `/v1/boxes/${handle.sandboxId}:ensure-running`]]);
    assert.equal(calls[0].key, 'resume-operation-1');
    assert.deepEqual(calls[0].body, { expectedGeneration: 1 });
    assert.equal(result.info.state, 'running');
    assert.equal(result.info.metadata?.generation, '2');
    assert.equal(result.info.metadata?.executionId, 'exec-current');
    assert.equal(result.info.capabilities?.exec, true);
    assert.equal(result.handle.sandboxId, handle.sandboxId);
  } finally { await http.close(); }
});

test('aborting connect leaves Cellbox resume outcome unknown and performs no fallback work', async () => {
  const http = await fixture();
  let finishResume!: () => void;
  const gate = new Promise<void>(resolve => { finishResume = resolve; });
  try {
    const provider = new CellboxSandboxProvider({ baseUrl: http.baseUrl, profileId: 'k8s' });
    const box = await provider.create('k8s', { timeoutMs: 60_000, lifecycle: { onTimeout: 'pause', autoResume: false },
      metadata: { cellboxIdempotencyKey: 'create-abort-connect', projectId: 'abort-connect' } });
    await provider.checkpoint(box.sandboxId);
    http.setResumeGate(gate);
    const controller = new AbortController();
    const before = http.calls.length;
    const connecting = provider.ensureRunning(box.sandboxId, { operationKey: 'abort-resume-key', signal: controller.signal });
    for (let attempt = 0; attempt < 50 && !http.calls.slice(before).some(call => call.path.endsWith(':ensure-running')); attempt++) await wait(1);
    const resumeCallIndex = http.calls.findIndex((call, index) => index >= before && call.path.endsWith(':ensure-running'));
    assert.notEqual(resumeCallIndex, -1, 'ensure-running request was submitted before abort');
    assert.equal(http.calls[resumeCallIndex].body, '');
    controller.abort();
    await assert.rejects(connecting, error => error instanceof CellboxError && error.code === 'UNKNOWN_OUTCOME');
    finishResume();
    await wait(10);
    assert.equal(http.calls.slice(before).filter(call => call.path.endsWith(':ensure-running')).length, 1);
    assert.equal(http.calls.slice(resumeCallIndex + 1).length, 0, 'cancelled ensure did no follow-up fetch or key-rotation work');
  } finally { finishResume(); await http.close(); }
});

test('aborting checkpoint restore cancels its waiter without retrying resume', async () => {
  const http = await fixture();
  let finishResume!: () => void;
  const gate = new Promise<void>(resolve => { finishResume = resolve; });
  try {
    const provider = new CellboxSandboxProvider({ baseUrl: http.baseUrl, profileId: 'k8s' });
    const box = await provider.create('k8s', { timeoutMs: 60_000, lifecycle: { onTimeout: 'pause', autoResume: false },
      metadata: { cellboxIdempotencyKey: 'create-abort-restore', projectId: 'abort-restore' } });
    const checkpoint = await provider.checkpoint(box.sandboxId);
    http.setResumeGate(gate);
    const controller = new AbortController();
    const before = http.calls.length;
    const restoring = provider.restore(box.sandboxId, checkpoint.id, { signal: controller.signal });
    for (let attempt = 0; attempt < 50 && !http.calls.slice(before).some(call => call.path.endsWith(':resume')); attempt++) await wait(1);
    const resumeIndex = http.calls.findIndex((call, index) => index >= before && call.path.endsWith(':resume'));
    assert.notEqual(resumeIndex, -1, 'restore submitted the fenced resume');
    controller.abort();
    await assert.rejects(restoring, error => error instanceof CellboxError && error.code === 'UNKNOWN_OUTCOME');
    finishResume();
    await wait(10);
    assert.equal(http.calls.slice(before).filter(call => call.path.endsWith(':resume')).length, 1);
    assert.equal(http.calls.slice(resumeIndex + 1).length, 0, 'cancelled restore performed no follow-up work');
  } finally { finishResume(); await http.close(); }
});

const capabilities = { exec: true, files: true, http: true, websocket: true, pty: false,
  reconnectExec: false, freeze: false, suspend: 'same-node-checkpoint', archives: 'workspace-best-effort', protectedTools: false };

test('file transport streams ranges and preserves HTTP statuses without forwarding browser credentials', async () => {
  for (const status of [206, 304, 412, 416]) {
    let cancelled = false;
    const client = new CellboxClient({ baseUrl: 'http://cellbox.test', fetch: async (input, init) => {
      assert.match(String(input), /files\?path=source%2Ffile.txt$/);
      const headers = new Headers(init?.headers);
      assert.equal(headers.get('authorization'), null);
      assert.equal(headers.get('cookie'), null);
      assert.equal(headers.get('accept-encoding'), 'identity');
      assert.equal(headers.get('range'), 'bytes=0-4');
      assert.equal(headers.get('if-range'), '"version"');
      const body = status === 304 ? null : new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new TextEncoder().encode('hello')); },
        cancel() { cancelled = true; },
      });
      return new Response(body, { status, headers: { 'Content-Range': 'bytes 0-4/13' } });
    } });
    const response = await client.fileResponse('box', 'source/file.txt', { headers: new Headers({
      Range: 'bytes=0-4', 'If-Range': '"version"', Authorization: 'browser-token', Cookie: 'browser-cookie',
    }) });
    assert.equal(response.status, status);
    if (response.body) { await response.body.cancel(); assert.equal(cancelled, true); }
  }
});

async function fixture() {
  const calls: Array<{ method: string; path: string; key?: string; body: unknown }> = [];
  const boxes = new Map<string, Record<string, unknown>>();
  const keys = new Map<string, string>();
  let activeInventory: Record<string, unknown>[] = [];
  let checkpointInventory: Record<string, unknown>[] = [];
  let checkpointsUnavailable = false;
  let counter = 0;
  let fileContents: Buffer = Buffer.from('content');
  let profileProvider = 'resumable-k8s-pod';
  let pending = false;
  let resumeResponseMode: 'accepted' | 'terminal' | 'error' = 'accepted';
  let resumeGate: Promise<void> | undefined;
  let operationGate: Promise<void> | undefined;
  let execResult = { stdout: '', stderr: '', exitCode: 0, truncated: false };
  let execOperationFails = false;
  let execState: 'exited' | 'unknown' = 'exited';
  let purgeUnavailable = false;
  let resumeRejection: { code: string; update?: (box: Record<string, unknown>) => void } | undefined;
  const json = (res: ServerResponse, status: number, value: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value));
  };
  const op = (kind: string, targetId: string, result: Record<string, string> = {}): CellboxOperation =>
    ({ id: `op-${++counter}`, kind, targetId, status: pending ? 'running' : 'succeeded', version: 1,
      createdAt: new Date().toISOString(), result });
  const operations = new Map<string, CellboxOperation>();
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    assert.equal(req.headers.authorization, undefined, 'Cellbox requests must not need a token');
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString();
    const body = raw && req.headers['content-type'] === 'application/json' ? JSON.parse(raw) : raw;
    const url = new URL(req.url!, 'http://localhost');
    calls.push({ method: req.method!, path: url.pathname + url.search, key: req.headers['idempotency-key'] as string | undefined, body });
    if (url.pathname === '/v1/boxes' && req.method === 'GET') { json(res, 200, activeInventory); return; }
    if (url.pathname === '/v1/checkpoints' && req.method === 'GET') {
      if (checkpointsUnavailable) { json(res, 503, { error: { code: 'UNAVAILABLE', message: 'Temporarily unavailable' } }); return; }
      json(res, 200, checkpointInventory); return;
    }
    if (url.pathname === '/v1/profiles') { json(res, 200, [{ id: 'k8s', provider: profileProvider, runtime: 'k8s', behavior: 'resumable', kind: 'k8s-resumable', capabilities,
      image: 'prepared:1', workspace: '/workspace', agent: { uid: 11000, gid: 11000 }, cpu: 1, memoryMiB: 1024 }]); return; }
    if (url.pathname === '/v1/boxes' && req.method === 'POST') {
      const key = req.headers['idempotency-key'] as string;
      let id = keys.get(key);
      if (!id) {
        id = `box-${++counter}`; keys.set(key, id);
        boxes.set(id, { id, ownerKey: (body as { ownerKey: string }).ownerKey, profileId: 'k8s', phase: 'running', generation: 1,
          resourceVersion: 1, image: 'prepared:1', imageId: 'sha256:1', workspace: '/workspace', capabilities,
          createdAt: new Date().toISOString() });
      }
      const value = op('create', id, { boxId: id }); operations.set(value.id, value); json(res, 202, value); return;
    }
    const purgeMatch = url.pathname.match(/^\/v1\/boxes\/(box-[^/:]+):purge$/);
    if (purgeMatch && req.method === 'POST') {
      if (purgeUnavailable) { json(res, 404, { error: { code: 'NOT_FOUND', message: 'endpoint not found' } }); return; }
      if (boxes.get(purgeMatch[1])?.phase !== 'deleted' && boxes.has(purgeMatch[1])) { json(res, 409, { error: { code: 'CONFLICT', message: 'not deleted' } }); return; }
      boxes.delete(purgeMatch[1]); res.writeHead(204); res.end(); return;
    }
    const boxMatch = url.pathname.match(/^\/v1\/boxes\/(box-[^/:]+)(?::(suspend|resume|ensure-running|destroy))?$/);
    if (boxMatch) {
      const box = boxes.get(boxMatch[1]);
      if (!box) { json(res, 404, { error: { code: 'NOT_FOUND', message: 'Missing box' } }); return; }
      if (req.method === 'GET') { json(res, 200, box); return; }
      if (boxMatch[2]) {
        const action = boxMatch[2];
        if (action === 'ensure-running') {
          await resumeGate;
          const key = req.headers['idempotency-key'] as string;
          let value = key ? operations.get(keys.get(key) ?? '') : undefined;
          if (!value) {
            if (typeof (body as { expectedGeneration?: number } | undefined)?.expectedGeneration === 'number'
                && (body as { expectedGeneration: number }).expectedGeneration !== box.generation) {
              json(res, 409, { error: { code: 'STALE_GENERATION', message: 'generation changed' } }); return;
            }
            if (box.phase === 'suspended') { box.phase = 'running'; box.generation = (box.generation as number) + 1; }
            if (box.phase !== 'running') { json(res, 409, { error: { code: 'CONFLICT', message: `Box is ${box.phase}` } }); return; }
            const operation: CellboxOperation = { ...op('ensure-running', boxMatch[1]), box: { ...box } as unknown as CellboxBox };
            value = operation;
            if (key) keys.set(key, operation.id);
            operations.set(operation.id, operation);
          }
          json(res, 200, value); return;
        }
        if (action === 'resume' && resumeRejection) {
          const rejection = resumeRejection; resumeRejection = undefined;
          rejection.update?.(box);
          json(res, 409, { error: { code: rejection.code, message: 'resume rejected' } }); return;
        }
        if (action === 'resume' && resumeResponseMode === 'error') {
          json(res, 502, { error: { code: 'TIMEOUT', message: 'resume startup timed out' } }); return;
        }
        if (action === 'resume') await resumeGate;
        box.phase = action === 'suspend' ? 'suspended' : action === 'resume' ? 'running' : 'deleted';
        if (action === 'resume') box.generation = (box.generation as number) + 1;
        const value = op(action, boxMatch[1], { boxId: boxMatch[1] }); operations.set(value.id, value);
        json(res, action === 'resume' && resumeResponseMode === 'terminal' ? 200 : 202, value); return;
      }
    }
    const execMatch = url.pathname.match(/^\/v1\/boxes\/(box-[^/]+)\/execs$/);
    if (execMatch) {
      const value = op('exec', execMatch[1], { execId: `exec-${counter + 1}` });
      operations.set(value.id, value); json(res, 202, value); return;
    }
    if (url.pathname.startsWith('/v1/operations/')) {
      await operationGate;
      const value = operations.get(url.pathname.split('/').at(-1)!);
      if (value?.status === 'running') {
        value.status = value.kind === 'exec' && execOperationFails ? 'failed' : 'succeeded';
        if (value.status === 'failed') (value as typeof value & { error?: { code: string; message: string } }).error = { code: 'TIMEOUT', message: 'runtime deadline' };
        if (value.status === 'succeeded' && ['resume', 'ensure-running'].includes(value.kind)) {
          const box = boxes.get(value.targetId);
          if ((box?.phase === 'resuming' || box?.phase === 'running') && box.operationId === value.id) {
            box.phase = 'running';
            box.generation = Number(box.generation) + 1;
            delete box.operationId;
            if (value.kind === 'ensure-running') value.box = { ...box } as unknown as CellboxBox;
          }
        }
      }
      json(res, 200, value); return;
    }
    if (url.pathname.startsWith('/v1/execs/')) {
      json(res, 200, { id: url.pathname.split('/').at(-1), boxId: 'box-1', operationId: 'op-1', state: execState,
        result: execResult }); return;
    }
    if (url.pathname.endsWith('/files') && req.method === 'PUT') { res.writeHead(204); res.end(); return; }
    if (url.pathname.endsWith('/files') && req.method === 'GET') { res.writeHead(200); res.end(fileContents); return; }
    if (url.pathname.endsWith('/credentials/glab_token') && req.method === 'PUT') { res.writeHead(204); res.end(); return; }
    if (url.pathname === '/v1/routes') { json(res, 201, { id: 'route-1', boxId: (body as { boxId: string }).boxId,
      port: (body as { port: number }).port, url: 'https://route-1.example.test/' }); return; }
    if (url.pathname === '/v1/archives/archive-1/content') {
      res.writeHead(200, { 'Content-Type': 'application/gzip' }); res.write('abc'); res.end('def'); return;
    }
    json(res, 404, { error: { code: 'NOT_FOUND', message: 'Missing endpoint' } });
  };
  const server = createServer((req, res) => { void handle(req, res).catch(error => { res.writeHead(500); res.end(String(error)); }); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert(address && typeof address !== 'string');
  return { baseUrl: `http://127.0.0.1:${address.port}`, calls, boxes, keys,
    setInventory(active: Record<string, unknown>[], checkpoints: Record<string, unknown>[]) {
      activeInventory = active; checkpointInventory = checkpoints;
    },
    setCheckpointsUnavailable(value: boolean) { checkpointsUnavailable = value; },
    setProfileProvider(value: string) { profileProvider = value; },
    setFileContents(value: Buffer) { fileContents = value; },
    setPending(value: boolean) { pending = value; },
    setOperation(value: CellboxOperation) { operations.set(value.id, value); },
    setOperationGate(value: Promise<void> | undefined) { operationGate = value; },
    setResumeResponseMode(value: typeof resumeResponseMode) { resumeResponseMode = value; },
    setResumeGate(value: Promise<void> | undefined) { resumeGate = value; },
    rejectResume(code: string, update?: (box: Record<string, unknown>) => void) { resumeRejection = { code, update }; },
    setExecResult(value: typeof execResult) { execResult = value; },
    setExecOperationFails(value: boolean) { execOperationFails = value; },
    setExecState(value: 'exited' | 'unknown') { execState = value; },
    setPurgeUnavailable(value: boolean) { purgeUnavailable = value; },
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}

test('restore renews an expired resume key only after checking the same idle suspension', async () => {
  const http = await fixture();
  try {
    const provider = new CellboxSandboxProvider({ baseUrl: http.baseUrl, profileId: 'k8s' });
    const box = await provider.create('k8s', { timeoutMs: 60_000, lifecycle: { onTimeout: 'pause', autoResume: false },
      metadata: { cellboxIdempotencyKey: 'create-resume', projectId: 'resume' } });
    const checkpoint = await provider.checkpoint(box.sandboxId);
    http.rejectResume('OPERATION_EXPIRED');
    await provider.restore(box.sandboxId, checkpoint.id);
    const attempts = http.calls.filter(call => call.path.endsWith(':resume'));
    assert.equal(attempts.length, 2);
    assert.notEqual(attempts[0].key, attempts[1].key);
    const between = http.calls.slice(http.calls.indexOf(attempts[0]) + 1, http.calls.indexOf(attempts[1]));
    assert(between.some(call => call.method === 'GET' && call.path === `/v1/boxes/${box.sandboxId}`));
    assert.equal((await provider.getInfo(box.sandboxId)).state, 'running');
  } finally { await http.close(); }
});

test('connect joins the Box-identified resume operation instead of submitting a second resume', async () => {
  const http = await fixture();
  try {
    const provider = new CellboxSandboxProvider({ baseUrl: http.baseUrl, profileId: 'k8s', retryDelayMs: 1 });
    const created = await provider.create('k8s', { timeoutMs: 60_000, lifecycle: { onTimeout: 'pause', autoResume: false },
      metadata: { cellboxIdempotencyKey: 'create-join-resume', projectId: 'join-resume' } });
    const box = http.boxes.get(created.sandboxId)!;
    box.phase = 'resuming';
    box.operationId = 'op-join-resume';
    http.setOperation({ id: 'op-join-resume', kind: 'resume', targetId: created.sandboxId, status: 'running', version: 1,
      createdAt: new Date().toISOString() });

    const connected = await provider.connect(created.sandboxId);
    assert.equal(connected.sandboxId, created.sandboxId);
    assert.equal(box.phase, 'running');
    assert(http.calls.some(call => call.method === 'GET' && call.path.startsWith('/v1/operations/op-join-resume')));
    assert.equal(http.calls.filter(call => call.path.endsWith(':resume')).length, 0);
  } finally { await http.close(); }
});

test('connect joins an in-flight ensure-running operation from its terminal snapshot without a second Box GET', async () => {
  const http = await fixture();
  try {
    const provider = new CellboxSandboxProvider({ baseUrl: http.baseUrl, profileId: 'k8s', retryDelayMs: 1 });
    const created = await provider.create('k8s', { timeoutMs: 60_000, lifecycle: { onTimeout: 'pause', autoResume: false },
      metadata: { cellboxIdempotencyKey: 'create-join-ensure', projectId: 'join-ensure' } });
    const box = http.boxes.get(created.sandboxId)!;
    box.phase = 'resuming';
    box.operationId = 'op-join-ensure';
    http.setOperation({ id: 'op-join-ensure', kind: 'ensure-running', targetId: created.sandboxId, status: 'running', version: 1,
      createdAt: new Date().toISOString() });

    const before = http.calls.length;
    const connected = await provider.connect(created.sandboxId);
    const calls = http.calls.slice(before);
    assert.equal(connected.sandboxId, created.sandboxId);
    assert.equal(box.phase, 'running');
    assert.equal(box.operationId, undefined);
    assert.equal(calls.filter(call => call.method === 'POST' && /:(?:resume|ensure-running)$/.test(call.path)).length, 0,
      'ordinary connect only joins the already admitted operation');
    assert.equal(calls.filter(call => call.method === 'GET' && call.path === `/v1/boxes/${created.sandboxId}`).length, 1,
      'the initial observation is enough; terminal operation.box avoids a follow-up GET');
    assert(calls.some(call => call.method === 'GET' && call.path.startsWith('/v1/operations/op-join-ensure')));
  } finally { await http.close(); }
});

test('running Box with an active resume operation is not ready until that operation is terminal', async () => {
  const http = await fixture();
  let finishOperation!: () => void;
  const gate = new Promise<void>(resolve => { finishOperation = resolve; });
  try {
    const provider = new CellboxSandboxProvider({ baseUrl: http.baseUrl, profileId: 'k8s' });
    const created = await provider.create('k8s', { timeoutMs: 60_000, lifecycle: { onTimeout: 'pause', autoResume: false },
      metadata: { cellboxIdempotencyKey: 'create-running-resume-op', projectId: 'running-resume-op' } });
    const box = http.boxes.get(created.sandboxId)!;
    box.phase = 'running';
    box.operationId = 'op-running-resume';
    http.setOperation({ id: 'op-running-resume', kind: 'resume', targetId: created.sandboxId, status: 'running', version: 1,
      createdAt: new Date().toISOString() });
    http.setOperationGate(gate);
    const info = await provider.getInfo(created.sandboxId);
    assert.equal(info.state, 'unknown', 'manager must not reuse a cached handle while Cellbox has an active operation');
    assert.equal(info.metadata?.operationId, 'op-running-resume');

    const before = http.calls.length;
    let settled = false;
    const connecting = provider.connect(created.sandboxId).finally(() => { settled = true; });
    for (let attempt = 0; attempt < 50 && !http.calls.slice(before).some(call => call.path.startsWith('/v1/operations/op-running-resume')); attempt++) await wait(1);
    assert(http.calls.slice(before).some(call => call.path.startsWith('/v1/operations/op-running-resume')));
    await wait(10);
    assert.equal(settled, false, 'connect waits for terminal operation publication');
    finishOperation();
    const connected = await connecting;
    assert.equal(connected.sandboxId, created.sandboxId);
    assert.equal(box.phase, 'running');
    assert.equal(box.operationId, undefined);
    assert.equal(http.calls.slice(before).filter(call => call.path.endsWith(':resume')).length, 0);
  } finally { finishOperation(); await http.close(); }
});

test('connect reports the result of a failed in-flight resume operation', async () => {
  const http = await fixture();
  try {
    const provider = new CellboxSandboxProvider({ baseUrl: http.baseUrl, profileId: 'k8s' });
    const created = await provider.create('k8s', { timeoutMs: 60_000, lifecycle: { onTimeout: 'pause', autoResume: false },
      metadata: { cellboxIdempotencyKey: 'create-failed-join', projectId: 'failed-join' } });
    const box = http.boxes.get(created.sandboxId)!;
    box.phase = 'resuming';
    box.operationId = 'op-failed-resume';
    http.setOperation({ id: 'op-failed-resume', kind: 'resume', targetId: created.sandboxId, status: 'failed', version: 2,
      createdAt: new Date().toISOString(), error: { code: 'RUNTIME_ERROR', message: 'restore failed' } });

    await assert.rejects(provider.connect(created.sandboxId), error => error instanceof CellboxError
      && error.code === 'RUNTIME_ERROR' && error.message === 'restore failed');
    assert.equal(http.calls.filter(call => call.path.endsWith(':resume')).length, 0);
  } finally { await http.close(); }
});

test('connect refuses to join a resuming Box when operation identity does not match', async () => {
  const http = await fixture();
  try {
    const provider = new CellboxSandboxProvider({ baseUrl: http.baseUrl, profileId: 'k8s' });
    const created = await provider.create('k8s', { timeoutMs: 60_000, lifecycle: { onTimeout: 'pause', autoResume: false },
      metadata: { cellboxIdempotencyKey: 'create-invalid-join', projectId: 'invalid-join' } });
    const box = http.boxes.get(created.sandboxId)!;
    box.phase = 'resuming';
    box.operationId = 'op-foreign-operation';
    http.setOperation({ id: 'op-foreign-operation', kind: 'suspend', targetId: created.sandboxId, status: 'running', version: 1,
      createdAt: new Date().toISOString() });

    await assert.rejects(provider.connect(created.sandboxId), error => error instanceof CellboxError && error.code === 'CONFLICT');
    assert.equal(http.calls.filter(call => call.path.endsWith(':resume')).length, 0);
  } finally { await http.close(); }
});

for (const scenario of ['unknown outcome', 'changed generation', 'running', 'active operation'] as const)
  test(`resume does not rotate its key with ${scenario}`, async () => {
    const http = await fixture();
    try {
      const provider = new CellboxSandboxProvider({ baseUrl: http.baseUrl, profileId: 'k8s' });
      const box = await provider.create('k8s', { timeoutMs: 60_000, lifecycle: { onTimeout: 'pause', autoResume: false },
        metadata: { cellboxIdempotencyKey: 'create-resume', projectId: 'resume' } });
      const checkpoint = await provider.checkpoint(box.sandboxId);
      const code = scenario === 'unknown outcome' ? 'UNKNOWN_OUTCOME' : 'OPERATION_EXPIRED';
      http.rejectResume(code, current => {
        if (scenario === 'changed generation') current.generation = Number(current.generation) + 1;
        if (scenario === 'running') current.phase = 'running';
        if (scenario === 'active operation') current.operationId = 'op-concurrent';
      });
      await assert.rejects(provider.restore(box.sandboxId, checkpoint.id), error => error instanceof CellboxError && error.code === code);
      assert.equal(http.calls.filter(call => call.path.endsWith(':resume')).length, 1);
    } finally { await http.close(); }
  });

test('destruction requires artifact purge and removes only the matching local create journal', async () => {
  const http = await fixture();
  const directory = await mkdtemp(join(tmpdir(), 'cocell-purge-'));
  try {
    const provider = new CellboxSandboxProvider({ baseUrl: http.baseUrl, profileId: 'k8s', stateDirectory: directory });
    const options = { timeoutMs: 60_000, lifecycle: { onTimeout: 'pause' as const, autoResume: false as const } };
    const source = await provider.create('k8s', { ...options, metadata: { projectId: 'archived' } });
    const other = await provider.create('k8s', { ...options, metadata: { projectId: 'active' } });
    for (const name of await readdir(directory)) {
      if (JSON.parse(await readFile(join(directory, name), 'utf8')).boxId === source.sandboxId) {
        await writeFile(join(directory, `${name.slice(0, -5)}.11111111-1111-4111-8111-111111111111.tmp`), '{partial');
      }
    }
    http.setPurgeUnavailable(true);
    await assert.rejects(provider.kill(source.sandboxId), error => error instanceof CellboxError && error.code === 'CLEANUP_FAILED' && !/not found|404/i.test(error.message));
    assert.equal(http.boxes.get(source.sandboxId)?.phase, 'deleted');
    assert.equal((await readdir(directory)).length, 3, 'failure retains the retry journal and its abandoned temporary file');
    http.setPurgeUnavailable(false);
    await provider.kill(source.sandboxId);
    assert.equal(http.boxes.has(source.sandboxId), false);
    const remaining = await readdir(directory);
    assert.equal(remaining.length, 1);
    assert.equal(JSON.parse(await readFile(join(directory, remaining[0]), 'utf8')).boxId, other.sandboxId);
    await provider.kill(source.sandboxId);
    assert.equal(http.calls.filter(call => call.path === `/v1/boxes/${source.sandboxId}:purge`).length, 3, 'even an absent box must confirm purge');
  } finally { await http.close(); await rm(directory, { recursive: true, force: true }); }
});

test('inventory combines active boxes and paused checkpoints, preferring the active record', async () => {
  const http = await fixture();
  try {
    const provider = new CellboxSandboxProvider({ baseUrl: http.baseUrl, profileId: 'k8s' });
    const box = (id: string, phase: string, image: string) => ({ id, ownerKey: 'owner', profileId: 'k8s', phase,
      generation: 1, resourceVersion: 1, image, workspace: '/workspace', capabilities,
      createdAt: '2026-10-01T00:00:00.000Z' });
    http.setInventory([box('duplicate', 'running', 'active-image'), box('active-only', 'running', 'active-only-image')],
      [box('duplicate', 'suspended', 'stale-image'), box('paused-only', 'suspended', 'paused-image')]);

    const rows = await provider.listBoxes();
    assert.deepEqual(rows.map(row => row.id), ['duplicate', 'active-only', 'paused-only']);
    assert.equal(rows[0].phase, 'running');
    assert.equal(rows[0].image, 'active-image');
    assert.deepEqual(http.calls.map(call => call.path).sort(), ['/v1/boxes', '/v1/checkpoints']);

    http.setCheckpointsUnavailable(true);
    await assert.rejects(provider.listBoxes(), (error: unknown) => error instanceof CellboxError && error.status === 503);
  } finally { await http.close(); }
});

test('batch status reads one resource inventory without per-box or checkpoint requests', async () => {
  const http = await fixture();
  try {
    const provider = new CellboxSandboxProvider({ baseUrl: http.baseUrl, profileId: 'k8s' });
    await provider.initialize();
    const box = (id: string, phase: string) => ({ id, ownerKey: 'owner', profileId: 'k8s', phase,
      generation: 1, resourceVersion: 1, image: 'prepared:1', workspace: '/workspace', capabilities,
      createdAt: '2026-10-01T00:00:00.000Z' });
    const rows = [box('one', 'running'), box('two', 'suspended'), box('three', 'creating'),
      box('four', 'restoring'), box('five', 'failed'), box('unrelated', 'running')];
    http.setInventory(rows, []);
    http.setCheckpointsUnavailable(true);
    http.calls.length = 0;
    const ids = rows.slice(0, 5).map(box => box.id);
    const infos = await provider.getInfos([...ids, 'missing']);
    assert.equal(infos.length, 5);
    assert.equal(infos[0].state, 'running');
    assert.equal(infos[1].state, 'paused');
    assert.equal(infos[3].metadata?.phase, 'restoring');
    assert.deepEqual(http.calls.map(call => call.path), ['/v1/boxes?observation=resource']);
    await provider.getInfos(ids);
    assert.equal(http.calls.length, 2, 'every refresh reads the source');
    assert.deepEqual(await provider.getInfos([]), []);
    assert.equal(http.calls.length, 2, 'empty lists do not read inventory');
  } finally { await http.close(); }
});

test('anonymous access, Kubernetes profile validation, and durable create key adoption', async () => {
  const http = await fixture();
  const stateDirectory = await mkdtemp(join(tmpdir(), 'cellbox-adapter-'));
  try {
    const anonymous = new CellboxClient({ baseUrl: http.baseUrl });
    assert.equal((await anonymous.listProfiles()).length, 1);
    const provider = new CellboxSandboxProvider({ baseUrl: http.baseUrl, profileId: 'k8s',
      workspace: '/workspace', stateDirectory, retryDelayMs: 1 });
    http.setProfileProvider('docker');
    await assert.rejects(provider.initialize(), (error: unknown) => error instanceof CellboxError && error.code === 'UNSUPPORTED_CAPABILITY');
    http.setProfileProvider('resumable-k8s-pod');
    await provider.initialize();
    assert.deepEqual(await provider.currentImageIdentity(), { reference: 'prepared:1', id: 'prepared:1', repoDigests: [] });
    const options = { timeoutMs: 60_000, lifecycle: { onTimeout: 'pause' as const, autoResume: false as const },
      metadata: { projectId: 'project-one', sessionId: 'conversation-one', cellboxImportedImageId: 'imported-one' } };
    const first = await provider.create('k8s', options);
    http.boxes.get(first.sandboxId)!.phase = 'staged';
    await assert.rejects(provider.connect(first.sandboxId), (error: unknown) => error instanceof CellboxError && error.code === 'CONFLICT');
    assert.equal((await provider.connectForSetup(first.sandboxId)).sandboxId, first.sandboxId);
    http.boxes.get(first.sandboxId)!.phase = 'suspended';
    const second = await provider.create('k8s', { ...options, metadata: { ...options.metadata, sessionId: 'conversation-two' } });
    assert.equal(first.sandboxId, second.sandboxId);
    assert.equal(http.boxes.get(first.sandboxId)!.phase, 'running');
    const creates = http.calls.filter(call => call.path === '/v1/boxes' && call.method === 'POST');
    assert.equal(creates.length, 2);
    assert.equal(creates[0].key, creates[1].key);
    assert.equal((creates[0].body as { ownerKey: string }).ownerKey, 'project:project-one');
    assert.equal((creates[0].body as { importedImageId: string }).importedImageId, 'imported-one');
    assert.equal(http.keys.size, 2, 'the create key and explicit ensure-running key are independently journaled');
    assert.equal(http.calls.filter(call => call.path.endsWith(':ensure-running')).length, 1);
    await provider.kill(first.sandboxId);
    const third = await provider.create('k8s', options);
    assert.notEqual(third.sandboxId, first.sandboxId);
    assert.equal(http.keys.size, 3);
    await provider.client.writeCredential(third.sandboxId, 'glab_token', Buffer.from('secret'));
    assert(http.calls.some(call => call.path.endsWith('/credentials/glab_token') && call.body === 'secret'));
    http.boxes.delete(third.sandboxId);
    const fourth = await provider.create('k8s', options);
    assert.notEqual(fourth.sandboxId, third.sandboxId);
    http.boxes.get(fourth.sandboxId)!.phase = 'failed';
    http.boxes.get(fourth.sandboxId)!.operationId = 'op-still-pending';
    await assert.rejects(provider.create('k8s', options), (error: unknown) => error instanceof CellboxError && error.code === 'CONFLICT');
    assert.equal(http.keys.size, 4, 'an active or uncertain operation must keep its original create key');
    delete http.boxes.get(fourth.sandboxId)!.operationId;
    const retry = await provider.create('k8s', options);
    assert.notEqual(retry.sandboxId, fourth.sandboxId);
    assert.equal(http.keys.size, 5, 'a terminally failed creation can be retried with a new key');
  } finally { await http.close(); await rm(stateDirectory, { recursive: true, force: true }); }
});

test('exec checks generation, shell quotes outside-workspace paths, and does not offer cancellation', async () => {
  const http = await fixture();
  try {
    const provider = new CellboxSandboxProvider({ baseUrl: http.baseUrl, profileId: 'k8s', retryDelayMs: 1 });
    const box = await provider.create('k8s', { timeoutMs: 60_000, lifecycle: { onTimeout: 'pause', autoResume: false },
      metadata: { cellboxOwnerKey: 'p', cellboxIdempotencyKey: 'create-p' } });
    await box.commands.run('printf hello', { idempotencyKey: 'exec-one', cwd: '/workspace/source' } as never);
    const execution = http.calls.find(call => call.path.endsWith('/execs'))!;
    assert.equal(execution.key, 'exec-one');
    assert.deepEqual((execution.body as { argv: string[]; expectedGeneration: number; cwd: string }).argv, ['/bin/sh', '-c', 'printf hello']);
    assert.equal((execution.body as { expectedGeneration: number }).expectedGeneration, 1);
    assert.equal((execution.body as { cwd: string }).cwd, 'source');
    await assert.rejects(box.commands.run('x'.repeat(8193)),
      (error: unknown) => error instanceof CellboxError && error.code === 'INVALID_REQUEST');
    await assert.rejects(box.commands.run('pwd', { cwd: '/workspace/a/../b' }),
      (error: unknown) => error instanceof CellboxError && error.code === 'INVALID_REQUEST');
    const contents = Buffer.alloc(20 * 1024, 0x61);
    await box.files.write("/home/agent/.cocell-startup/a'b.json", contents);
    const transfers = http.calls.filter(call => call.path.endsWith('/execs'))
      .map(call => call.body as { argv: string[]; env?: Record<string, string> });
    assert(transfers.every(call => Buffer.byteLength(call.argv[2]) <= 8192));
    const chunks = transfers.flatMap(call => call.env?.COCELL_FILE_CHUNK ? [call.env.COCELL_FILE_CHUNK] : []);
    assert(chunks.length > 1);
    assert(chunks.every(chunk => Buffer.byteLength(chunk) <= 8192));
    assert.deepEqual(Buffer.concat(chunks.map(chunk => Buffer.from(chunk, 'base64'))), contents);
    assert(transfers.some(call => call.argv[2].includes('chmod 600 -- ') && call.argv[2].includes(' && mv -f -- ')));
    await box.files.remove("/home/agent/a'b");
    const quoted = http.calls.filter(call => call.path.endsWith('/execs')).at(-1)!.body as { argv: string[] };
    assert.equal(quoted.argv[2], "rm -rf -- '/home/agent/a'\\''b'");
    await assert.rejects(box.commands.run('id', { user: 'root' }), (error: unknown) => error instanceof CellboxError && error.code === 'UNSUPPORTED_CAPABILITY');
    const background = await box.commands.run('sleep 1', { background: true });
    assert.equal(await background.kill(), false);
    await background.disconnect();
    await background.wait();
    const checkpoint = await provider.checkpoint(box.sandboxId);
    assert.match(checkpoint.id, /^cellbox-suspended:/);
    assert.equal((await provider.getInfo(box.sandboxId)).state, 'paused');
    await provider.restore(box.sandboxId, checkpoint.id);
    assert.equal((await provider.getInfo(box.sandboxId)).state, 'running');
    await provider.pause(box.sandboxId);
    await provider.ensureRunning(box.sandboxId, { operationKey: 'service-access-resume' });
    const beforeAccess = http.calls.length;
    const access = await provider.getServiceAccess(box.sandboxId, 3000);
    assert.equal(http.calls.length, beforeAccess, 'preview access requires no route or grant API calls');
    assert.equal(access.url, `${http.baseUrl}/v1/boxes/${box.sandboxId}/services/3000/`);
    assert.equal(await box.getServiceUrl!(3000), 'https://route-1.example.test/');
    assert.deepEqual(access.headers, {});
    assert(!http.calls.some(call => call.path.includes('/grants')), 'preview access must not create or renew grants');
  } finally { await http.close(); }
});

test('a lost mutation response reports unknown outcome without replay', async () => {
  let requests = 0;
  const client = new CellboxClient({ baseUrl: 'http://127.0.0.1:1',
    fetch: async () => { requests++; throw new Error('socket reset'); } });
  await assert.rejects(client.createBox({ profileId: 'k8s', ownerKey: 'p' }, 'durable-key'),
    (error: unknown) => error instanceof CellboxError && error.code === 'UNKNOWN_OUTCOME' && error.idempotencyKey === 'durable-key');
  assert.equal(requests, 1);
});

test('admitted tool HTTP deadline covers its execution timeout', async () => {
  const client = new CellboxClient({ baseUrl: 'http://127.0.0.1:1', requestTimeoutMs: 1,
    fetch: async (_input, init) => {
      await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal(init?.signal?.aborted, false);
      return Response.json({ stdout: 'done', stderr: '', exitCode: 0 });
    } });
  assert.equal((await client.runTool('box', 'archive', [], 50)).stdout, 'done');
});

test('malformed mutation responses preserve uncertain outcomes and HTTP errors retain codes', async () => {
  const broken = new CellboxClient({ baseUrl: 'http://127.0.0.1:1',
    fetch: async () => new Response('{', { status: 202, headers: { 'Content-Type': 'application/json' } }) });
  await assert.rejects(broken.createBox({ profileId: 'k8s', ownerKey: 'p' }, 'same-key'),
    (error: unknown) => error instanceof CellboxError && error.code === 'UNKNOWN_OUTCOME' && error.idempotencyKey === 'same-key');
  const conflict = new CellboxClient({ baseUrl: 'http://127.0.0.1:1',
    fetch: async () => new Response('broken', { status: 409 }) });
  await assert.rejects(conflict.createBox({ profileId: 'k8s', ownerKey: 'p' }, 'same-key'),
    (error: unknown) => error instanceof CellboxError && error.code === 'CONFLICT' && error.status === 409);
});

test('create reuses a journaled key after the HTTP response is lost', async () => {
  const http = await fixture();
  const stateDirectory = await mkdtemp(join(tmpdir(), 'cellbox-lost-create-'));
  try {
    let dropped = false;
    const provider = new CellboxSandboxProvider({ baseUrl: http.baseUrl, profileId: 'k8s',
      stateDirectory, fetch: async (input, init) => {
        const response = await fetch(input, init);
        if (!dropped && init?.method === 'POST' && String(input).endsWith('/v1/boxes')) {
          dropped = true; throw new Error('socket reset after submit');
        }
        return response;
      } });
    const options = { timeoutMs: 60_000, lifecycle: { onTimeout: 'pause' as const, autoResume: false as const },
      metadata: { sessionId: 'lost-response' } };
    await assert.rejects(provider.create('k8s', options),
      (error: unknown) => error instanceof CellboxError && error.code === 'UNKNOWN_OUTCOME');
    const restarted = new CellboxSandboxProvider({ baseUrl: http.baseUrl, profileId: 'k8s', stateDirectory });
    const recovered = await restarted.create('k8s', options);
    assert(http.boxes.has(recovered.sandboxId));
    assert.equal(http.keys.size, 1);
    const creates = http.calls.filter(call => call.path === '/v1/boxes' && call.method === 'POST');
    assert.equal(creates.length, 2);
    assert.equal(creates[0].key, creates[1].key);
  } finally { await http.close(); await rm(stateDirectory, { recursive: true, force: true }); }
});

test('exec distinguishes a nonzero exit, timeout, and incomplete output', async () => {
  const http = await fixture();
  try {
    const provider = new CellboxSandboxProvider({ baseUrl: http.baseUrl, profileId: 'k8s' });
    const box = await provider.create('k8s', { timeoutMs: 60_000, lifecycle: { onTimeout: 'pause', autoResume: false },
      metadata: { cellboxOwnerKey: 'p', cellboxIdempotencyKey: 'create-p' } });
    http.setExecResult({ stdout: '', stderr: 'bad', exitCode: 7, truncated: false });
    await assert.rejects(box.commands.run('exit 7'), (error: unknown) => (error as { exitCode?: number }).exitCode === 7);
    http.setExecResult({ stdout: '', stderr: '', exitCode: 124, truncated: true });
    await assert.rejects(box.commands.run('sleep 9'),
      (error: unknown) => error instanceof CellboxError && error.code === 'TIMEOUT' && (error as { exitCode?: number }).exitCode === 124);
    http.setExecResult({ stdout: 'partial', stderr: '', exitCode: 0, truncated: true });
    await assert.rejects(box.commands.run('printf output'),
      (error: unknown) => error instanceof CellboxError && error.code === 'OUTPUT_TRUNCATED');
    http.setPending(true);
    http.setExecOperationFails(true);
    http.setExecState('unknown');
    await assert.rejects(box.commands.run('some interrupted work', { idempotencyKey: 'interrupted-key' } as never),
      (error: unknown) => error instanceof CellboxError && error.code === 'UNKNOWN_OUTCOME');
  } finally { await http.close(); }
});

test('archive downloads enforce the streamed byte cap', async () => {
  const http = await fixture();
  try {
    const client = new CellboxClient({ baseUrl: http.baseUrl });
    await assert.rejects(client.downloadArchive('archive-1', 4),
      (error: unknown) => error instanceof CellboxError && error.code === 'INVALID_REQUEST');
  } finally { await http.close(); }
});

test('native file reads preserve binary bytes and reject external paths without exec fallback', async () => {
  const http = await fixture();
  try {
    const provider = new CellboxSandboxProvider({ baseUrl: http.baseUrl, profileId: 'k8s', retryDelayMs: 1 });
    const box = await provider.create('k8s', { timeoutMs: 60_000, lifecycle: { onTimeout: 'pause', autoResume: false },
      metadata: { cellboxOwnerKey: 'p', cellboxIdempotencyKey: 'native-file-test' } });
    const contents = Buffer.from([0, 0xff, 0xfe, 0x80]);
    http.setFileContents(contents);
    assert.deepEqual(Buffer.from(await box.files.readBytes('/workspace/source/file.bin')), contents);
    assert.equal(http.calls.filter(call => call.path.includes('/files?')).length, 1);
    assert.equal(http.calls.find(call => call.path.includes('/files?'))!.path, '/v1/boxes/box-1/files?path=source%2Ffile.bin');
    await assert.rejects(box.files.readBytes('/shared/docs/file.md'), { code: 'FORBIDDEN' });
    await assert.rejects(box.files.readBytes('/workspace/../private/file'), { code: 'INVALID_REQUEST' });
    assert.equal(http.calls.filter(call => call.path.endsWith('/execs')).length, 0);
  } finally { await http.close(); }
});
