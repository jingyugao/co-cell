import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { createConnection } from 'mysql2/promise';
import { context, ROOT_CONTEXT } from '@opentelemetry/api';
import { traced } from '@co-cell/sandbox';

export interface SharedLease {
  readonly signal: AbortSignal;
  assertHeld(): void;
  release(): Promise<void>;
}

export interface SharedCoordinator {
  run<T>(key: string, action: () => Promise<T>): Promise<T>;
  tryRun<T>(key: string, action: () => Promise<T>): Promise<{ value: T } | null>;
  tryAcquire(key: string): Promise<SharedLease | null>;
  close(): Promise<void>;
}

type QueryConnection = {
  query(sql: string, values?: unknown[]): Promise<[unknown, unknown]>;
  end(): Promise<void>;
  destroy?(): void;
};
export type CoordinatorConnectionFactory = () => Promise<QueryConnection>;

type ActiveLease = {
  key: string;
  signal: AbortSignal;
  controller: AbortController;
  assertHeld(): void;
  release(): Promise<void>;
};
type RunContext = Map<string, ActiveLease>;

const sleep = (milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds));

function validateKey(key: string) {
  if (!key || key.length > 1024 || /[\x00-\x1f\x7f]/.test(key)) throw new Error('Invalid coordination key');
}

function databaseName(mysqlUrl: string): string {
  let parsed: URL;
  try { parsed = new URL(mysqlUrl); } catch { throw new Error('MYSQL_URL must be a valid mysql:// URL'); }
  if (parsed.protocol !== 'mysql:' || !parsed.hostname || parsed.pathname.length < 2) {
    throw new Error('MYSQL_URL must be a valid mysql:// URL with a host and database name');
  }
  return decodeURIComponent(parsed.pathname.slice(1));
}

/** MySQL named locks are connection-scoped and shared by all API processes. */
export class MySqlCoordinator implements SharedCoordinator {
  private static readonly maxIdleConnections = 4;
  private readonly database: string;
  private readonly context = new AsyncLocalStorage<RunContext>();
  private readonly leases = new Set<ActiveLease>();
  private readonly leaseConnections = new Map<ActiveLease, QueryConnection>();
  private readonly idleConnections: QueryConnection[] = [];
  private readonly acquiringConnections = new Set<QueryConnection>();
  private readonly pendingAcquisitions = new Set<Promise<unknown>>();
  private readonly disposedConnections = new WeakSet<object>();
  private closed = false;
  private closing?: Promise<void>;

  constructor(mysqlUrl: string, private readonly options: {
    connectionFactory?: CoordinatorConnectionFactory;
    waitSeconds?: number;
    heartbeatMs?: number;
    heartbeatTimeoutMs?: number;
  } = {}) {
    this.database = databaseName(mysqlUrl);
    if (options.waitSeconds !== undefined && (!Number.isInteger(options.waitSeconds) || options.waitSeconds < 1 || options.waitSeconds > 60))
      throw new Error('waitSeconds must be an integer from 1 to 60');
    if (options.heartbeatMs !== undefined && (!Number.isFinite(options.heartbeatMs) || options.heartbeatMs < 10))
      throw new Error('heartbeatMs must be at least 10ms');
    if (options.heartbeatTimeoutMs !== undefined && (!Number.isFinite(options.heartbeatTimeoutMs) || options.heartbeatTimeoutMs < 10))
      throw new Error('heartbeatTimeoutMs must be at least 10ms');
    const factory = options.connectionFactory ?? (() => createConnection(mysqlUrl));
    this.connectionFactory = factory;
  }

  private readonly connectionFactory: CoordinatorConnectionFactory;
  private lockName(key: string) {
    validateKey(key);
    return createHash('sha256').update(`${this.database}\0${key}`).digest('hex');
  }

  private async checkout(key: string): Promise<{ connection: QueryConnection; reused: boolean }> {
    if (this.closed) throw new Error('Coordinator is closed');
    const idle = this.idleConnections.pop();
    if (idle) {
      this.acquiringConnections.add(idle);
      return { connection: idle, reused: true };
    }
    const attributes = {
      'coordination.lock.scope': key.split(':', 1)[0] ?? 'unknown',
      'coordination.connection.reused': false,
    };
    return traced('coordination.mysql.connection.acquire', attributes, async () => {
      const pending = this.connectionFactory().then(async connection => {
        if (this.closed) {
          await this.dispose(connection);
          throw new Error('Coordinator is closed');
        }
        this.acquiringConnections.add(connection);
        return connection;
      });
      this.pendingAcquisitions.add(pending);
      try { return { connection: await pending, reused: false }; }
      finally { this.pendingAcquisitions.delete(pending); }
    });
  }

  private async dispose(connection: QueryConnection) {
    if (this.disposedConnections.has(connection)) return;
    this.disposedConnections.add(connection);
    const idleIndex = this.idleConnections.indexOf(connection);
    if (idleIndex >= 0) this.idleConnections.splice(idleIndex, 1);
    this.acquiringConnections.delete(connection);
    try { connection.destroy?.(); } catch { /* The physical close is best effort; end still runs. */ }
    await connection.end().catch(() => {});
  }

  private async returnConnection(connection: QueryConnection, reusable: boolean) {
    this.acquiringConnections.delete(connection);
    if (reusable && !this.closed && this.idleConnections.length < MySqlCoordinator.maxIdleConnections) {
      this.idleConnections.push(connection);
      return;
    }
    await this.dispose(connection);
  }

  async tryAcquire(key: string): Promise<SharedLease | null> {
    return this.acquire(key, 0);
  }

  private async acquire(key: string, waitSeconds: number): Promise<SharedLease | null> {
    if (this.closed) throw new Error('Coordinator is closed');
    const lock = this.lockName(key);
    let connection: QueryConnection;
    try { connection = (await this.checkout(key)).connection; }
    catch { throw new Error('Unable to connect to the coordination database'); }
    if (this.closed) {
      await this.dispose(connection);
      throw new Error('Coordinator is closed');
    }

    try {
      const [rows] = await connection.query('SELECT GET_LOCK(?, ?) AS acquired', [lock, waitSeconds]);
      const value = (rows as Array<{ acquired: number | null }>)[0]?.acquired;
      if (value === 0) {
        await this.returnConnection(connection, true);
        return null;
      }
      if (value !== 1) throw new Error('Coordination lock acquisition is uncertain');
      this.acquiringConnections.delete(connection);
      if (this.closed) {
        await this.dispose(connection);
        throw new Error('Coordinator is closed');
      }
      return this.makeLease(key, lock, connection);
    } catch {
      // A failed GET_LOCK response may have acquired the server lock before
      // the connection failed. Disposing the physical connection releases it.
      await this.dispose(connection);
      throw new Error('Unable to acquire the coordination lock');
    }
  }

  private makeLease(key: string, lock: string, connection: QueryConnection): SharedLease {
    const controller = new AbortController();
    let held = true;
    let released: Promise<void> | undefined;
    let checking: Promise<void> | undefined;
    let connectionLost = false;
    let heartbeat: ReturnType<typeof setInterval>;
    let lease: ActiveLease;
    const lose = (reason: Error, transportLost = false) => {
      if (!held) return;
      held = false;
      // Once ownership is uncertain there is no useful lock to release on this
      // connection. Skipping the in-flight heartbeat also avoids waiting on
      // the heartbeat from inside its own loss callback.
      connectionLost = true;
      controller.abort(reason);
      clearInterval(heartbeat);
      if (transportLost) connection.destroy?.();
      // Heartbeat callbacks inherit the acquisition context after its span has
      // ended. Keep cleanup work independent of that stale tracing context.
      void context.with(ROOT_CONTEXT, () => lease.release());
    };
    lease = {
      key,
      signal: controller.signal,
      controller,
      assertHeld() {
        if (!held) throw controller.signal.reason instanceof Error ? controller.signal.reason : new Error('Coordination lease is no longer held');
      },
      release: async () => {
        if (released) return released;
        held = false;
        clearInterval(heartbeat);
        released = (async () => {
          if (!connectionLost) {
            await checking?.catch(() => {});
            try {
              const [rows] = await connection.query('SELECT RELEASE_LOCK(?) AS released', [lock]);
              reusable = (rows as Array<{ released: number | null }>)[0]?.released === 1;
            } catch { /* Failed release leaves server-lock ownership uncertain. */ }
          }
          await this.returnConnection(connection, !connectionLost && reusable);
          this.leases.delete(lease);
          this.leaseConnections.delete(lease);
        })();
        return released;
      },
    };
    let reusable = false;
    heartbeat = setInterval(() => {
      if (!held || checking) return;
      checking = (async () => {
        try {
          const heartbeatQuery = connection.query('SELECT IS_USED_LOCK(?) AS owner_id, CONNECTION_ID() AS connection_id', [lock]);
          let timeout: ReturnType<typeof setTimeout> | undefined;
          const [rows] = await Promise.race([
            heartbeatQuery,
            new Promise<never>((_resolve, reject) => {
              timeout = setTimeout(() => reject(new Error('timeout')), this.options.heartbeatTimeoutMs ?? Math.max(100, (this.options.heartbeatMs ?? 5_000) * 2));
              timeout.unref?.();
            }),
          ]).finally(() => { if (timeout) clearTimeout(timeout); });
          const row = (rows as Array<{ owner_id: number | null; connection_id: number }>)[0];
          if (!row || row.owner_id === null || Number(row.owner_id) !== Number(row.connection_id))
            lose(new Error('Coordination lease was lost'));
        } catch { lose(new Error('Coordination lease connection was lost'), true); }
        finally { checking = undefined; }
      })();
    }, this.options.heartbeatMs ?? 5_000);
    heartbeat.unref?.();
    this.leases.add(lease);
    this.leaseConnections.set(lease, connection);
    return lease;
  }

  async run<T>(key: string, action: () => Promise<T>): Promise<T> {
    validateKey(key);
    const inherited = this.context.getStore();
    const current = inherited?.get(key);
    if (current) {
      if (current.signal.aborted) current.assertHeld();
      let active = true;
      try { current.assertHeld(); } catch (error) {
        if (current.signal.aborted) throw error;
        active = false;
      }
      if (active) return action();
    }
    const parent = new Map(inherited ?? []);
    parent.delete(key);
    const waitSeconds = this.options.waitSeconds ?? 30;
    const deadline = Date.now() + waitSeconds * 1000;
    let lease: SharedLease | null = null;
    while (!lease && Date.now() < deadline) {
      if (this.closed) throw new Error('Coordinator is closed');
      lease = await this.acquire(key, Math.min(1, Math.max(0, Math.ceil((deadline - Date.now()) / 1000))));
      if (!lease) await sleep(25);
    }
    if (!lease) throw new Error('Timed out waiting for the coordination lock');
    const held = lease as ActiveLease;
    const context = new Map(parent);
    context.set(key, held);
    try {
      const result = await this.context.run(context, action);
      held.assertHeld();
      return result;
    }
    finally { await lease.release(); }
  }

  async tryRun<T>(key: string, action: () => Promise<T>): Promise<{ value: T } | null> {
    validateKey(key);
    const inherited = this.context.getStore();
    const current = inherited?.get(key);
    if (current) {
      if (current.signal.aborted) current.assertHeld();
      let active = true;
      try { current.assertHeld(); } catch (error) {
        if (current.signal.aborted) throw error;
        active = false;
      }
      if (active) return { value: await action() };
    }
    const lease = await this.tryAcquire(key);
    if (!lease) return null;
    const context = new Map(inherited ?? []);
    context.set(key, lease as ActiveLease);
    try {
      const value = await this.context.run(context, action);
      lease.assertHeld();
      return { value };
    } finally { await lease.release(); }
  }

  async close(): Promise<void> {
    if (this.closing) return this.closing;
    if (this.closed) return;
    this.closed = true;
    const leases = [...this.leases];
    for (const lease of leases) lease.controller.abort(new Error('Coordinator is closed'));
    const activeConnections = new Set(this.leaseConnections.values());
    const acquiring = [...this.acquiringConnections].filter(connection => !activeConnections.has(connection));
    this.closing = (async () => {
      await Promise.all([
        ...leases.map(lease => lease.release()),
        ...acquiring.map(connection => this.dispose(connection)),
        ...this.idleConnections.splice(0).map(connection => this.dispose(connection)),
      ]);
      await Promise.allSettled([...this.pendingAcquisitions]);
    })();
    await this.closing;
  }
}

/** In-memory coordinator for single-process use and deterministic tests. */
export class MemoryCoordinator implements SharedCoordinator {
  private readonly context = new AsyncLocalStorage<RunContext>();
  private readonly owners = new Map<string, { lease: ActiveLease; waiters: Array<() => void> }>();
  private closed = false;

  async tryAcquire(key: string): Promise<SharedLease | null> {
    validateKey(key);
    if (this.closed) throw new Error('Coordinator is closed');
    if (this.owners.has(key)) return null;
    return this.createLease(key);
  }

  private createLease(key: string): ActiveLease {
    const controller = new AbortController();
    let held = true;
    const owner = { lease: undefined as unknown as ActiveLease, waiters: [] as Array<() => void> };
    const thisCoordinator = this;
    const lease: ActiveLease = {
      key, signal: controller.signal, controller,
      assertHeld() {
        if (!held) throw controller.signal.reason instanceof Error ? controller.signal.reason : new Error('Coordination lease is no longer held');
      },
      async release() {
        if (!held) return;
        held = false;
        if (controller.signal.aborted) { /* retain loss reason */ }
        if (thisCoordinator.owners.get(key) === owner) thisCoordinator.owners.delete(key);
        // Wake every waiter after removing the owner. Each retries acquisition;
        // waking only one loses the remaining queue when this owner is deleted.
        for (const wake of owner.waiters.splice(0)) wake();
      },
    };
    owner.lease = lease;
    this.owners.set(key, owner);
    return lease;
  }

  async run<T>(key: string, action: () => Promise<T>): Promise<T> {
    validateKey(key);
    const inherited = this.context.getStore();
    const current = inherited?.get(key);
    if (current) {
      if (current.signal.aborted) current.assertHeld();
      let active = true;
      try { current.assertHeld(); } catch (error) {
        if (current.signal.aborted) throw error;
        active = false;
      }
      if (active) return action();
    }
    const parent = new Map(inherited ?? []);
    parent.delete(key);
    while (true) {
      if (this.closed) throw new Error('Coordinator is closed');
      const lease = await this.tryAcquire(key);
      if (!lease) {
        await new Promise<void>(resolve => {
          const owner = this.owners.get(key);
          if (!owner) { resolve(); return; }
          owner.waiters.push(resolve);
        });
        continue;
      }
      const context = new Map(parent);
      context.set(key, lease as ActiveLease);
      try {
        const result = await this.context.run(context, action);
        lease.assertHeld();
        return result;
      }
      finally { await lease.release(); }
    }
  }

  async tryRun<T>(key: string, action: () => Promise<T>): Promise<{ value: T } | null> {
    validateKey(key);
    const inherited = this.context.getStore();
    const current = inherited?.get(key);
    if (current) {
      if (current.signal.aborted) current.assertHeld();
      let active = true;
      try { current.assertHeld(); } catch (error) {
        if (current.signal.aborted) throw error;
        active = false;
      }
      if (active) return { value: await action() };
    }
    const lease = await this.tryAcquire(key);
    if (!lease) return null;
    const context = new Map(inherited ?? []);
    context.set(key, lease as ActiveLease);
    try {
      const value = await this.context.run(context, action);
      lease.assertHeld();
      return { value };
    } finally { await lease.release(); }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const owner of [...this.owners.values()]) {
      owner.lease.controller.abort(new Error('Coordinator is closed'));
      await owner.lease.release();
      for (const wake of owner.waiters.splice(0)) wake();
    }
  }
}
