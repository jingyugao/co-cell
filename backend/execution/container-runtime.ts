import { traced } from '@co-cell/sandbox';
import { withNativeUserInput } from '../../util/user-input.js';
import type { SandboxImageIdentity, SandboxState } from '../../protocol/sandbox-types.js';
import type { WorkspaceTarget } from '../sandboxes/types.js';
import { createHash, randomUUID } from 'node:crypto';
import { AppServerEventAdapter, Codex, CodexAppServerClient } from '../../packages/agentcore/src/index.mjs';
import { readFile } from 'node:fs/promises';
import { basename, extname, posix } from 'node:path';
import type { SandboxHandle, SandboxInfo, SandboxProvider, SandboxLease, SandboxRecord, CellboxServiceAccess } from '@co-cell/sandbox';
import { ProjectSandboxes, type SaveSandbox } from '../sandboxes/project-sandboxes.js';
import { readCellboxWorkspaceFile, cellboxWorkspaceFileResponse } from '../sandboxes/cellbox-files.js';
import { holdResponse } from '../../util/http-stream.js';
import type { AgentEvent } from '../../protocol/types.js';
import type { Session, SubagentConversation, Turn } from '../../protocol/types.js';
import type { NativeHistory } from './native-history.mjs';
import { AppServerReader, type AppServerEndpoint } from './app-server-reader.js';
import { loadAgentDocs } from '../shared-files/agent-docs.js';
import type { RuntimeLog } from '../infra/diagnostics/runtime-log.js';
import { HttpError } from '../../util/errors.js';
import type { WorkspaceFileResult } from '../workspaces/files.js';

export interface SandboxRuntime {
	remoteArchives?: import('../archives/remote.js').RemoteArchives;
  currentImageIdentity?(target?: WorkspaceTarget): Promise<SandboxImageIdentity>;
  track?(session: WorkspaceTarget, onSandbox: (value: SandboxState) => Promise<void>): void;
  trackExecution?(session: Session, turn: Turn): void;
  run(session: Session, turn: Turn, signal: AbortSignal, onSandbox: (value: SandboxState) => Promise<void>): AsyncGenerator<AgentEvent>;
  recover(session: Session, turn: Turn, signal: AbortSignal, onSandbox: (value: SandboxState) => Promise<void>): AsyncGenerator<AgentEvent>;
  detach(turn: Turn): void;
  steer?(session: Session, turn: Turn, text: string): Promise<boolean>;
  service?(session: WorkspaceTarget, port: number, path: string, request: Request): Promise<Response>;
  file(session: WorkspaceTarget, path: string, signal?: AbortSignal): Promise<WorkspaceFileResult>;
  fileResponse?(session: WorkspaceTarget, path: string, request: Request): Promise<Response>;
  inspect?(target: WorkspaceTarget): Promise<unknown>;
  /** Read Cellbox without connecting, preparing, persisting, or renewing activity. */
  querySandbox?(sandbox: SandboxState): Promise<SandboxState>;
  /** Display-only batch observation; does not perform execution validation. */
  querySandboxes?(sandboxes: SandboxState[]): Promise<SandboxState[]>;
  history(session: Session, options?: { cursor?: string; limit?: number; signal?: AbortSignal }): Promise<NativeHistory>;
  subagents?(session: Session, signal?: AbortSignal): Promise<SubagentConversation[]>;
  delete(session: WorkspaceTarget): Promise<void>;
  rebuild(target: WorkspaceTarget, onSandbox: (value: SandboxState) => Promise<void>): Promise<void>;
  rebuildPersistent?(target: WorkspaceTarget, key: string, onSandbox: (value: SandboxState) => Promise<void>): Promise<void>;
  resume?(target: WorkspaceTarget, onSandbox: (value: SandboxState) => Promise<void>): Promise<void>;
  checkpoint?(target: WorkspaceTarget): Promise<SandboxState>;
  verifySandbox?(sandbox: SandboxState, timeoutMs?: number): Promise<void>;
  verifyHistory?(sandbox: SandboxState, threadIds: string[]): Promise<void>;
  fenceSandbox?(sandbox: SandboxState): Promise<void>;
  detachSandbox?(target: WorkspaceTarget): Promise<void>;
  pauseDanglingSandbox?(sandboxId: string): Promise<void>;
  deleteDanglingSandbox?(sandboxId: string): Promise<void>;
  /** Discover project-owned resources, including candidates whose response was lost. */
  listProjectSandboxes?(projectId: string): Promise<SandboxState[]>;
  close(): Promise<void>;
}
export type { AppServerEndpoint } from './app-server-reader.js';
export interface ContainerRuntimeOptions {
  paths: { root: string; runtime: string; codexHome: string; node: string };
  prepareRemote: (sandbox: SandboxHandle, target: WorkspaceTarget, signal: AbortSignal) => Promise<boolean>;
  acquireRemoteUsage?: (sandboxId: string, initializationDirectory?: string) => Promise<() => Promise<void>>;
  remoteArchives?: import('../archives/remote.js').RemoteArchives;
  sandboxes: ProjectSandboxes;
  provider: SandboxProvider;
  apiKey: string;
  baseUrl?: string;
  modelConfig?: Record<string, unknown>;
  configOverrides?: string[];
  sharedDataDirectory?: URL;
  sharedFilesMounted?: (sandboxId: string) => boolean;
  logger?: RuntimeLog;
  appServer?: (sandboxId: string) => Promise<AppServerEndpoint>;
  appServerReader?: AppServerReader;
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
  private readonly reader: AppServerReader;

  constructor(private options: ContainerRuntimeOptions) {
    this.sandboxes = options.sandboxes;
    this.reader = options.appServerReader ?? new AppServerReader(async id => {
      if (!options.appServer) throw new Error('Sandbox App Server endpoint is not configured');
      return options.appServer(id);
    }, error => { void options.logger?.write({ event: 'sandbox.access_release_failed', error: this.safeError(error).message }); });
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
    const safe = new Error(message);
    if (error && typeof error === 'object' && 'code' in error && error.code === 'BUSY') Object.assign(safe, { code: 'BUSY' });
    return safe;
  }

  private async acquire(target: WorkspaceTarget, create: boolean, notify?: SaveSandbox, usageId?: string, signal?: AbortSignal, initialization = false): Promise<Entry> {
    if (this.closing) throw new Error('Sandbox 运行时正在关闭');
    const lease = await this.sandboxes.acquire(target, { create, save: notify, usageId, signal });
    let preparation = this.runtimePreparations.get(lease.record.id);
    if (!preparation) {
      preparation = {};
      this.runtimePreparations.set(lease.record.id, preparation);
    }
    let releaseRemote: (() => Promise<void>) | undefined;
    try {
      releaseRemote = await this.options.acquireRemoteUsage?.(lease.record.id, initialization ? target.settings.workingDirectory : undefined);
      signal?.throwIfAborted();
    } catch (error) {
      try { await releaseRemote?.(); } finally { await lease.release(); }
      throw error;
    }
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
      const fresh = await this.options.prepareRemote(entry.sandbox, target, executionSignal);
      if (this.options.sharedFilesMounted?.(entry.sandbox.sandboxId)) return;
      // Older instances without the directory mount still receive snapshots.
      const sharedData = this.options.sharedDataDirectory ?? SHARED_DATA;
      const sharedDocs = await loadAgentDocs(new URL('docs/', sharedData));
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
    let failed = false;
    let detached = false;
    try {
      entry = await this.acquire(session, true, onSandbox, turn.id, startupSignal);
      // Publish the global AGENTS.md and shared docs before every turn.
      await this.prepareEnvironment(session, entry, startupSignal);
      observer.signal.throwIfAborted();
      const endpoint = await this.options.appServer(entry.metadata.id);
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
        appServerHeaders: endpoint.headers });
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
    let hasOriginalPrompt = false;
    for (const entry of rawTurn.items ?? []) {
      const item = entry.item ?? entry;
      if (item.type === 'userMessage') {
        const text = (item.content ?? []).filter((part: any) => part.type === 'text').map((part: any) => part.text ?? '').join('');
        if (!hasOriginalPrompt) {
          turn.prompt = text;
          hasOriginalPrompt = true;
        } else {
          (turn.additionalUserInputs ??= []).push(text);
        }
        continue;
      }
      const converted = adapter.convert(item);
      if (converted) turn.items.push(converted);
    }
    return withNativeUserInput(turn);
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
      const endpoint = await this.options.appServer(entry.metadata.id);
      client = await CodexAppServerClient.spawn({ url: endpoint.url, headers: endpoint.headers, requestTimeoutMs: 120_000 });
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
    const entry = await this.acquire(session, false, undefined, undefined, request.signal);
    let released = false;
    const release = async () => {
      if (released) return;
      released = true;
      await this.release(entry, true);
    };
    try {
      const access = await this.options.serviceAccess(entry.sandbox.sandboxId, port);
      const headers = new Headers(access.headers);
      for (const name of ['accept', 'accept-language', 'content-type', 'range', 'if-none-match', 'if-modified-since']) {
        const value = request.headers.get(name);
        if (value !== null) headers.set(name, value);
      }
      const url = `${access.url.replace(/\/$/, '')}${path}`;
      const upstream = await fetch(url, { method: request.method, headers,
        body: ['GET', 'HEAD'].includes(request.method) ? undefined : await request.arrayBuffer(), redirect: 'manual', signal: request.signal });
      const outHeaders = new Headers();
      for (const name of ['content-type', 'content-disposition', 'cache-control', 'etag', 'last-modified', 'location', 'accept-ranges', 'content-range']) {
        const value = upstream.headers.get(name);
        if (value !== null) outHeaders.set(name, value);
      }
      if (!upstream.body) {
        await release();
        return new Response(null, { status: upstream.status, headers: outHeaders });
      }
      return holdResponse(new Response(upstream.body, { status: upstream.status, headers: outHeaders }), release, request.signal);
    } catch (error) { await release(); throw error; }
  }

  async fileResponse(session: WorkspaceTarget, path: string, request: Request): Promise<Response> {
    if (this.closing) throw new HttpError(503, 'Sandbox 运行时正在关闭');
    let entry: Entry;
    try { entry = await this.acquire(session, false, undefined, undefined, request.signal); }
    catch (error) { throw new HttpError(502, this.safeError(error).message); }
    try {
      const response = await cellboxWorkspaceFileResponse(entry.sandbox, session.settings.workingDirectory, path, request);
      if (!response.body) { await this.release(entry, false); return response; }
      return holdResponse(response, () => this.release(entry, false), request.signal);
    } catch (error) {
      await this.release(entry, true);
      if (error instanceof HttpError) throw error;
      throw new HttpError(502, this.safeError(error).message);
    }
  }

  async file(session: WorkspaceTarget, path: string, signal?: AbortSignal): Promise<WorkspaceFileResult> {
    if (this.closing) throw new HttpError(503, 'Sandbox 运行时正在关闭');
    let entry: Entry;
    try { entry = await this.acquire(session, false, undefined, undefined, signal); }
    catch (error) { throw new HttpError(502, this.safeError(error).message); }
    let failed = false;
    try {
      return await readCellboxWorkspaceFile(entry.sandbox,
        session.settings.workingDirectory, path, signal);
    } catch (error) {
      failed = true;
      if (error instanceof HttpError) throw error;
      if (/not found|404/i.test(String(error))) await this.sandboxes.inspect(session).catch(() => { });
      throw new HttpError(502, this.safeError(error).message);
    } finally { await this.release(entry, failed); }
  }

  async history(session: Session, options: { cursor?: string; limit?: number; signal?: AbortSignal } = {}): Promise<NativeHistory> {
    if (!session.threadId) return { turns: [] };
    if (!session.sandbox) throw new Error('Codex 会话对应的沙箱不可用');
    return this.reader.read(session.sandbox.id, async client => {
      const response = await client.request('thread/turns/list', { threadId: session.threadId,
        itemsView: 'full', sortDirection: 'desc', limit: options.limit ?? 20,
        ...(options.cursor ? { cursor: options.cursor } : {}) });
      return { turns: (response.data ?? []).map((rawTurn: any) => this.mapAppServerTurn(rawTurn)), nextCursor: response.nextCursor ?? null };
    }, options.signal).catch(error => { throw this.safeError(error); });
  }
  async steer(session: Session, turn: Turn, text: string): Promise<boolean> {
    if (!session.sandbox || !session.threadId || !turn.nativeTurnId) return false;
    return this.reader.read(session.sandbox.id, client => client.steerTurn(session.threadId!, turn.nativeTurnId!, text));
  }
  async subagents(session: Session, signal?: AbortSignal): Promise<SubagentConversation[]> {
    if (!session.threadId) return [];
    if (!session.sandbox) return [];
    return this.reader.read(session.sandbox.id, async client => {
      type Spawn = { parent_thread_id: string; agent_path?: string; agent_nickname?: string; depth: number };
      type Thread = { id: string; createdAt: number; agentNickname?: string; source?: { subAgent?: { thread_spawn?: Spawn } } };
      const threads = new Map<string, Thread>();
      for (const archived of [false, true]) {
        let cursor: string | null = null;
        const seen = new Set<string>();
        do {
          const page: { data: Thread[]; nextCursor?: string | null } = await client.request('thread/list', {
            ancestorThreadId: session.threadId, sourceKinds: ['subAgentThreadSpawn'], archived,
            useStateDbOnly: true, limit: 100, ...(cursor ? { cursor } : {}),
          });
          for (const thread of page.data) threads.set(thread.id, thread);
          cursor = page.nextCursor ?? null;
          if (cursor && seen.has(cursor)) throw new Error('App Server returned a repeated thread cursor');
          if (cursor) seen.add(cursor);
        } while (cursor);
      }
      // Verify ancestry as well as filtering the RPC. Never expose an unrelated
      // thread if a server ignores the ancestor filter.
      const descendants = new Set([session.threadId!]);
      const children: Array<{ thread: Thread; spawn: Spawn }> = [];
      let changed: boolean;
      do {
        changed = false;
        for (const thread of threads.values()) {
          const spawn = thread.source?.subAgent?.thread_spawn;
          if (!spawn || !descendants.has(spawn.parent_thread_id) || descendants.has(thread.id)) continue;
          descendants.add(thread.id);
          children.push({ thread, spawn });
          changed = true;
        }
      } while (changed);
      const result: SubagentConversation[] = [];
      for (const { thread, spawn } of children) {
        const turns: Turn[] = [];
        let cursor: string | null = null;
        const seen = new Set<string>();
        do {
          const page: { data: any[]; nextCursor?: string | null } = await client.request('thread/turns/list', { threadId: thread.id, itemsView: 'full',
            sortDirection: 'asc', limit: 100, ...(cursor ? { cursor } : {}) });
          turns.push(...(page.data ?? []).map((raw: any) => ({ ...this.mapAppServerTurn(raw), prompt: '' })));
          cursor = page.nextCursor ?? null;
          if (cursor && seen.has(cursor)) throw new Error('App Server returned a repeated turn cursor');
          if (cursor) seen.add(cursor);
        } while (cursor);
        const nickname = spawn.agent_nickname ?? thread.agentNickname;
        result.push({ threadId: thread.id, parentThreadId: spawn.parent_thread_id,
          path: spawn.agent_path ?? thread.id, ...(nickname ? { nickname } : {}), depth: spawn.depth,
          startedAt: new Date(thread.createdAt * 1000).toISOString(), turns });
      }
      return result.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    }, signal).catch(error => { throw this.safeError(error); });
  }
  async delete(session: WorkspaceTarget) {
    await this.sandboxes.delete(session);
    if (session.sandbox) this.runtimePreparations.delete(session.sandbox.id);
  }

  async inspect(target: WorkspaceTarget) {
    return this.sandboxes.inspect(target);
  }

  async querySandbox(sandbox: SandboxState): Promise<SandboxState> {
    try {
      const info = await this.options.provider.getInfo(sandbox.id);
      return this.sandboxObservation(sandbox, info);
    } catch (error) {
      if (['NOT_FOUND', 'not_found'].includes((error as { code?: string }).code ?? '')) return { ...sandbox, status: 'unavailable' };
      throw error;
    }
  }

  async querySandboxes(sandboxes: SandboxState[]): Promise<SandboxState[]> {
    if (!sandboxes.length) return [];
    if (!this.options.provider.getInfos) throw new HttpError(503, 'Sandbox 批量状态查询未配置');
    const infos = await this.options.provider.getInfos([...new Set(sandboxes.map(sandbox => sandbox.id))]);
    const byId = new Map(infos.map(info => [info.sandboxId, info]));
    return sandboxes.map(sandbox => this.sandboxObservation(sandbox, byId.get(sandbox.id)));
  }

  private sandboxObservation(sandbox: SandboxState, info?: SandboxInfo): SandboxState {
    if (!info) return { ...sandbox, status: 'unavailable' };
    const phase = info.metadata?.phase;
    const status = info.state === 'running' ? 'ready' : info.state === 'paused' ? 'paused'
      : ['creating', 'resuming', 'restoring', 'checkpointing', 'suspending', 'staged'].includes(phase ?? '') ? 'starting' : 'unavailable';
    return { ...sandbox, status, ...(info.templateIdentity ? { image: info.templateIdentity } : {}) };
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
    const entry = await this.acquire(target, true, onSandbox, undefined, undefined, true);
    try { await this.prepareEnvironment(target, entry, AbortSignal.timeout(300_000)); } finally { await this.release(entry); }
  }
  async rebuildPersistent(target: WorkspaceTarget, key: string, onSandbox: SaveSandbox) {
    if (!target.sandbox) throw new HttpError(409, '项目 Sandbox 不存在，无法沿用挂载目录');
    const provider = this.options.provider as SandboxProvider & { rebuildPersistent?: (id: string, key: string) => Promise<void> };
    if (!provider.rebuildPersistent) throw new HttpError(503, 'Sandbox 不支持保留挂载目录重建');
    this.runtimePreparations.delete(target.sandbox.id);
    await this.sandboxes.manager.lifecycle.run({ action: 'reconcile', resourceKey: `project:${target.projectId ?? target.id}`, sandboxId: target.sandbox.id, metadata: { restoreRuntimeConfig: 'true' } },
      () => provider.rebuildPersistent!(target.sandbox!.id, key));
    await this.sandboxes.inspect(target);
    await this.resume(target, onSandbox);
  }

  async resume(target: WorkspaceTarget, onSandbox: SaveSandbox) {
    if (!target.sandbox) throw new HttpError(409, '项目 Sandbox 不存在');
    const entry = await traced('sandbox.acquire', { 'sandbox.id': target.sandbox.id },
      () => this.acquire(target, false, onSandbox, undefined, undefined, true));
    try { await this.prepareEnvironment(target, entry, AbortSignal.timeout(300_000)); } finally { await traced('sandbox.release', { 'sandbox.id': target.sandbox.id }, () => this.release(entry)); }
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
    const client = new CodexAppServerClient({ url: endpoint.url, headers: endpoint.headers, requestTimeoutMs: 10_000 });
    let verified = false;
    try {
      await client.connect();
      for (const threadId of [...new Set(threadIds)].slice(0, 3)) await client.request('thread/read', { threadId, includeTurns: true });
      verified = true;
    } finally { await this.closeVerificationClient(client, sandbox.id, verified); }
  }

  private async verifySandboxOnce(sandbox: SandboxState, timeoutMs: number) {
    const info = await this.options.provider.getInfo(sandbox.id);
    if (info.state !== 'running') throw new HttpError(502, 'Sandbox 尚未就绪');
    if (!this.options.sharedFilesMounted?.(sandbox.id)) {
      const handle = this.options.provider.connectForSetup
        ? await this.options.provider.connectForSetup(sandbox.id)
        : await this.options.provider.connect(sandbox.id, { timeoutMs });
      await handle.commands.run(`test -d ${quote(sandbox.workingDirectory)} && test -d ${quote(this.codexHome)}`, { timeoutMs });
    }
    if (!this.options.appServer) throw new HttpError(503, 'Sandbox App Server 未配置');
    const endpoint = await this.options.appServer(sandbox.id);
    const client = new CodexAppServerClient({ url: endpoint.url, headers: endpoint.headers, requestTimeoutMs: timeoutMs });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let verified = false;
    try {
      await Promise.race([
        client.connect(), // connect includes a real initialize RPC and protocol validation.
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new HttpError(502, 'Sandbox 服务验证超时')), timeoutMs); }),
      ]);
      verified = true;
    } finally { if (timer) clearTimeout(timer); await this.closeVerificationClient(client, sandbox.id, verified); }
    sandbox.status = 'ready';
    sandbox.image = info.templateIdentity;
  }

  private async closeVerificationClient(client: CodexAppServerClient, sandboxId: string, verified: boolean) {
    try { await client.close(); }
    catch (error) {
      if (verified) throw error;
      void this.options.logger?.write({ event: 'sandbox.verification_cleanup_failed', sandboxId, error });
    }
  }

  async fenceSandbox(sandbox: SandboxState) {
    const provider = this.options.provider as SandboxProvider & { stop?: (id: string) => Promise<void> };
    try {
      if (!provider.stop && (await provider.getInfo(sandbox.id)).state === 'paused') return;
      await this.sandboxes.manager.lifecycle.run({ action: 'pause', resourceKey: `sandbox:${sandbox.id}`, sandboxId: sandbox.id }, async () => {
        if (provider.stop) await provider.stop(sandbox.id);
        else await provider.pause(sandbox.id);
      });
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
    await this.sandboxes.manager.lifecycle.run({ action: 'pause', resourceKey: `sandbox:${sandboxId}`, sandboxId }, async () => {
      await this.options.provider.pause(sandboxId).catch(error => {
        if (!/not found|no such container/i.test(String(error))) throw this.safeError(error);
      });
    });
  }

  async deleteDanglingSandbox(sandboxId: string) {
    await this.sandboxes.manager.lifecycle.run({ action: 'destroy', resourceKey: `sandbox:${sandboxId}`, sandboxId }, async () => {
      await this.options.provider.kill(sandboxId).catch(error => {
        if (!/not found|no such container/i.test(String(error))) throw this.safeError(error);
      });
    });
  }

  async listProjectSandboxes(projectId: string): Promise<SandboxState[]> {
    const provider = this.options.provider as SandboxProvider & {
      listBoxes?: () => Promise<Array<{ id: string; ownerKey: string; profileId: string; workspace: string }>>;
    };
    if (!provider.listBoxes) throw new HttpError(503, 'Sandbox 不支持项目资源检查');
    return (await provider.listBoxes()).filter(box => box.ownerKey === `project:${projectId}`)
      .map(box => ({ id: box.id, template: box.profileId, workingDirectory: box.workspace, status: 'unknown' }));
  }

  async close() {
    this.closing = true;
    await this.reader.close();
    await this.sandboxes.close();
  }
}
