import { AppServerRpcError, CodexAppServerClient } from '../../packages/agentcore/src/index.mjs';

export interface AppServerEndpoint {
  url: string;
  headers?: Record<string, string>;
}

type Connection = {
  ready: Promise<CodexAppServerClient>;
  users: number;
  retired: boolean;
  timer?: ReturnType<typeof setTimeout>;
  disposal?: Promise<void>;
};

/** Read RPCs share a connection, without acquiring or waking a Sandbox. */
export class AppServerReader {
  private connections = new Map<string, Connection>();
  private disposals = new Set<Promise<void>>();
  private closed = false;

  constructor(private endpoint: (id: string) => Promise<AppServerEndpoint>,
    private onCleanupError: (error: unknown) => void, private idleMs = 60_000) {}

  async read<T>(id: string, action: (client: CodexAppServerClient) => Promise<T>): Promise<T> {
    if (this.closed) throw new Error('App Server reader is closed');
    let connection = this.connections.get(id);
    if (!connection) {
      connection = { ready: undefined!, users: 0, retired: false };
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
      let client;
      try { client = await connection.ready; } catch { return; }
      try { await client.close(); } catch (error) { this.onCleanupError(error); }
    })();
    this.disposals.add(connection.disposal);
    void connection.disposal.finally(() => this.disposals.delete(connection.disposal!));
  }

  async close() {
    this.closed = true;
    for (const [id, connection] of this.connections) this.retire(id, connection);
    await Promise.allSettled(this.disposals);
  }
}
