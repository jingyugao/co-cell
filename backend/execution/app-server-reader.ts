import { AppServerRpcError, CodexAppServerClient } from '../../packages/agentcore/src/index.mjs';
import type { SandboxExtension } from '@co-cell/sandbox';

export interface AppServerEndpoint {
  url: string;
  headers?: Record<string, string>;
}

type Connection = {
  id: string;
  ready: Promise<CodexAppServerClient>;
  users: number;
  retired: boolean;
  timer?: ReturnType<typeof setTimeout>;
  disposal?: Promise<void>;
  drained: Promise<unknown>;
  finish(error?: unknown): void;
};

/** Read RPCs share a connection, without acquiring or waking a Sandbox. */
export class AppServerReader {
  private connections = new Map<string, Connection>();
  private live = new Set<Connection>();
  private blocked = new Map<string, number>();
  private closed = false;

  readonly extension: SandboxExtension = {
    name: 'app-server-read-connections',
    pre: async context => {
      if (!context.sandboxId || !['pause', 'checkpoint', 'destroy'].includes(context.action)) return;
      return this.suspend(context.sandboxId);
    },
  };

  constructor(private endpoint: (id: string) => Promise<AppServerEndpoint>,
    private onCleanupError: (error: unknown) => void, private idleMs = 60_000) {}

  async read<T>(id: string, action: (client: CodexAppServerClient) => Promise<T>): Promise<T> {
    if (this.closed) throw new Error('App Server reader is closed');
    if (this.blocked.has(id)) throw Object.assign(new Error('Sandbox is entering maintenance'), { code: 'BUSY' });
    let connection = this.connections.get(id);
    if (!connection) {
      let finish!: Connection['finish'];
      const drained = new Promise(resolve => { finish = resolve; });
      connection = { id, ready: undefined!, users: 0, retired: false, drained, finish };
      this.live.add(connection);
      const current = connection;
      this.connections.set(id, current);
      current.ready = this.open(id, current);
    }
    clearTimeout(connection.timer);
    connection.users++;
    try {
      const client = await connection.ready;
      return await action(client);
    } catch (error) {
      // An RPC rejection does not break the transport; other failures need a
      // fresh connection on the next read. Do not automatically replay requests.
      if (!(error instanceof AppServerRpcError)) this.retire(id, connection);
      throw error;
    } finally {
      connection.users--;
      if (!connection.users) {
        if (connection.retired) this.dispose(connection);
        else {
          connection.timer = setTimeout(() => this.retire(id, connection!), this.idleMs);
          connection.timer.unref();
        }
      }
    }
  }

  /** Fence new reads until the lifecycle operation completes; drain active RPCs first. */
  private async suspend(id: string): Promise<() => void> {
    this.blocked.set(id, (this.blocked.get(id) ?? 0) + 1);
    const release = () => {
      const count = this.blocked.get(id)! - 1;
      if (count) this.blocked.set(id, count); else this.blocked.delete(id);
    };
    const connections = [...this.live].filter(connection => connection.id === id);
    for (const connection of connections) this.retire(id, connection);
    const errors = await Promise.all(connections.map(connection => connection.drained));
    const error = errors.find(error => error !== undefined);
    if (error !== undefined) { release(); throw error; }
    return release;
  }

  private async open(id: string, connection: Connection) {
    const endpoint = await this.endpoint(id);
    const client = new CodexAppServerClient({ url: endpoint.url,
      headers: endpoint.headers,
      requestTimeoutMs: 30_000 });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([client.connect(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('App Server connection timed out')), 30_000);
      })]);
      client.once('closed', () => this.retire(id, connection));
      return client;
    } catch (error) {
      try { await client.close(); } catch (cleanupError) { this.onCleanupError(cleanupError); }
      throw error;
    } finally { clearTimeout(timer); }
  }

  private retire(id: string, connection: Connection) {
    connection.retired = true;
    clearTimeout(connection.timer);
    if (this.connections.get(id) === connection) this.connections.delete(id);
    if (!connection.users || this.closed) this.dispose(connection);
  }

  private dispose(connection: Connection) {
    if (connection.disposal) return;
    connection.disposal = (async () => {
      let failure;
      let client;
      try {
        try { client = await connection.ready; } catch { return; }
        await client.close();
      } catch (error) { failure = error; this.onCleanupError(error); }
      finally { this.live.delete(connection); connection.finish(failure); }
    })();
  }

  async close() {
    this.closed = true;
    const connections = [...this.live];
    for (const connection of connections) this.retire(connection.id, connection);
    await Promise.all(connections.map(connection => connection.drained));
  }
}
