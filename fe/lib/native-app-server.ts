export type NativeRpcError = Error & { code?: string; data?: unknown; unknownOutcome?: boolean };
type RpcMessage = { id?: string | number; method?: string; params?: Record<string, any>; result?: any; error?: { code?: string | number; message?: string; data?: unknown } };

export class NativeAppServerClient {
  private socket?: WebSocket;
  private sequence = 0;
  private pending = new Map<string, { resolve: (value: any) => void; reject: (error: NativeRpcError) => void; timer: ReturnType<typeof setTimeout> }>();
  private closed = false;
  private opening?: Promise<void>;
  private failOpening?: (error: Error) => void;
  constructor(private readonly url: string, private readonly notification: (message: RpcMessage) => void,
    private readonly onClose: (error?: Error) => void, private readonly onError: (error: Error) => void = () => {}) {}
  async connect(threadId: string | null) {
    await this.open();
    await this.request('initialize', { clientInfo: { name: 'cocell', title: 'CoCell', version: '1.0.0' }, capabilities: {} });
    this.notify('initialized', {});
    if (threadId) await this.request('thread/resume', { threadId, excludeTurns: true });
  }
  private open(): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN) return Promise.resolve();
    if (this.opening) return this.opening;
    this.opening = new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(this.url); this.socket = socket;
      let settled = false;
      const fail = (error: Error) => { if (settled) return; settled = true; clearTimeout(timer); this.failOpening = undefined; reject(error); };
      const timer = setTimeout(() => { const error = new Error('连接 Codex App Server 超时'); fail(error); socket.close(); }, 10_000);
      this.failOpening = fail;
      socket.onopen = () => { if (settled) return; settled = true; clearTimeout(timer); this.failOpening = undefined; resolve(); };
      socket.onerror = () => { const error = new Error('无法连接 Codex App Server'); this.onError(error); fail(error); socket.close(); };
      socket.onmessage = event => this.receive(event.data);
      socket.onclose = () => {
        if (this.socket === socket) this.socket = undefined;
        if (!settled) fail(new Error('Codex App Server WebSocket 在连接完成前关闭'));
        const error = new Error('Codex App Server WebSocket 已断开');
        for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(Object.assign(new Error(error.message), { unknownOutcome: true })); }
        this.pending.clear();
        if (!this.closed) this.onClose(error);
      };
    }).finally(() => { this.opening = undefined; });
    return this.opening;
  }
  private receive(raw: unknown) {
    let message: RpcMessage;
    try { message = JSON.parse(String(raw)) as RpcMessage; }
    catch { this.onError(new Error('Codex App Server 返回了无法解析的 WebSocket 消息')); return; }
    // App Server may send a request of its own. Never consume it as a response
    // to a browser request with the same JSON-RPC id.
    if (typeof message.method === 'string') {
      if (message.id !== undefined && this.socket?.readyState === WebSocket.OPEN) {
        this.socket.send(JSON.stringify({ id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } }));
      } else this.notification(message);
      return;
    }
    if (message.id !== undefined) {
      const pending = this.pending.get(String(message.id)); if (!pending) return;
      this.pending.delete(String(message.id)); clearTimeout(pending.timer);
      if (message.error) pending.reject(Object.assign(new Error(message.error.message ?? 'App Server RPC 失败'), { code: String(message.error.code ?? ''), data: message.error.data }));
      else pending.resolve(message.result);
    }
  }
  request(method: string, params: Record<string, unknown>) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Codex App Server 尚未连接'));
    const id = ++this.sequence;
    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(String(id)); reject(Object.assign(new Error(`${method} 响应超时，执行结果未知。请刷新状态后再决定下一步。`), { unknownOutcome: true }));
      }, 30_000);
      this.pending.set(String(id), { resolve, reject, timer });
      try { this.socket!.send(JSON.stringify({ id, method, params })); }
      catch (error) {
        this.pending.delete(String(id)); clearTimeout(timer); reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }
  notify(method: string, params: Record<string, unknown>) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) throw new Error('Codex App Server 尚未连接');
    this.socket.send(JSON.stringify({ method, params }));
  }
  close() {
    this.closed = true;
    this.failOpening?.(new Error('Codex App Server 连接已关闭'));
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(Object.assign(new Error('Codex App Server 连接已关闭，RPC 结果未知。'), { unknownOutcome: true })); }
    this.pending.clear(); this.socket?.close(); this.socket = undefined;
  }
}

export function nativeWebSocketUrl(path: string) {
  const url = new URL(path, window.location.href);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

/** Read a snapshot only after one complete read window without thread changes. */
export async function readQuietSnapshot<T>(read: () => Promise<T>, version: () => number, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let value!: T;
  do {
    const before = version();
    value = await read();
    if (before === version()) return { value, quiet: true };
  } while (Date.now() < deadline);
  return { value, quiet: false };
}
