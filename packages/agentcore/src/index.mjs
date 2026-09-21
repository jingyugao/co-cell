import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';

export class AppServerRpcError extends Error {
  constructor(rpc, method) { super(`${method}: ${rpc.message}`); this.name = 'AppServerRpcError'; this.rpc = rpc; }
}

/** Owns a local stdio child. Run this inside the independent sandbox worker for detached execution. */
export class CodexAppServerClient extends EventEmitter {
  constructor(options = {}) { super(); this.options = options; this.pending = new Map(); this.nextId = 1; this.closed = false; }
  static async spawn(options = {}) {
    const client = new CodexAppServerClient(options);
    try { await client.connect(); return client; } catch (error) { await client.close(); throw error; }
  }
  async connect() {
    if (this.child || this.socket) throw new Error('Client already started');
    if (this.closed) throw new Error('Client is closed');
    if (this.options.url) return this.connectWebSocket();
    this.child = spawn(this.options.command ?? 'codex', this.options.args ?? ['app-server'], {
      cwd: this.options.cwd, env: this.options.env ?? process.env, stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.stderrText = ''; this.child.stderr.on('data', chunk => { this.stderrText += chunk.toString(); this.emit('stderr', chunk.toString()); });
    this.child.on('error', error => this.fail(error));
    this.child.stdin.on('error', error => this.fail(error));
    this.child.on('exit', (code, signal) => {
      this.fail(new Error(`App Server exited (${code ?? signal})`)); this.emit('exit', { code, signal });
    });
    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on('line', line => {
      try { this.receive(JSON.parse(line)); } catch (error) { this.emit('protocolError', error); this.fail(error); }
    });
    this.lines.on('close', () => { if (!this.closed) this.fail(new Error(`App Server output closed${this.stderrText ? `: ${this.stderrText.trim().slice(-1000)}` : ''}`)); });
    await this.request('initialize', {
      clientInfo: { name: 'co_cell_app_server_client', version: '0.2.0' },
      capabilities: { experimentalApi: true },
    });
    this.notify('initialized');
  }
  async connectWebSocket() {
    const socket = this.socket = new WebSocket(this.options.url, { headers: this.options.headers ?? {} });
    await new Promise((resolve, reject) => {
      const opened = () => { cleanup(); resolve(); };
      const failed = () => { cleanup(); reject(new Error('App Server WebSocket connection failed')); };
      const cleanup = () => { socket.removeEventListener('open', opened); socket.removeEventListener('error', failed); };
      socket.addEventListener('open', opened, { once: true }); socket.addEventListener('error', failed, { once: true });
    });
    socket.addEventListener('message', event => {
      try { this.receive(JSON.parse(String(event.data))); } catch (error) { this.emit('protocolError', error); this.fail(error); }
    });
    socket.addEventListener('error', () => this.fail(new Error('App Server WebSocket transport failed')));
    socket.addEventListener('close', () => { if (!this.closed) this.fail(new Error('App Server WebSocket closed')); });
    await this.request('initialize', {
      clientInfo: { name: 'co_cell_app_server_client', version: '0.2.0' },
      capabilities: { experimentalApi: true },
    });
    this.notify('initialized');
  }
  send(message) {
    if (this.closed || this.failure || (!this.child && !this.socket)) throw this.failure ?? new Error('Client is closed');
    if (this.socket) { this.socket.send(JSON.stringify(message)); return; }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }
  request(method, params) {
    if (this.closed || this.failure) return Promise.reject(this.failure ?? new Error('Client is closed'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id); reject(new Error(`${method} timed out; server execution state is unknown`));
      }, this.options.requestTimeoutMs ?? 60_000);
      this.pending.set(id, { resolve, reject, timer, method });
      try { this.send({ id, method, ...(params === undefined ? {} : { params }) }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  notify(method, params) { this.send({ method, ...(params === undefined ? {} : { params }) }); }
  respond(id, result) { this.send({ id, result }); }
  respondError(id, error) { this.send({ id, error }); }
  receive(message) {
    if (!message || typeof message !== 'object') throw new Error('Invalid App Server message');
    if (message.method) {
      if (message.id !== undefined) {
        if (this.listenerCount('request')) this.emit('request', message);
        else this.respondError(message.id, { code: -32601, message: `Unhandled server request: ${message.method}` });
      } else this.emit('notification', message);
    } else if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer); this.pending.delete(message.id);
      if (message.error) pending.reject(new AppServerRpcError(message.error, pending.method));
      else pending.resolve(message.result);
    } else throw new Error('Invalid App Server envelope');
  }
  /** Subscribe immediately, before issuing the request that produces notifications. No history is implied. */
  events() {
    const queue = []; let wake; let ended = this.closed; let failure = this.failure;
    const notify = value => { queue.push(value); wake?.(); };
    const stop = error => { ended = true; failure = error; wake?.(); };
    this.on('notification', notify); this.on('closed', stop);
    const cleanup = () => { this.off('notification', notify); this.off('closed', stop); };
    return {
      [Symbol.asyncIterator]() { return this; },
      next: async () => {
        while (!queue.length && !ended) await new Promise(resolve => { wake = resolve; });
        if (queue.length) return { done: false, value: queue.shift() };
        cleanup(); if (failure) throw failure;
        return { done: true, value: undefined };
      },
      return: async () => { ended = true; queue.length = 0; cleanup(); wake?.(); return { done: true, value: undefined }; },
    };
  }
  threadStart(params) { return this.request('thread/start', params); }
  threadResume(params) { return this.request('thread/resume', params); }
  turnStart(params) { return this.request('turn/start', params); }
  turnInterrupt(params) { return this.request('turn/interrupt', params); }
  fail(error) {
    if (this.failure || this.closed) return;
    this.failure = error;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear(); this.emit('closed', error);
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('Client closed')); }
    this.pending.clear(); this.emit('closed'); this.lines?.close();
    if (this.socket) { this.socket.close(); return; }
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise(resolve => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); }, 2000);
      const fallback = setTimeout(resolve, 3000);
      child.once('exit', () => { clearTimeout(timer); clearTimeout(fallback); resolve(); });
      child.stdin.end(); child.kill('SIGTERM');
    });
  }
}

const emptyUsage = () => ({ input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 });
const status = value => value === 'inProgress' ? 'in_progress' : value === 'completed' ? 'completed' : 'failed';
/** Normalizes presentation events; native context remains owned by Codex. */
export class AppServerEventAdapter {
  constructor() { this.items = new Map(); this.usage = emptyUsage(); }
  convert(item) {
    const previous = this.items.get(item.id);
    switch (item.type) {
      case 'agentMessage': return { id: item.id, type: 'agent_message', text: item.text ?? previous?.text ?? '' };
      case 'reasoning': return { id: item.id, type: 'reasoning', text: (item.summary?.length ? item.summary : item.content)?.join('\n') || previous?.text || '' };
      case 'commandExecution': return { id: item.id, type: 'command_execution', command: item.command, aggregated_output: item.aggregatedOutput ?? previous?.aggregated_output ?? '', ...(item.exitCode != null ? { exit_code: item.exitCode } : {}), status: status(item.status) };
      case 'fileChange': return { id: item.id, type: 'file_change', changes: item.changes.map(change => ({ path: change.path, kind: typeof change.kind === 'string' ? change.kind : change.kind.type })), status: item.status === 'failed' || item.status === 'declined' ? 'failed' : 'completed' };
      case 'mcpToolCall': return { id: item.id, type: 'mcp_tool_call', server: item.server, tool: item.tool, arguments: item.arguments, status: status(item.status), ...(item.result ? { result: { content: item.result.content ?? [], structured_content: item.result.structuredContent } } : {}), ...(item.error ? { error: item.error } : {}) };
      case 'webSearch': return { id: item.id, type: 'web_search', query: item.action?.query ?? item.query ?? '' };
      default: return undefined;
    }
  }
  accept({ method, params: p = {} }) {
    if (method === 'turn/started') return [{ type: 'turn.started', turn_id: p.turn.id }];
    if (method === 'thread/tokenUsage/updated') {
      const usage = p.tokenUsage?.last ?? {};
      this.usage = { ...emptyUsage(), input_tokens: usage.inputTokens ?? 0, cached_input_tokens: usage.cachedInputTokens ?? 0, cache_write_input_tokens: usage.cacheWriteInputTokens ?? 0, output_tokens: usage.outputTokens ?? 0, reasoning_output_tokens: usage.reasoningOutputTokens ?? 0 };
      return [];
    }
    if (method === 'turn/completed') {
      if (p.turn.status !== 'completed') return [{ type: 'turn.failed', error: { message: p.turn.error?.message ?? `Turn ${p.turn.status}` } }];
      return [{ type: 'turn.completed', usage: this.usage }];
    }
    if (method === 'error') return [{ type: 'error', message: p.error?.message ?? 'App Server error' }];
    if (method === 'turn/plan/updated') return [{ type: 'item.updated', item: { id: `${p.turnId}:plan`, type: 'todo_list', items: (p.plan ?? []).map(step => ({ text: step.step, completed: step.status === 'completed' })) } }];
    if (method === 'item/started' || method === 'item/completed') {
      if (p.item.type === 'contextCompaction') return [{ type: method === 'item/started' ? 'item.started' : 'item.completed', item: { id: p.item.id, type: 'context_compaction', status: method === 'item/started' ? 'in_progress' : 'completed' } }];
      const item = this.convert(p.item);
      if (!item) return [];
      this.items.set(item.id, item);
      return [{ type: method === 'item/started' ? 'item.started' : 'item.completed', item: structuredClone(item) }];
    }
    const item = this.items.get(p.itemId);
    if (!item) return [];
    if (method === 'item/agentMessage/delta' || method === 'item/reasoning/summaryTextDelta' || method === 'item/reasoning/textDelta') item.text += p.delta;
    else if (method === 'item/reasoning/summaryPartAdded') { if (item.text) item.text += '\n'; }
    else if (method === 'item/commandExecution/outputDelta') item.aggregated_output += p.delta;
    else return [];
    return [{ type: 'item.updated', item: structuredClone(item) }];
  }
}

function toml(value) {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `[${value.map(toml).join(', ')}]`;
  if (value && typeof value === 'object') return `{ ${Object.entries(value).map(([k, v]) => `${JSON.stringify(k)} = ${toml(v)}`).join(', ')} }`;
  throw new Error('Unsupported Codex configuration value');
}
function overrides(config, prefix = '') {
  return Object.entries(config ?? {}).flatMap(([key, value]) => {
    const safeKey = /^[A-Za-z_][A-Za-z0-9_-]*$/.test(key) ? key : JSON.stringify(key);
    const path = prefix ? `${prefix}.${safeKey}` : safeKey;
    return value && typeof value === 'object' && !Array.isArray(value) ? overrides(value, path) : [`${path}=${toml(value)}`];
  });
}

/** Share identical provider/configuration arguments with maintenance probes. */
export function appServerArgs(config, configOverrides = []) {
  return ['app-server', ...[...overrides(config), ...configOverrides].flatMap(value => ['-c', value])];
}

/** Small execution facade over App Server, independent of @openai/codex-sdk. */
export class Codex {
  constructor(options = {}) { this.options = options; this.clients = new Set(); }
  startThread(options = {}) { return new Thread(this, options); }
  resumeThread(id, options = {}) { return new Thread(this, options, id); }
  async close() { await Promise.all([...this.clients].map(client => client.close())); }
}
export class Thread {
  constructor(codex, options, id = null) { this.codex = codex; this.options = options; this.id = id; this.running = false; }
  async runStreamed(input, options = {}) { return { events: this.execute(input, options) }; }
  async *execute(input, { signal, outputSchema } = {}) {
    if (this.running) throw new Error('A turn is already running on this thread');
    this.running = true;
    let client, stream, turnId;
    const abort = () => { if (turnId) void client.turnInterrupt({ threadId: this.id, turnId }).catch(() => {}); };
    try {
      signal?.throwIfAborted();
      const config = this.codex.options;
      const args = appServerArgs(config.config, config.configOverrides);
      client = await CodexAppServerClient.spawn(config.appServerUrl ? { url: config.appServerUrl, headers: config.appServerHeaders } : { command: config.codexPathOverride, args, cwd: this.options.workingDirectory,
        env: { ...(config.env ?? process.env), ...(config.apiKey ? { CODEX_API_KEY: config.apiKey } : {}), ...(config.baseUrl ? { OPENAI_BASE_URL: config.baseUrl } : {}) } });
      this.codex.clients.add(client);
      client.on('stderr', message => { /* callers may observe diagnostics */ this.codex.emit?.('stderr', message); });
      signal?.throwIfAborted();
      stream = client.events();
      const opts = this.options;
      const threadConfig = {
        ...(opts.webSearchMode ? { web_search: opts.webSearchMode } : {}),
        ...(opts.networkAccessEnabled !== undefined ? { 'sandbox_workspace_write.network_access': opts.networkAccessEnabled } : {}),
        ...(opts.additionalDirectories?.length ? { 'sandbox_workspace_write.writable_roots': opts.additionalDirectories } : {}),
      };
      const params = { ...(opts.model ? { model: opts.model } : {}), cwd: opts.workingDirectory,
        approvalPolicy: opts.approvalPolicy ?? 'never', sandbox: opts.sandboxMode ?? 'workspace-write', config: threadConfig };
      const response = await client.request(this.id ? 'thread/resume' : 'thread/start', { ...params, ...(this.id ? { threadId: this.id } : {}) });
      this.id = response.thread.id;
      yield { type: 'thread.started', thread_id: this.id };
      signal?.throwIfAborted();
      const userInput = typeof input === 'string' ? [{ type: 'text', text: input }] : input;
      const result = await client.turnStart({ threadId: this.id, input: userInput.map(part => part.type === 'local_image' ? { type: 'localImage', path: part.path } : { type: 'text', text: part.text, text_elements: [] }),
        ...(opts.modelReasoningEffort ? { effort: opts.modelReasoningEffort } : {}), ...(outputSchema ? { outputSchema } : {}) });
      turnId = result.turn.id;
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      const adapter = new AppServerEventAdapter();
      for await (const event of stream) {
        const p = event.params;
        if (p?.threadId && p.threadId !== this.id) continue;
        if (p?.turnId && p.turnId !== turnId) continue;
        if (p?.turn?.id && p.turn.id !== turnId) continue;
        for (const mapped of adapter.accept(event)) {
          yield mapped;
          if (mapped.type === 'turn.completed' || mapped.type === 'turn.failed') return;
        }
      }
      throw new Error('App Server stream ended before turn completion');
    } finally {
      signal?.removeEventListener('abort', abort);
      await stream?.return();
      await client?.close();
      if (client) this.codex.clients.delete(client);
      this.running = false;
    }
  }
}
