import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { AppServerReader } from './app-server-reader.js';

test('real Codex readiness probes reuse the initialized transport without model calls', async () => {
  const home = await mkdtemp(join(tmpdir(), 'cocell-readiness-'));
  const reservation = createServer();
  await new Promise<void>(done => reservation.listen(0, '127.0.0.1', done));
  const address = reservation.address();
  assert(address && typeof address !== 'string');
  await new Promise<void>(done => reservation.close(() => done()));
  const url = `ws://127.0.0.1:${address.port}`;
  const stopped = new AbortController();
  const server = spawn(resolve('node_modules/.bin/codex'), ['app-server', '--listen', url], {
    cwd: home, env: { ...process.env, CODEX_HOME: home }, stdio: ['ignore', 'ignore', 'ignore'],
  });
  server.on('error', error => stopped.abort(error));
  server.on('exit', () => stopped.abort(new Error('Codex App Server exited')));
  let endpoints = 0;
  const reader = new AppServerReader(async () => { endpoints++; return { url }; }, error => { throw error; });
  try {
    await reader.waitUntilReady('local-test', stopped.signal, 10_000);
    const opened = endpoints;
    await reader.waitUntilReady('local-test', stopped.signal, 10_000);
    const threads = await reader.read('local-test', client => client.request('thread/loaded/list', {}), stopped.signal);
    assert.deepEqual(threads.data, []);
    for (const [mode, policy] of [['read-only', 'readOnly'], ['workspace-write', 'workspaceWrite']]) {
      const started = await reader.read('local-test', client => client.request('thread/start',
        { cwd: home, sandbox: mode, approvalPolicy: 'never' }), stopped.signal);
      assert.equal(started.sandbox.type, policy);
      assert.notEqual(started.sandbox.networkAccess, true);
      const history = await reader.read('local-test', client => client.request('thread/read',
        { threadId: started.thread.id, includeTurns: false }), stopped.signal);
      assert.equal(history.thread.id, started.thread.id);
    }
    assert.equal(endpoints, opened, 'verification and first use reuse one connection');
  } finally {
    try { await reader.close(); }
    finally {
      if (server.exitCode === null && server.signalCode === null) {
        const exited = once(server, 'exit');
        const kill = setTimeout(() => server.kill('SIGKILL'), 2_000);
        server.kill('SIGTERM');
        try { await exited; } finally { clearTimeout(kill); }
      }
      await rm(home, { recursive: true, force: true });
    }
  }
});

test('workflow recovery preserves an unknown submission and gates a retry across API instances', async () => {
  const { WorkflowService } = await import('../workflows/service.js');
  const { MemoryWorkflowStore } = await import('../testing/memory-workflow-store.js');
  const { MemoryCoordinator } = await import('../infra/storage/coordination.js');
  const { randomUUID } = await import('node:crypto');
  const store = new MemoryWorkflowStore();
  const coordinator = new MemoryCoordinator();
  const projectId = randomUUID();
  let sent = 0,
    input = '',
    showHistory = false;
  const threadId = randomUUID(),
    turnId = randomUUID();
  type Driver = ConstructorParameters<typeof WorkflowService>[1];
  const manager = {
    async readProject() {
      return {
        id: projectId,
        status: 'active',
        executionMode: 'sandbox',
        workingDirectory: '/workspace',
        sandbox: { id: 'box', status: 'ready' },
      };
    },
    async ensureWorkflowSession() {},
    async prepareWorkflowThread() {
      return threadId;
    },
    async submitWorkflowTurn(
      _id: string,
      _thread: string,
      prompt: string,
      _schema: unknown,
      guard: () => Promise<void>
    ) {
      await guard();
      sent++;
      input = prompt;
      throw Error('ACK lost');
    },
    async read() {
      return {
        threadId,
        turns: showHistory
          ? [{ id: turnId, status: 'running', startedAt: new Date().toISOString(), prompt: input }]
          : [],
      };
    },
  } as unknown as Driver;
  const unexpected = () => assert.fail('Read-only recovery must not run workspace commands');
  const validator = { fingerprint: unexpected, startValidation: unexpected, observe: unexpected };
  const api = () =>
    new WorkflowService(
      store,
      manager,
      validator,
      async () => ({ model: 'model' }),
      coordinator,
      (error) => assert.fail(String(error))
    );
  const { id } = await api().create({
    projectId,
    clientRequestId: randomUUID(),
    requirement: 'x',
    parallelism: 2,
  });
  await Promise.all([api().runPending(), api().runPending()]);
  let run = await api().get(id);
  assert.equal(run.jobs[0].attempts[0].status, 'unknown');
  assert.equal(run.jobs[0].attempts[0].planHash, undefined);
  const action = { kind: 'pause' as const, expectedRevision: run.revision, clientRequestId: randomUUID() };
  assert.deepEqual(await api().act(id, action), await api().act(id, action));
  await assert.rejects(api().act(id, { ...action, kind: 'cancel' }), /幂等键/);
  await assert.rejects(
    api().act(id, {
      kind: 'retry',
      jobId: run.jobs[0].id,
      clientRequestId: randomUUID(),
      expectedRevision: run.revision + 1,
    }),
    /旧尝试/
  );
  await api().runPending();
  showHistory = true;
  await api().runPending();
  run = await api().get(id);
  assert.equal(run.status, 'paused');
  assert.equal(run.jobs[0].attempts[0].turnId, turnId);
  assert.equal(run.jobs[0].attempts[0].status, 'running');
  assert.equal(sent, 1);
});

test('workflow plans reject concurrent ownership, cycles and an escaping validation cwd', async () => {
  const { validatePlan } = await import('../../packages/workflow/src/index.js');
  const make = (
    key: string,
    role: 'worker' | 'integration' | 'verifier',
    dependsOn: string[],
    ownedPaths: string[]
  ) => ({
    key,
    role,
    dependsOn,
    ownedPaths,
    readPaths: [],
    description: key,
    acceptance: 'check',
    validation: { argv: ['pnpm', 'typecheck'], cwd: '.', outputPaths: [], timeoutMs: 3000 },
  });
  const tasks = [
    make('one', 'worker', [], ['src/a']),
    make('two', 'worker', [], ['src/ab']),
    make('merge', 'integration', ['one', 'two'], []),
    make('verify', 'verifier', ['merge'], []),
  ];
  const plan = {
    design: 'design',
    alternatives: 'other',
    publicContracts: [],
    risks: 'risk',
    reviewDecisions: 'review',
    tasks,
  };
  assert.deepEqual(validatePlan(plan), plan);
  tasks[1].ownedPaths = ['src/a/child'];
  assert.throws(() => validatePlan(plan), /冲突/);
  tasks[1].ownedPaths = ['src/b'];
  tasks[0].dependsOn = ['merge'];
  assert.throws(() => validatePlan(plan), /成环/);
  tasks[0].dependsOn = [];
  tasks[0].validation.cwd = '../outside';
  assert.throws(() => validatePlan(plan), /无效项目路径/);
});

test('managed native relay rejects writes and keeps asynchronous admission in frame order', async () => {
  const { createNativeRelay } = await import('./native-relay.js');
  const { createServer: httpServer } = await import('node:http');
  const { WebSocketServer, WebSocket } = await import('ws');
  const upstream = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(upstream, 'listening');
  const address = upstream.address();
  assert(address && typeof address !== 'string');
  const methods: string[] = [];
  upstream.on('connection', (socket) =>
    socket.on('message', (data) => {
      const { method, id } = JSON.parse(data.toString());
      methods.push(method);
      socket.send(JSON.stringify({ id, result: {} }));
    })
  );
  const server = httpServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const bound = server.address();
  assert(bound && typeof bound !== 'string');
  const publicUrl = 'http://127.0.0.1:' + bound.port,
    token = 'isolated-relay-test';
  const relay = createNativeRelay({
    publicUrl,
    token,
    open: async (id) => ({
      url: 'ws://127.0.0.1:' + address.port,
      managed: id === 'managed',
      threadId: id,
      release: async () => {},
    }),
    canRenew: async () => true,
    isWorkflowThread: async (id) => {
      await new Promise((r) => setTimeout(r, 10));
      return id === 'managed';
    },
    onError: (error) => assert.fail(String(error)),
  });
  server.on(
    'upgrade',
    (request, socket, head) => void relay.upgrade(request, socket as import('node:net').Socket, head)
  );
  const sockets: import('ws').WebSocket[] = [];
  async function connect(id: string) {
    const ws = new WebSocket(publicUrl.replace('http:', 'ws:') + '/api/sessions/' + id + '/app-server', {
      headers: { Authorization: 'Bearer ' + token, Origin: publicUrl },
    });
    sockets.push(ws);
    await once(ws, 'open');
    return ws;
  }
  function send(ws: import('ws').WebSocket, method: string, id: number, threadId: string) {
    ws.send(JSON.stringify({ method, id, params: { threadId } }));
  }
  try {
    const managed = await connect('managed');
    let reply = once(managed, 'message');
    send(managed, 'turn/start', 1, 'managed');
    assert.equal(JSON.parse((await reply)[0].toString()).error.code, -32003);
    reply = once(managed, 'message');
    send(managed, 'thread/read', 2, 'managed');
    await reply;
    const ordinary = await connect('ordinary');
    const received: number[] = [];
    const done = new Promise<void>((resolve) =>
      ordinary.on('message', (data) => {
        const response = JSON.parse(data.toString());
        received.push(response.id);
        if (response.id === 3) assert.equal(response.error.code, -32003);
        if (received.length === 3) resolve();
      })
    );
    send(ordinary, 'turn/steer', 3, 'managed');
    send(ordinary, 'turn/start', 4, 'other');
    send(ordinary, 'thread/read', 5, 'ordinary');
    await done;
    assert.deepEqual(received, [3, 4, 5]);
    assert.deepEqual(methods, ['thread/read', 'turn/start', 'thread/read']);
  } finally {
    for (const ws of sockets) ws.close();
    await relay.close();
    await new Promise<void>((done) => server.close(() => done()));
    await new Promise<void>((done) => upstream.close(() => done()));
  }
});
