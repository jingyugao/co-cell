import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { trace } from '@opentelemetry/api';
import { traced } from '@co-cell/sandbox';
import { MemoryCoordinator, MySqlCoordinator } from './coordination.js';

const wait = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));

test('MySQL coordination traces only connection acquisition and keeps the borrowed callback under its caller', async () => {
  const exporter = new InMemorySpanExporter();
  const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  provider.register();
  const coordinator = new MySqlCoordinator('mysql://user:secret@db.example.test/cocell', {
    connectionFactory: async () => ({
      async query(sql) {
        if (sql.includes('GET_LOCK')) return [[{ acquired: 1 }], []];
        if (sql.includes('RELEASE_LOCK')) return [[{ released: 1 }], []];
        throw new Error('unexpected query');
      },
      async end() {},
    }),
  });
  try {
    let callbackParent: string | undefined;
    await traced('project.control_lock', { 'project.id': 'project-1' },
      () => coordinator.run('project-control:project-1', async () => {
        callbackParent = trace.getActiveSpan()?.spanContext().spanId;
      }));
    const spans = exporter.getFinishedSpans();
    const control = spans.find(span => span.name === 'project.control_lock');
    assert(control);
    assert.equal(callbackParent, control.spanContext().spanId);
    const acquire = spans.find(span => span.name === 'coordination.mysql.connection.acquire');
    assert(acquire, 'missing connection acquisition span');
    assert.equal(acquire.parentSpanContext?.spanId, control.spanContext().spanId);
    assert.equal(acquire.spanContext().traceId, control.spanContext().traceId);
    assert.equal(acquire.attributes['coordination.lock.scope'], 'project-control');
    assert.equal(JSON.stringify(acquire.attributes).includes('project-1'), false);
    assert.deepEqual(spans.map(span => span.name).sort(), ['coordination.mysql.connection.acquire', 'project.control_lock']);
  } finally {
    await coordinator.close();
    await provider.shutdown();
  }
});

test('MySQL coordinator reuses an idle connection but pins simultaneous leases separately', async () => {
  let created = 0;
  let lockOwners = 0;
  const coordinator = new MySqlCoordinator('mysql://user:secret@db.example.test/cocell', {
    connectionFactory: async () => {
      const connectionId = ++created;
      return {
        async query(sql) {
          if (sql.includes('GET_LOCK')) { lockOwners++; return [[{ acquired: 1 }], []]; }
          if (sql.includes('RELEASE_LOCK')) { lockOwners--; return [[{ released: 1 }], []]; }
          if (sql.includes('IS_USED_LOCK')) return [[{ owner_id: connectionId, connection_id: connectionId }], []];
          throw new Error('unexpected query');
        },
        async end() {},
      };
    },
  });
  try {
    const first = await coordinator.tryAcquire('project:reuse-1');
    assert.ok(first);
    await first.release();
    const second = await coordinator.tryAcquire('project:reuse-2');
    assert.ok(second);
    assert.equal(created, 1, 'a confirmed release returns the dedicated connection to the idle pool');
    await second.release();

    const [left, right] = await Promise.all([
      coordinator.tryAcquire('project:parallel-1'), coordinator.tryAcquire('project:parallel-2'),
    ]);
    assert.ok(left && right);
    assert.equal(created, 2, 'an in-use connection is never shared with another lease');
    assert.equal(lockOwners, 2);
    await Promise.all([left.release(), right.release()]);
  } finally { await coordinator.close(); }
});

test('MySQL coordinator destroys connections when RELEASE_LOCK ownership is uncertain', async () => {
  let created = 0;
  let destroyed = 0;
  const coordinator = new MySqlCoordinator('mysql://user:secret@db.example.test/cocell', {
    connectionFactory: async () => {
      created++;
      let releaseCount = 0;
      return {
        async query(sql) {
          if (sql.includes('GET_LOCK')) return [[{ acquired: 1 }], []];
          if (sql.includes('RELEASE_LOCK')) { releaseCount++; return [[{ released: releaseCount === 1 ? 0 : 1 }], []]; }
          throw new Error('unexpected query');
        },
        destroy() { destroyed++; },
        async end() {},
      };
    },
  });
  try {
    const lease = await coordinator.tryAcquire('project:uncertain-release');
    assert.ok(lease);
    await lease.release();
    assert.equal(destroyed, 1);
    const next = await coordinator.tryAcquire('project:after-uncertain-release');
    assert.ok(next);
    assert.equal(created, 2, 'an uncertain connection is not reused');
    await next.release();
  } finally { await coordinator.close(); }
});

test('MySQL coordinator close drains a connection factory acquisition already in flight', async () => {
  let startFactory!: () => void;
  let finishFactory!: (value: Awaited<CoordinatorFactoryResult>) => void;
  type CoordinatorFactoryResult = ReturnType<import('./coordination.js').CoordinatorConnectionFactory>;
  const started = new Promise<void>(resolve => { startFactory = resolve; });
  let ended = 0;
  const coordinator = new MySqlCoordinator('mysql://user:secret@db.example.test/cocell', {
    connectionFactory: () => {
      startFactory();
      return new Promise(resolve => { finishFactory = resolve; });
    },
  });
  const acquisition = coordinator.tryAcquire('project:close-pending');
  await started;
  const closing = coordinator.close();
  finishFactory({ async query() { throw new Error('closed before GET_LOCK'); }, async end() { ended++; } });
  await Promise.all([closing, acquisition.catch(() => undefined)]);
  assert.equal(ended, 1);
});

test('MySQL coordinator close disposes a reused connection blocked in GET_LOCK', async () => {
  let getLockCalls = 0;
  let destroyCount = 0;
  let endCount = 0;
  let signalBlocked!: () => void;
  let resolveBlocked!: (result: [unknown, unknown]) => void;
  const blocked = new Promise<void>(resolve => { signalBlocked = resolve; });
  const coordinator = new MySqlCoordinator('mysql://user:secret@db.example.test/cocell', {
    connectionFactory: async () => ({
      async query(sql) {
        if (sql.includes('GET_LOCK')) {
          getLockCalls++;
          if (getLockCalls === 1) return [[{ acquired: 1 }], []];
          signalBlocked();
          return new Promise(resolve => { resolveBlocked = resolve; });
        }
        if (sql.includes('RELEASE_LOCK')) return [[{ released: 1 }], []];
        throw new Error('unexpected query');
      },
      destroy() { destroyCount++; },
      async end() { endCount++; },
    }),
  });
  const first = await coordinator.tryAcquire('project:reuse-close-first');
  assert.ok(first);
  await first.release();
  const acquisition = coordinator.tryAcquire('project:reuse-close-blocked');
  await blocked;

  await coordinator.close();
  assert.equal(destroyCount, 1, 'close destroys the reused socket while its lock query is still pending');
  assert.equal(endCount, 1);
  resolveBlocked([[{ acquired: 1 }], []]);
  await assert.rejects(acquisition, /Unable to acquire the coordination lock/);
  await assert.rejects(coordinator.tryAcquire('project:after-close'), /Coordinator is closed/);
});

test('memory coordination serializes callers and supports scoped reentrancy', async () => {
  const coordinator = new MemoryCoordinator();
  const order: string[] = [];
  let releaseFirst!: () => void;
  const gate = new Promise<void>(resolve => { releaseFirst = resolve; });
  const first = coordinator.run('project:1', async () => {
    order.push('first-start');
    await coordinator.run('project:1', async () => { order.push('nested'); });
    await gate;
    order.push('first-end');
  });
  await wait(0);
  const second = coordinator.run('project:1', async () => { order.push('second'); });
  await wait(0);
  assert.deepEqual(order, ['first-start', 'nested']);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(order, ['first-start', 'nested', 'first-end', 'second']);
  await coordinator.close();
});

test('memory tryRun is reentrant, nonblocking under contention, and releases after failures', async () => {
  const coordinator = new MemoryCoordinator();
  let nestedCalls = 0;
  const nested = await coordinator.run('project:try-run', async () =>
    coordinator.tryRun('project:try-run', async () => { nestedCalls++; return 'nested'; }));
  assert.deepEqual(nested, { value: 'nested' });
  assert.equal(nestedCalls, 1);

  let releaseOwner!: () => void;
  const ownerGate = new Promise<void>(resolve => { releaseOwner = resolve; });
  const owner = coordinator.run('project:try-run', async () => ownerGate);
  await wait(0);
  let ranUnderContention = false;
  assert.equal(await coordinator.tryRun('project:try-run', async () => { ranUnderContention = true; }), null);
  assert.equal(ranUnderContention, false);
  releaseOwner();
  await owner;

  await assert.rejects(coordinator.tryRun('project:try-run', async () => { throw new Error('action failed'); }), /action failed/);
  assert.deepEqual(await coordinator.tryRun('project:try-run', async () => 'after failure'), { value: 'after failure' });
  await coordinator.close();
});

test('MySQL tryRun shares reentrancy, contention, and failure cleanup semantics', async () => {
  let owner = false;
  let created = 0;
  const coordinator = new MySqlCoordinator('mysql://user:secret@db.example.test/cocell', {
    connectionFactory: async () => {
      created++;
      return {
        async query(sql) {
          if (sql.includes('GET_LOCK')) {
            if (owner) return [[{ acquired: 0 }], []];
            owner = true;
            return [[{ acquired: 1 }], []];
          }
          if (sql.includes('RELEASE_LOCK')) { owner = false; return [[{ released: 1 }], []]; }
          if (sql.includes('IS_USED_LOCK')) return [[{ owner_id: 1, connection_id: 1 }], []];
          throw new Error('unexpected query');
        },
        async end() {},
      };
    },
  });
  try {
    let nestedCalls = 0;
    const nested = await coordinator.run('project:try-run', async () =>
      coordinator.tryRun('project:try-run', async () => { nestedCalls++; return 'nested'; }));
    assert.deepEqual(nested, { value: 'nested' });
    assert.equal(nestedCalls, 1);
    assert.equal(created, 1, 'reentrant tryRun uses the enclosing connection lease');

    const held = await coordinator.tryAcquire('project:try-run');
    assert.ok(held);
    let ranUnderContention = false;
    assert.equal(await coordinator.tryRun('project:try-run', async () => { ranUnderContention = true; }), null);
    assert.equal(ranUnderContention, false);
    await held.release();

    await assert.rejects(coordinator.tryRun('project:try-run', async () => { throw new Error('action failed'); }), /action failed/);
    assert.deepEqual(await coordinator.tryRun('project:try-run', async () => 'after failure'), { value: 'after failure' });
  } finally { await coordinator.close(); }
});

test('detached async context reacquires after its lease is normally released', async () => {
  const coordinator = new MemoryCoordinator();
  let detached!: Promise<void>;
  let actions = 0;
  await coordinator.run('project:1', async () => {
    detached = new Promise<void>((resolve, reject) => setTimeout(() => {
      coordinator.run('project:1', async () => { actions++; }).then(resolve, reject);
    }, 0));
  });
  await detached;
  assert.equal(actions, 1);
  await coordinator.close();
});

test('memory coordination wakes every queued caller after release', async () => {
  const coordinator = new MemoryCoordinator();
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
  let entered = 0;
  const first = coordinator.run('project:many', async () => { await firstGate; entered++; });
  await wait(0);
  const rest = Array.from({ length: 5 }, () => coordinator.run('project:many', async () => { entered++; }));
  await wait(10);
  releaseFirst();
  try {
    await Promise.race([Promise.all([first, ...rest]), wait(300).then(() => { throw new Error('queued callers did not finish'); })]);
    assert.equal(entered, 6);
  } finally { await coordinator.close(); }
});

test('MySQL lease loss aborts holders and closes the dedicated connection', async () => {
  let failHeartbeat = false;
  let ended = false;
  let connectionId = 42;
  const coordinator = new MySqlCoordinator('mysql://user:secret@db.example.test/cocell', {
    heartbeatMs: 10,
    connectionFactory: async () => ({
      async query(sql) {
        if (sql.includes('GET_LOCK')) return [[{ acquired: 1 }], []];
        if (sql.includes('IS_USED_LOCK')) {
          if (failHeartbeat) throw new Error('transport detail must not leak');
          return [[{ owner_id: connectionId, connection_id: connectionId }], []];
        }
        if (sql.includes('RELEASE_LOCK')) return [[{ released: 1 }], []];
        throw new Error('unexpected query');
      },
      async end() { ended = true; },
    }),
  });
  const lease = await coordinator.tryAcquire('project:1');
  assert.ok(lease);
  failHeartbeat = true;
  for (let attempt = 0; attempt < 50 && !lease.signal.aborted; attempt++) await wait(5);
  assert.equal(lease.signal.aborted, true);
  assert.throws(() => lease.assertHeld(), /Coordination lease connection was lost/);
  for (let attempt = 0; attempt < 50 && !ended; attempt++) await wait(5);
  assert.equal(ended, true);
  await coordinator.close();
});

test('a stalled MySQL heartbeat times out and promptly aborts its lease', async () => {
  let ended = false;
  let destroyed = false;
  const coordinator = new MySqlCoordinator('mysql://user:secret@db.example.test/cocell', {
    heartbeatMs: 10, heartbeatTimeoutMs: 20,
    connectionFactory: async () => ({
      async query(sql) {
        if (sql.includes('GET_LOCK')) return [[{ acquired: 1 }], []];
        if (sql.includes('IS_USED_LOCK')) return new Promise(() => {});
        throw new Error('unexpected query');
      },
      destroy() { destroyed = true; },
      async end() { ended = true; },
    }),
  });
  const lease = await coordinator.tryAcquire('project:stalled');
  assert.ok(lease);
  for (let attempt = 0; attempt < 50 && !lease.signal.aborted; attempt++) await wait(5);
  assert.equal(lease.signal.aborted, true);
  assert.throws(() => lease.assertHeld(), /Coordination lease connection was lost/);
  assert.equal(destroyed, true);
  for (let attempt = 0; attempt < 50 && !ended; attempt++) await wait(5);
  assert.equal(ended, true);
  await coordinator.close();
});

test('MySQL run rejects an action result if its lease was lost before completion', async () => {
  let checks = 0;
  const coordinator = new MySqlCoordinator('mysql://user:secret@db.example.test/cocell', {
    heartbeatMs: 10, heartbeatTimeoutMs: 30,
    connectionFactory: async () => ({
      async query(sql) {
        if (sql.includes('GET_LOCK')) return [[{ acquired: 1 }], []];
        if (sql.includes('IS_USED_LOCK')) {
          checks++;
          return [[{ owner_id: 1, connection_id: 2 }], []];
        }
        throw new Error('unexpected query');
      },
      async end() {},
    }),
  });
  await assert.rejects(coordinator.run('project:completion', async () => {
    await wait(50);
    return 'late result';
  }), /Coordination lease was lost/);
  assert.ok(checks > 0);
  await coordinator.close();
});
