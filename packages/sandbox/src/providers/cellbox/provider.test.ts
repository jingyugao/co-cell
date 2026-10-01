import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import test from 'node:test';
import { CellboxClient, CellboxError } from './client.js';
import { CellboxSandboxProvider } from './provider.js';

const capabilities = { exec: true, files: true, http: true, websocket: true, pty: false,
  reconnectExec: false, freeze: false, suspend: 'same-node-checkpoint', archives: 'workspace-best-effort', protectedTools: false };

async function fixture() {
  const calls: Array<{ method: string; path: string; key?: string; body: unknown }> = [];
  const boxes = new Map<string, Record<string, unknown>>();
  const keys = new Map<string, string>();
  let counter = 0;
  let fileContents: Buffer = Buffer.from('content');
  let profileProvider = 'resumable-k8s-pod';
  let pending = false;
  let execResult = { stdout: '', stderr: '', exitCode: 0, truncated: false };
  let execOperationFails = false;
  let execState: 'exited' | 'unknown' = 'exited';
  const json = (res: ServerResponse, status: number, value: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value));
  };
  const op = (kind: string, targetId: string, result: Record<string, string> = {}) =>
    ({ id: `op-${++counter}`, kind, targetId, status: pending ? 'running' : 'succeeded', version: 1,
      createdAt: new Date().toISOString(), result });
  const operations = new Map<string, ReturnType<typeof op>>();
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    if (req.headers.authorization !== 'Bearer test-client-token') { json(res, 401, { error: { code: 'UNAUTHENTICATED', message: 'Invalid token' } }); return; }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString();
    const body = raw && req.headers['content-type'] === 'application/json' ? JSON.parse(raw) : raw;
    const url = new URL(req.url!, 'http://localhost');
    calls.push({ method: req.method!, path: url.pathname + url.search, key: req.headers['idempotency-key'] as string | undefined, body });
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
    const boxMatch = url.pathname.match(/^\/v1\/boxes\/(box-[^/:]+)(?::(suspend|resume|destroy))?$/);
    if (boxMatch) {
      const box = boxes.get(boxMatch[1]);
      if (!box) { json(res, 404, { error: { code: 'NOT_FOUND', message: 'Missing box' } }); return; }
      if (req.method === 'GET') { json(res, 200, box); return; }
      if (boxMatch[2]) {
        const action = boxMatch[2];
        box.phase = action === 'suspend' ? 'suspended' : action === 'resume' ? 'running' : 'deleted';
        if (action === 'resume') box.generation = (box.generation as number) + 1;
        const value = op(action, boxMatch[1], { boxId: boxMatch[1] }); operations.set(value.id, value); json(res, 202, value); return;
      }
    }
    const execMatch = url.pathname.match(/^\/v1\/boxes\/(box-[^/]+)\/execs$/);
    if (execMatch) {
      const value = op('exec', execMatch[1], { execId: `exec-${counter + 1}` });
      operations.set(value.id, value); json(res, 202, value); return;
    }
    if (url.pathname.startsWith('/v1/operations/')) {
      const value = operations.get(url.pathname.split('/').at(-1)!);
      if (value?.status === 'running') {
        value.status = value.kind === 'exec' && execOperationFails ? 'failed' : 'succeeded';
        if (value.status === 'failed') (value as typeof value & { error?: { code: string; message: string } }).error = { code: 'TIMEOUT', message: 'runtime deadline' };
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
    if (url.pathname === '/v1/routes/route-1/grants') { json(res, 201, { grant: { id: 'grant-1', routeId: 'route-1',
      subject: (body as { subject: string }).subject, expiresAt: new Date(Date.now() + 30_000).toISOString(), revoked: false },
      token: 'grant-secret' }); return; }
    if (url.pathname === '/v1/grants/grant-1' && req.method === 'PATCH') {
      json(res, 200, { id: 'grant-1', routeId: 'route-1', subject: 'product-user',
        expiresAt: new Date(Date.now() + 60_000).toISOString(), revoked: false }); return;
    }
    if (url.pathname === '/v1/grants/grant-1') { res.writeHead(204); res.end(); return; }
    if (url.pathname === '/v1/archives/archive-1/content') {
      res.writeHead(200, { 'Content-Type': 'application/gzip' }); res.write('abc'); res.end('def'); return;
    }
    json(res, 404, { error: { code: 'NOT_FOUND', message: 'Missing endpoint' } });
  };
  const server = createServer((req, res) => { void handle(req, res).catch(error => { res.writeHead(500); res.end(String(error)); }); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert(address && typeof address !== 'string');
  return { baseUrl: `http://127.0.0.1:${address.port}`, calls, boxes, keys,
    setProfileProvider(value: string) { profileProvider = value; },
    setFileContents(value: Buffer) { fileContents = value; },
    setPending(value: boolean) { pending = value; },
    setExecResult(value: typeof execResult) { execResult = value; },
    setExecOperationFails(value: boolean) { execOperationFails = value; },
    setExecState(value: 'exited' | 'unknown') { execState = value; },
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}

test('auth, Kubernetes profile validation, and durable create key adoption', async () => {
  const http = await fixture();
  const stateDirectory = await mkdtemp(join(tmpdir(), 'cellbox-adapter-'));
  try {
    const bad = new CellboxClient({ baseUrl: http.baseUrl, token: 'wrong' });
    await assert.rejects(bad.listProfiles(), (error: unknown) => error instanceof CellboxError && error.code === 'UNAUTHENTICATED');
    const provider = new CellboxSandboxProvider({ baseUrl: http.baseUrl, token: 'test-client-token', profileId: 'k8s',
      workspace: '/workspace', stateDirectory, pollIntervalMs: 1 });
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
    assert.equal(http.keys.size, 1);
    await provider.kill(first.sandboxId);
    const third = await provider.create('k8s', options);
    assert.notEqual(third.sandboxId, first.sandboxId);
    assert.equal(http.keys.size, 2);
    await provider.client.writeCredential(third.sandboxId, 'glab_token', Buffer.from('secret'));
    assert(http.calls.some(call => call.path.endsWith('/credentials/glab_token') && call.body === 'secret'));
    http.boxes.delete(third.sandboxId);
    const fourth = await provider.create('k8s', options);
    assert.notEqual(fourth.sandboxId, third.sandboxId);
    http.boxes.get(fourth.sandboxId)!.phase = 'failed';
    http.boxes.get(fourth.sandboxId)!.operationId = 'op-still-pending';
    await assert.rejects(provider.create('k8s', options), (error: unknown) => error instanceof CellboxError && error.code === 'CONFLICT');
    assert.equal(http.keys.size, 3, 'an active or uncertain operation must keep its original create key');
    delete http.boxes.get(fourth.sandboxId)!.operationId;
    const retry = await provider.create('k8s', options);
    assert.notEqual(retry.sandboxId, fourth.sandboxId);
    assert.equal(http.keys.size, 4, 'a terminally failed creation can be retried with a new key');
  } finally { await http.close(); await rm(stateDirectory, { recursive: true, force: true }); }
});

test('exec checks generation, shell quotes outside-workspace paths, and does not offer cancellation', async () => {
  const http = await fixture();
  try {
    const provider = new CellboxSandboxProvider({ baseUrl: http.baseUrl, token: 'test-client-token', profileId: 'k8s', pollIntervalMs: 1 });
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
    await provider.connect(box.sandboxId);
    const access = await provider.getServiceAccess(box.sandboxId, 3000, 'product-user', 60);
    assert.equal(access.url, `${http.baseUrl}/s/route-1/`);
    assert.equal(await box.getServiceUrl!(3000), 'https://route-1.example.test/');
    assert.equal(access.headers.Authorization, 'Bearer grant-secret');
    assert.match(await access.renew(60), /^\d{4}-/);
    await access.revoke();
    assert(http.calls.some(call => call.path === '/v1/grants/grant-1' && call.method === 'DELETE'));
  } finally { await http.close(); }
});

test('a lost mutation response reports unknown outcome without replay', async () => {
  let requests = 0;
  const client = new CellboxClient({ baseUrl: 'http://127.0.0.1:1', token: 'secret',
    fetch: async () => { requests++; throw new Error('socket reset'); } });
  await assert.rejects(client.createBox({ profileId: 'k8s', ownerKey: 'p' }, 'durable-key'),
    (error: unknown) => error instanceof CellboxError && error.code === 'UNKNOWN_OUTCOME' && error.idempotencyKey === 'durable-key');
  assert.equal(requests, 1);
});

test('admitted tool HTTP deadline covers its execution timeout', async () => {
  const client = new CellboxClient({ baseUrl: 'http://127.0.0.1:1', token: 'secret', requestTimeoutMs: 1,
    fetch: async (_input, init) => {
      await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal(init?.signal?.aborted, false);
      return Response.json({ stdout: 'done', stderr: '', exitCode: 0 });
    } });
  assert.equal((await client.runTool('box', 'archive', [], 50)).stdout, 'done');
});

test('malformed mutation responses preserve uncertain outcomes and HTTP errors retain codes', async () => {
  const broken = new CellboxClient({ baseUrl: 'http://127.0.0.1:1', token: 'secret',
    fetch: async () => new Response('{', { status: 202, headers: { 'Content-Type': 'application/json' } }) });
  await assert.rejects(broken.createBox({ profileId: 'k8s', ownerKey: 'p' }, 'same-key'),
    (error: unknown) => error instanceof CellboxError && error.code === 'UNKNOWN_OUTCOME' && error.idempotencyKey === 'same-key');
  const conflict = new CellboxClient({ baseUrl: 'http://127.0.0.1:1', token: 'secret',
    fetch: async () => new Response('broken', { status: 409 }) });
  await assert.rejects(conflict.createBox({ profileId: 'k8s', ownerKey: 'p' }, 'same-key'),
    (error: unknown) => error instanceof CellboxError && error.code === 'CONFLICT' && error.status === 409);
});

test('create reuses a journaled key after the HTTP response is lost', async () => {
  const http = await fixture();
  const stateDirectory = await mkdtemp(join(tmpdir(), 'cellbox-lost-create-'));
  try {
    let dropped = false;
    const provider = new CellboxSandboxProvider({ baseUrl: http.baseUrl, token: 'test-client-token', profileId: 'k8s',
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
    const restarted = new CellboxSandboxProvider({ baseUrl: http.baseUrl, token: 'test-client-token', profileId: 'k8s', stateDirectory });
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
    const provider = new CellboxSandboxProvider({ baseUrl: http.baseUrl, token: 'test-client-token', profileId: 'k8s' });
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
    const client = new CellboxClient({ baseUrl: http.baseUrl, token: 'test-client-token' });
    await assert.rejects(client.downloadArchive('archive-1', 4),
      (error: unknown) => error instanceof CellboxError && error.code === 'INVALID_REQUEST');
  } finally { await http.close(); }
});

test('native file reads preserve binary bytes and reject external paths without exec fallback', async () => {
  const http = await fixture();
  try {
    const provider = new CellboxSandboxProvider({ baseUrl: http.baseUrl, token: 'test-client-token', profileId: 'k8s', pollIntervalMs: 1 });
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
