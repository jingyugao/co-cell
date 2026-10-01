import type { SandboxImageIdentity, SandboxState } from '../../protocol/sandbox-types.js';
import type { WorkspaceTarget } from '../sandboxes/types.js';
import { createHash, randomUUID } from 'node:crypto';
import { AppServerEventAdapter, Codex, CodexAppServerClient } from '../../packages/agentcore/src/index.mjs';
import { readFile } from 'node:fs/promises';
import { basename, extname, posix } from 'node:path';
import type { SandboxHandle, SandboxProvider, SandboxLease, SandboxRecord, CellboxServiceAccess } from '@co-cell/sandbox';
import { ProjectSandboxes, type SaveSandbox } from '../sandboxes/project-sandboxes.js';
import { readCellboxWorkspaceFile } from '../sandboxes/cellbox-files.js';
import type { AgentEvent } from '../../protocol/types.js';
import type { Session, SubagentConversation, Turn } from '../../protocol/types.js';
import type { NativeHistory } from './native-history.mjs';
import { readSubagentConversations } from './native-history.mjs';
import { loadAgentDocs } from '../shared-files/agent-docs.js';
import type { RuntimeLog } from '../infra/diagnostics/runtime-log.js';
import { HttpError } from '../../util/errors.js';
import type { WorkspaceFileResult, WorkspaceFileReadOptions } from '../workspaces/files.js';

export interface SandboxRuntime {
	remoteArchives?: import('../archives/remote.js').RemoteArchives;
  currentImageIdentity?(target?: WorkspaceTarget): Promise<SandboxImageIdentity>;
  track?(session: WorkspaceTarget, onSandbox: (value: SandboxState) => Promise<void>): void;
  trackExecution?(session: Session, turn: Turn): void;
  run(session: Session, turn: Turn, signal: AbortSignal, onSandbox: (value: SandboxState) => Promise<void>): AsyncGenerator<AgentEvent>;
  recover(session: Session, turn: Turn, signal: AbortSignal, onSandbox: (value: SandboxState) => Promise<void>): AsyncGenerator<AgentEvent>;
  detach(turn: Turn): void;
  service?(session: WorkspaceTarget, port: number, path: string, request: Request): Promise<Response>;
  file(session: WorkspaceTarget, path: string, options?: WorkspaceFileReadOptions): Promise<WorkspaceFileResult>;
  inspect?(target: WorkspaceTarget): Promise<unknown>;
  history(session: Session, options?: { cursor?: string; limit?: number }): Promise<NativeHistory>;
  subagents?(session: Session): Promise<SubagentConversation[]>;
  delete(session: WorkspaceTarget): Promise<void>;
  rebuild(target: WorkspaceTarget, onSandbox: (value: SandboxState) => Promise<void>): Promise<void>;
  resume?(target: WorkspaceTarget, onSandbox: (value: SandboxState) => Promise<void>): Promise<void>;
  checkpoint?(target: WorkspaceTarget): Promise<SandboxState>;
  verifySandbox?(sandbox: SandboxState, timeoutMs?: number): Promise<void>;
  verifyHistory?(sandbox: SandboxState, threadIds: string[]): Promise<void>;
  fenceSandbox?(sandbox: SandboxState): Promise<void>;
  detachSandbox?(target: WorkspaceTarget): Promise<void>;
  pauseDanglingSandbox?(sandboxId: string): Promise<void>;
  deleteDanglingSandbox?(sandboxId: string): Promise<void>;
  close(): Promise<void>;
}
export interface AppServerEndpoint { url: string; token?: string; headers?: Record<string,string>; release?: () => Promise<void> }
const endpointHeaders = (endpoint: AppServerEndpoint) => endpoint.headers ?? (endpoint.token ? { Authorization: 'Bearer ' + endpoint.token } : {});
export interface ContainerRuntimeOptions {
  paths: { root: string; runtime: string; codexHome: string; node: string };
  prepareRemote: (sandbox: SandboxHandle, target: WorkspaceTarget, signal: AbortSignal) => Promise<boolean>;
  acquireRemoteUsage?: (sandboxId: string) => Promise<() => Promise<void>>;
  remoteArchives?: import('../archives/remote.js').RemoteArchives;
  sandboxes: ProjectSandboxes;
  provider: SandboxProvider;
  apiKey: string;
  baseUrl?: string;
  modelConfig?: Record<string, unknown>;
  configOverrides?: string[];
  sharedDataDirectory?: URL;
  logger?: RuntimeLog;
  appServer?: (sandboxId: string) => Promise<AppServerEndpoint>;
  serviceAccess?: (sandboxId: string, port: number) => Promise<CellboxServiceAccess>;
}
type Preparation = {
  preparing?: Promise<void>;
  sharedDocPaths?: Set<string>;
  sharedDocDigests?: Map<string, string>;
  agentInstructionsDigest?: string;
};
type Entry = {
  sandbox: SandboxHandle;
  readonly metadata: SandboxRecord;
  lease: SandboxLease;
  preparation: Preparation;
  releaseRemote?: () => Promise<void>;
};
export class TurnObserverDetached extends Error {
  constructor() { super('Web observer detached'); this.name = 'TurnObserverDetached'; }
}
const SHARED_DATA = new URL('../../data/', import.meta.url);
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const checkAbort = (signal: AbortSignal) => { if (signal.aborted) throw new DOMException('任务已停止', 'AbortError'); };
const waitFor = (delayMs: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  const timer = setTimeout(done, delayMs);
  const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason); };
  function done() { signal.removeEventListener('abort', abort); resolve(); }
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
});

/** Prepares project Sandboxes and observes turns on their persistent Codex App Server. */
export class ContainerCodexRuntime implements SandboxRuntime {
  private closing = false;
  private runtimePreparations = new Map<string, Preparation>();
  private observers = new Map<string, AbortController>();
  private appServerObservers = new Map<string, { close(): Promise<void> }>();
  private detachRequests = new Set<string>();
  private readonly sandboxes: ProjectSandboxes;

  constructor(private options: ContainerRuntimeOptions) {
    this.sandboxes = options.sandboxes;
  }

  get remoteArchives() { return this.options.remoteArchives; }
  private get root() { return this.options.paths.root; }
  private get runtimeDirectory() { return this.options.paths.runtime; }
  private get codexHome() { return this.options.paths.codexHome; }
  private get sharedDocs() { return this.codexHome + '/docs'; }
  private get node() { return this.options.paths.node; }

  track(target: WorkspaceTarget, notify: SaveSandbox) { this.sandboxes.track(target, notify); }
  async currentImageIdentity(target?: WorkspaceTarget): Promise<SandboxImageIdentity> {
    if (target?.imageSelection) return { reference: target.imageSelection.image, id: target.imageSelection.image, repoDigests: [target.imageSelection.image] };
    const provider = this.options.provider as SandboxProvider & { currentImageIdentity?: () => Promise<SandboxImageIdentity> };
    if (!provider.currentImageIdentity) throw new Error('Sandbox provider does not support image switching');
    return provider.currentImageIdentity();
  }
  trackExecution(session: Session, turn: Turn) {
    if (turn.codexAccepted && turn.nativeTurnId && session.threadId && session.sandbox) {
      this.sandboxes.holdUsage(session, turn.id);
    }
  }
  private safeError(error: unknown): Error {
    let message = error instanceof Error ? error.message : String(error);
    if (this.options.apiKey) message = message.replaceAll(this.options.apiKey, '[REDACTED]');
    return new Error(message);
  }

  private async releaseEndpoint(endpoint?: AppServerEndpoint) {
    try { await endpoint?.release?.(); }
    catch (error) {
      // The grant also expires remotely; cleanup failure must not lose the
      // execution result or prevent releasing the local sandbox usage.
      void this.options.logger?.write({ event: 'sandbox.access_release_failed', error: this.safeError(error).message });
    }
  }

  private async acquire(target: WorkspaceTarget, create: boolean, notify?: SaveSandbox, usageId?: string, signal?: AbortSignal): Promise<Entry> {
    if (this.closing) throw new Error('Sandbox 运行时正在关闭');
    const lease = await this.sandboxes.acquire(target, { create, save: notify, usageId, signal });
    let preparation = this.runtimePreparations.get(lease.record.id);
    if (!preparation) {
      preparation = {};
      this.runtimePreparations.set(lease.record.id, preparation);
    }
    let releaseRemote: (() => Promise<void>) | undefined;
    try { releaseRemote = await this.options.acquireRemoteUsage?.(lease.record.id); }
    catch (error) { await lease.release(); throw error; }
    return { sandbox: lease.sandbox, get metadata() { return lease.record; }, lease, preparation, releaseRemote };
  }

  private async release(entry: Entry, failed = false, detached = false) {
    try { try { await entry.releaseRemote?.(); } finally { await entry.lease.release({ detached }); } }
    catch (error) {
      void this.options.logger?.write({ event: 'sandbox.release_failed', sandboxId: entry.metadata.id, message: this.safeError(error).message });
      if (!failed) throw this.safeError(error);
    }
  }

  /** Use a new process group for every operation so cancellation also kills Codex children. */
  private async command(entry: Entry, command: string, signal: AbortSignal, options: {
    onStdout?: (value: string) => void;
    onStderr?: (value: string) => void;
    envs?: Record<string, string>;
    timeoutMs?: number;
  } = {}) {
    checkAbort(signal);
    const result = await entry.sandbox.commands.run(command, { user: 'agent', signal, timeoutMs: Math.min(options.timeoutMs ?? 30_000, 300_000), envs: options.envs });
    options.onStdout?.(result.stdout);
    options.onStderr?.(result.stderr);
    return result;
  }

  private async writeAtomic(entry: Entry, path: string, content: string | ArrayBuffer, signal: AbortSignal) {
    const staging = path + '.' + randomUUID() + '.tmp';
    try {
      await entry.sandbox.files.write(staging, content, { user: 'user', signal });
      await entry.sandbox.files.rename(staging, path, { user: 'user', signal });
    } finally { await entry.sandbox.files.remove(staging, { user: 'user' }).catch(() => { }); }
  }

  // Serialize application-owned installation/sync only. Codex workers run concurrently.
  private async prepare<T>(entry: Entry, signal: AbortSignal, action: () => Promise<T>): Promise<T> {
    let started = false;
    const operation = (entry.preparation.preparing ?? Promise.resolve()).then(() => {
      checkAbort(signal);
      started = true;
      return action();
    });
    entry.preparation.preparing = operation.then(() => { }, () => { });
    // Cancelling a queued turn must not wait for another turn's installation.
    return new Promise<T>((resolve, reject) => {
      const abort = () => { if (!started) reject(new DOMException('任务已停止', 'AbortError')); };
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    });
  }

  private async prepareEnvironment(target: WorkspaceTarget, entry: Entry, executionSignal: AbortSignal) {
    return this.prepare(entry, executionSignal, async () => {
      // Shared documents are read on every turn, including resumed threads.
      // Global AGENTS.md is a required host mount on all supported Sandboxes.
      const sharedData = this.options.sharedDataDirectory ?? SHARED_DATA;
      const sharedDocs = await loadAgentDocs(new URL('docs/', sharedData));
      const fresh = await this.options.prepareRemote(entry.sandbox, target, executionSignal);
      if (fresh) {
        entry.preparation.sharedDocPaths = undefined;
        entry.preparation.sharedDocDigests = undefined;
        entry.preparation.agentInstructionsDigest = undefined;
      }
      const agents = await readFile(new URL('AGENTS.md', sharedData), 'utf8').catch(error => {
        if (error.code === 'ENOENT') return '';
        throw error;
      });
      const digest = createHash('sha256').update(agents).digest('hex');
      if (entry.preparation.agentInstructionsDigest !== digest) {
        await this.writeAtomic(entry, this.codexHome + '/AGENTS.md', agents, executionSignal);
        entry.preparation.agentInstructionsDigest = digest;
      }
      checkAbort(executionSignal);
      // On first preparation, replace the previous shared document snapshot.
      const docDirectories = new Set([this.sharedDocs, ...sharedDocs.map(file => posix.dirname(`${this.sharedDocs}/${file.path}`))]);
      const clearPrevious = entry.preparation.sharedDocPaths ? '' : `rm -rf ${quote(this.sharedDocs)} && `;
      const currentPaths = new Set(sharedDocs.map(file => file.path));
      const previousPaths = entry.preparation.sharedDocPaths;
      const currentDigests = new Map(sharedDocs.map(file => [file.path,
        createHash('sha256').update(new Uint8Array(file.contents)).digest('hex')]));
      if (!previousPaths || sharedDocs.some(file => !previousPaths.has(file.path))) {
        await this.command(entry, `sh -c ${quote(`${clearPrevious}mkdir -p ${[...docDirectories].map(quote).join(' ')}`)}`, executionSignal);
      }
      for (const file of sharedDocs) {
        checkAbort(executionSignal);
        if (entry.preparation.sharedDocDigests?.get(file.path) === currentDigests.get(file.path)) continue;
        await this.writeAtomic(entry, `${this.sharedDocs}/${file.path}`, file.contents, executionSignal);
      }
      for (const path of entry.preparation.sharedDocPaths ?? []) {
        if (!currentPaths.has(path)) await entry.sandbox.files.remove(`${this.sharedDocs}/${path}`, { user: 'user', signal: executionSignal });
      }
      entry.preparation.sharedDocPaths = currentPaths;
      entry.preparation.sharedDocDigests = currentDigests;
      return;
    });
  }

  /**
   * The App Server is the Sandbox entrypoint. Web owns the JSON-RPC client and
   * persistence, so ordinary execution no longer needs a copied worker or journal.
   */
  private async *runAppServer(session: Session, turn: Turn, signal: AbortSignal, onSandbox: SaveSandbox): AsyncGenerator<AgentEvent> {
    if (!this.options.appServer) throw new Error('Sandbox App Server endpoint is not configured');
    const observer = new AbortController();
    this.observers.set(turn.id, observer);
    if (this.detachRequests.has(turn.id)) observer.abort(new TurnObserverDetached());
    const startupSignal = AbortSignal.any([signal, observer.signal]);
    let entry: Entry | undefined;
    let codex: Codex | undefined;
    let endpoint: AppServerEndpoint | undefined;
    let failed = false;
    let detached = false;
    try {
      entry = await this.acquire(session, true, onSandbox, turn.id, startupSignal);
      // Publish the global AGENTS.md and shared docs before every turn.
      await this.prepareEnvironment(session, entry, startupSignal);
      observer.signal.throwIfAborted();
      endpoint = await this.options.appServer(entry.metadata.id);
      const images: string[] = [];
      if (turn.images.length) {
        await entry.sandbox.commands.run(`mkdir -p ${quote(`${this.root}/images`)}`, { user: 'user', timeoutMs: 30_000 });
        for (const [index, path] of turn.images.entries()) {
          const destination = `${this.root}/images/${turn.id}-${index}${extname(basename(path))}`;
          await entry.sandbox.files.write(destination, new Uint8Array(await readFile(path)).buffer, { user: 'user', signal: startupSignal });
          images.push(destination);
        }
      }
      codex = new Codex({ apiKey: this.options.apiKey, baseUrl: this.options.baseUrl, config: this.options.modelConfig,
        configOverrides: this.options.configOverrides, appServerUrl: endpoint.url,
        appServerHeaders: endpointHeaders(endpoint) });
      this.appServerObservers.set(turn.id, codex);
      observer.signal.throwIfAborted();
      const options = { workingDirectory: session.settings.workingDirectory, ...(session.settings.model ? { model: session.settings.model } : {}),
        modelReasoningEffort: session.settings.modelReasoningEffort, sandboxMode: 'danger-full-access' as const,
        webSearchMode: session.settings.webSearchMode, networkAccessEnabled: true, approvalPolicy: 'never' as const, skipGitRepoCheck: true };
      const thread = session.threadId ? codex.resumeThread(session.threadId, options) : codex.startThread(options);
      const input = images.length ? [{ type: 'text' as const, text: turn.prompt }, ...images.map(path => ({ type: 'local_image' as const, path }))] : turn.prompt;
      const streamed = await thread.runStreamed(input, { signal });
      for await (const event of streamed.events) yield event;
    } catch (error) {
      detached = observer.signal.aborted || this.detachRequests.has(turn.id);
      failed = !detached;
      if (detached) throw new TurnObserverDetached();
      throw error;
    }
    finally {
      if (this.observers.get(turn.id) === observer) this.observers.delete(turn.id);
      if (this.appServerObservers.get(turn.id) === codex) this.appServerObservers.delete(turn.id);
      this.detachRequests.delete(turn.id);
      await codex?.close();
      await this.releaseEndpoint(endpoint);
      if (entry) await this.release(entry, failed, detached);
    }
  }

  async *run(session: Session, turn: Turn, signal: AbortSignal, onSandbox: SaveSandbox): AsyncGenerator<AgentEvent> {
    yield* this.runAppServer(session, turn, signal, onSandbox);
  }

  private mapAppServerTurn(rawTurn: any): Turn {
    const status = rawTurn.status === 'completed' ? 'completed'
      : rawTurn.status === 'inProgress' ? 'running'
        : ['interrupted', 'aborted', 'cancelled', 'canceled'].includes(rawTurn.status) ? 'cancelled' : 'failed';
    const turn: Turn = { id: rawTurn.id, prompt: '', images: [], status, items: [], codexAccepted: true,
      startedAt: new Date((rawTurn.startedAt ?? 0) * 1000).toISOString(),
      ...(rawTurn.completedAt ? { completedAt: new Date(rawTurn.completedAt * 1000).toISOString() } : {}),
      ...(rawTurn.error?.message ? { error: rawTurn.error.message } : {}) };
    const adapter = new AppServerEventAdapter();
    for (const entry of rawTurn.items ?? []) {
      const item = entry.item ?? entry;
      if (item.type === 'userMessage') {
        turn.prompt = (item.content ?? []).filter((part: any) => part.type === 'text').map((part: any) => part.text ?? '').join('');
        continue;
      }
      const converted = adapter.convert(item);
      if (converted) turn.items.push(converted);
    }
    return turn;
  }

  private async readAppServerTurns(client: CodexAppServerClient, threadId: string, latestOnly = false): Promise<Turn[]> {
    const response = await client.request('thread/turns/list', { threadId, itemsView: 'full',
      ...(latestOnly ? { limit: 1, sortDirection: 'desc' } : {}) });
    return (response.data ?? []).map((rawTurn: any) => this.mapAppServerTurn(rawTurn));
  }

  /** Re-observe a turn already accepted by the persistent App Server without submitting its prompt again. */
  private async *recoverAppServer(session: Session, turn: Turn, signal: AbortSignal, onSandbox: SaveSandbox): AsyncGenerator<AgentEvent> {
    if (!this.options.appServer || !session.sandbox || !session.threadId || !turn.nativeTurnId || !turn.codexAccepted) {
      throw new Error('App Server turn recovery information is incomplete');
    }
    this.sandboxes.holdUsage(session, turn.id);
    const detached = new AbortController();
    this.observers.set(turn.id, detached);
    if (this.detachRequests.has(turn.id)) detached.abort(new TurnObserverDetached());
    const observerSignal = AbortSignal.any([signal, detached.signal]);
    let entry: Entry | undefined;
    let client: CodexAppServerClient | undefined;
    let endpoint: AppServerEndpoint | undefined;
    let observerDetached = false;
    let failed = false;
    let interruptSent = false;
    let interruptRequest: Promise<unknown> | undefined;
    const emittedItems = new Map<string, string>();
    const interrupt = () => {
      if (!client || interruptSent) return;
      interruptSent = true;
      interruptRequest = client.turnInterrupt({ threadId: session.threadId!, turnId: turn.nativeTurnId! });
      void interruptRequest.catch(() => {});
    };
    try {
      entry = await this.acquire(session, false, onSandbox, turn.id, observerSignal);
      endpoint = await this.options.appServer(entry.metadata.id);
      client = await CodexAppServerClient.spawn({ url: endpoint.url, headers: endpointHeaders(endpoint), requestTimeoutMs: 120_000 });
      this.appServerObservers.set(turn.id, client);
      signal.addEventListener('abort', interrupt, { once: true });
      if (signal.aborted) interrupt();
      yield { type: 'turn.started', turn_id: turn.nativeTurnId };
      while (true) {
        detached.signal.throwIfAborted();
        if (signal.aborted) { interrupt(); await interruptRequest; }
        const turns = await this.readAppServerTurns(client, session.threadId, true);
        const native = turns.find(candidate => candidate.id === turn.nativeTurnId);
        if (!native) {
          await waitFor(1000, observerSignal);
          continue;
        }
        if (!turn.prompt && native.prompt) turn.prompt = native.prompt;
        for (const item of native.items) {
          const signature = JSON.stringify(item);
          if (emittedItems.get(item.id) === signature) continue;
          const previous = emittedItems.has(item.id);
          emittedItems.set(item.id, signature);
          const inProgress = 'status' in item && item.status === 'in_progress';
          yield { type: inProgress ? (previous ? 'item.updated' : 'item.started') : 'item.completed', item };
        }
        if (native.status === 'completed') {
          yield { type: 'turn.completed', usage: { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0,
            output_tokens: 0, reasoning_output_tokens: 0 } };
          return;
        }
        if (native.status === 'failed' || native.status === 'cancelled') {
          yield { type: 'turn.failed', error: { message: native.error ?? (native.status === 'cancelled' ? 'Turn cancelled' : 'Turn failed') } };
          return;
        }
        await waitFor(1000, observerSignal);
      }
    } catch (error) {
      observerDetached = detached.signal.aborted || this.detachRequests.has(turn.id) || error instanceof TurnObserverDetached;
      failed = !observerDetached;
      if (observerDetached) throw new TurnObserverDetached();
      if (signal.aborted) {
        interrupt();
        await interruptRequest?.catch(() => {});
        throw new DOMException('任务已停止', 'AbortError');
      }
      throw this.safeError(error);
    } finally {
      if (this.observers.get(turn.id) === detached) this.observers.delete(turn.id);
      if (this.appServerObservers.get(turn.id) === client) this.appServerObservers.delete(turn.id);
      signal.removeEventListener('abort', interrupt);
      this.detachRequests.delete(turn.id);
      await client?.close();
      await this.releaseEndpoint(endpoint);
      if (entry) await this.release(entry, failed, observerDetached);
    }
  }

  async *recover(session: Session, turn: Turn, signal: AbortSignal, onSandbox: SaveSandbox): AsyncGenerator<AgentEvent> {
    yield* this.recoverAppServer(session, turn, signal, onSandbox);
  }

  detach(turn: Turn) {
    this.detachRequests.add(turn.id);
    this.observers.get(turn.id)?.abort(new TurnObserverDetached());
    void this.appServerObservers.get(turn.id)?.close();
  }

  async service(session: WorkspaceTarget, port: number, path: string, request: Request): Promise<Response> {
    if (!this.options.serviceAccess) throw new HttpError(503, 'Sandbox 服务代理未配置');
    const entry = await this.acquire(session, false);
    let access: CellboxServiceAccess | undefined;
    let released = false;
    const release = async () => {
      if (released) return;
      released = true;
      try { await access?.revoke(); }
      catch (error) { void this.options.logger?.write({ event: 'sandbox.access_release_failed', error: this.safeError(error).message }); }
      await this.release(entry, true);
    };
    try {
      access = await this.options.serviceAccess(entry.sandbox.sandboxId, port);
      const headers = new Headers(access.headers);
      for (const name of ['accept', 'accept-language', 'content-type', 'range', 'if-none-match', 'if-modified-since']) {
        const value = request.headers.get(name);
        if (value !== null) headers.set(name, value);
      }
      const url = `${access.url.replace(/\/$/, '')}${path}`;
      const upstream = await fetch(url, { method: request.method, headers,
        body: ['GET', 'HEAD'].includes(request.method) ? undefined : await request.arrayBuffer(), redirect: 'manual' });
      const outHeaders = new Headers();
      for (const name of ['content-type', 'content-disposition', 'cache-control', 'etag', 'last-modified', 'location', 'accept-ranges', 'content-range']) {
        const value = upstream.headers.get(name);
        if (value !== null) outHeaders.set(name, value);
      }
      const reader = upstream.body?.getReader();
      if (!reader) {
        await release();
        return new Response(null, { status: upstream.status, headers: outHeaders });
      }
      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const { done, value } = await reader.read();
            if (done) { controller.close(); await release(); }
            else controller.enqueue(value);
          } catch (error) { controller.error(error); await release(); }
        },
        async cancel(reason) { try { await reader.cancel(reason); } finally { await release(); } },
      });
      return new Response(stream, { status: upstream.status, headers: outHeaders });
    } catch (error) { await release(); throw error; }
  }

  async file(session: WorkspaceTarget, path: string, options?: WorkspaceFileReadOptions): Promise<WorkspaceFileResult> {
    if (this.closing) throw new HttpError(503, 'Sandbox 运行时正在关闭');
    let entry: Entry;
    try { entry = await this.acquire(session, false); }
    catch (error) { throw new HttpError(502, this.safeError(error).message); }
    let failed = false;
    try {
      return await readCellboxWorkspaceFile(entry.sandbox,
        this.node, session.settings.workingDirectory, path, options, this.sharedDocs);
    } catch (error) {
      failed = true;
      if (error instanceof HttpError) throw error;
      if (/not found|404/i.test(String(error))) await this.sandboxes.inspect(session).catch(() => { });
      throw new HttpError(502, this.safeError(error).message);
    } finally { await this.release(entry, failed); }
  }

  async history(session: Session, options: { cursor?: string; limit?: number } = {}): Promise<NativeHistory> {
    if (!session.threadId) return { turns: [] };
    if (!session.sandbox) throw new Error('Codex 会话对应的沙箱不可用');
    if (!this.options.appServer) throw new Error('Sandbox App Server endpoint is not configured');
    let entry: Entry | undefined;
    let client: CodexAppServerClient | undefined;
    let endpoint: AppServerEndpoint | undefined;
    let failed = false;
    try {
      entry = await this.acquire(session, false);
      endpoint = await this.options.appServer(entry.metadata.id);
      client = await CodexAppServerClient.spawn({ url: endpoint.url, headers: endpointHeaders(endpoint), requestTimeoutMs: 120_000 });
      const response = await client.request('thread/turns/list', { threadId: session.threadId,
        itemsView: 'full', sortDirection: 'desc', limit: options.limit ?? 20,
        ...(options.cursor ? { cursor: options.cursor } : {}) });
      return { turns: (response.data ?? []).map((rawTurn: any) => this.mapAppServerTurn(rawTurn)), nextCursor: response.nextCursor ?? null };
    } catch (error) { failed = true; throw this.safeError(error); }
    finally {
      await client?.close();
      await this.releaseEndpoint(endpoint);
      if (entry) await this.release(entry, failed);
    }
  }
  async subagents(session: Session): Promise<SubagentConversation[]> {
    if (!session.threadId) return [];
    if (!session.sandbox) return [];
    const entry = await this.acquire(session, false);
    try {
      const signal = AbortSignal.timeout(120_000);
      const helper = this.runtimeDirectory + '/native-history.mjs';
      await this.command(entry, `mkdir -p -- ${quote(this.runtimeDirectory)}`, signal);
      await this.writeAtomic(entry, helper, await readFile(new URL('./native-history.mjs', import.meta.url), 'utf8'), signal);
      const script = `import {readSubagentConversations} from ${JSON.stringify(helper)};console.log(JSON.stringify(await readSubagentConversations(${JSON.stringify(session.threadId)},${JSON.stringify(this.codexHome)})));`;
      const output = await this.command(entry, `${this.node} --input-type=module -e ${quote(script)}`, signal, { timeoutMs: 120_000 });
      return JSON.parse(output.stdout);
    } finally { await this.release(entry); }
  }
  async delete(session: WorkspaceTarget) {
    await this.sandboxes.delete(session);
    if (session.sandbox) this.runtimePreparations.delete(session.sandbox.id);
  }

  async inspect(target: WorkspaceTarget) {
    return this.sandboxes.inspect(target);
  }

  async rebuild(target: WorkspaceTarget, onSandbox: SaveSandbox) {
    if (target.sandbox) {
      let missing = false;
      try { missing = (await this.options.provider.getInfo(target.sandbox.id)).metadata?.phase === 'deleted'; }
      catch (error) {
        if ((error as { code?: string }).code === 'NOT_FOUND') missing = true;
        else throw error;
      }
      if (missing) {
        await this.detachSandbox(target);
        target.sandbox = undefined;
      }
    }
    const entry = await this.acquire(target,true,onSandbox);
    try { await this.prepareEnvironment(target, entry, AbortSignal.timeout(300_000)); } finally { await this.release(entry); }
  }
  async resume(target: WorkspaceTarget, onSandbox: SaveSandbox) {
    if (!target.sandbox) throw new HttpError(409, '项目 Sandbox 不存在');
    const entry = await this.acquire(target, false, onSandbox);
    try { await this.prepareEnvironment(target, entry, AbortSignal.timeout(300_000)); } finally { await this.release(entry); }
  }

  async checkpoint(target: WorkspaceTarget) {
    if (!target.sandbox) throw new HttpError(409, '项目 Sandbox 不存在');
    return this.sandboxes.checkpoint(target);
  }

  async verifySandbox(sandbox: SandboxState, timeoutMs?: number) {
    if (timeoutMs !== undefined) return this.verifySandboxOnce(sandbox, timeoutMs);
    const deadline = Date.now() + 30_000;
    for (;;) {
      try { return await this.verifySandboxOnce(sandbox, 5_000); }
      catch (error) {
        if (Date.now() >= deadline) throw this.safeError(error);
        await new Promise(resolve => setTimeout(resolve, 1_000));
      }
    }
  }

  async verifyHistory(sandbox: SandboxState, threadIds: string[]) {
    if (!threadIds.length) return;
    if (!this.options.appServer) throw new HttpError(503, 'Sandbox App Server 未配置');
    const endpoint = await this.options.appServer(sandbox.id);
    const client = new CodexAppServerClient({ url: endpoint.url, headers: endpointHeaders(endpoint), requestTimeoutMs: 10_000 });
    try {
      await client.connect();
      for (const threadId of [...new Set(threadIds)].slice(0, 3)) await client.request('thread/read', { threadId, includeTurns: true });
    } finally { try { await client.close(); } finally { await this.releaseEndpoint(endpoint); } }
  }

  private async verifySandboxOnce(sandbox: SandboxState, timeoutMs: number) {
    const info = await this.options.provider.getInfo(sandbox.id);
    if (info.state !== 'running') throw new HttpError(502, 'Sandbox 尚未就绪');
    const handle = await this.options.provider.connect(sandbox.id, { timeoutMs });
    await this.options.prepareRemote(handle, { id: sandbox.id, settings: { workingDirectory: sandbox.workingDirectory }, sandbox, updatedAt: new Date().toISOString() }, AbortSignal.timeout(timeoutMs));
    await handle.commands.run(`test -d ${quote(sandbox.workingDirectory)} && test -d ${quote(this.codexHome)}`, { timeoutMs });
    if (!this.options.appServer) throw new HttpError(503, 'Sandbox App Server 未配置');
    const endpoint = await this.options.appServer(sandbox.id);
    const client = new CodexAppServerClient({ url: endpoint.url, headers: endpointHeaders(endpoint), requestTimeoutMs: timeoutMs });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        (async () => { await client.connect(); await client.request('thread/list', { limit: 1 }); })(),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new HttpError(502, 'Sandbox 服务验证超时')), timeoutMs); }),
      ]);
    } finally { if (timer) clearTimeout(timer); try { await client.close(); } finally { await this.releaseEndpoint(endpoint); } }
    sandbox.status = 'ready';
    sandbox.image = info.templateIdentity;
  }

  async fenceSandbox(sandbox: SandboxState) {
    const provider = this.options.provider as SandboxProvider & { stop?: (id: string) => Promise<void> };
    try {
      if (provider.stop) await provider.stop(sandbox.id);
      else {
        const info = await provider.getInfo(sandbox.id);
        if (info.state !== 'paused') await provider.pause(sandbox.id);
      }
    } catch (error) {
      // A missing or terminally failed box cannot run work. Transport errors
      // are not proof that the old environment has stopped.
      if (!/no such (?:container|object)|not found|404|Box \S+ is (?:failed|deleted)/i.test(String(error))) throw this.safeError(error);
    }
  }

  async detachSandbox(target: WorkspaceTarget) {
    const sandboxId = target.sandbox?.id;
    await this.sandboxes.detach(target);
    if (sandboxId) this.runtimePreparations.delete(sandboxId);
  }

  async pauseDanglingSandbox(sandboxId: string) {
    await this.options.provider.pause(sandboxId).catch(error => {
      if (!/not found|no such container/i.test(String(error))) throw this.safeError(error);
    });
  }

  async deleteDanglingSandbox(sandboxId: string) {
    await this.options.provider.kill(sandboxId).catch(error => {
      if (!/not found|no such container/i.test(String(error))) throw this.safeError(error);
    });
  }

  async close() {
    this.closing = true;
    await this.sandboxes.close();
  }
}
