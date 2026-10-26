import { proxyFetch } from 'httpxy';
import { traced } from '@co-cell/sandbox';
import { withNativeUserInput } from '../../util/user-input.js';
import type { SandboxImageIdentity, SandboxState } from '../../protocol/sandbox-types.js';
import type { WorkspaceTarget } from '../sandboxes/types.js';
import { createHash, randomUUID } from 'node:crypto';
import { AppServerEventAdapter, Codex, CodexAppServerClient } from '../../packages/agentcore/src/index.mjs';
import { readFile } from 'node:fs/promises';
import { basename, extname, posix } from 'node:path';
import type { SandboxHandle, SandboxInfo, SandboxProvider, SandboxRecord, CellboxServiceAccess } from '@co-cell/sandbox';
import { ProjectSandboxes, type SaveSandbox } from '../sandboxes/project-sandboxes.js';
import { readCellboxWorkspaceFile, cellboxWorkspaceFileResponse } from '../sandboxes/cellbox-files.js';
import { holdResponse } from '../../util/http-stream.js';
import type { InputRequestHook, ThreadOptions } from '../../packages/agentcore/src/index.mjs';
import type { AgentEvent } from '../../protocol/types.js';
import type { CompactionContent, CompactionSelector, Session, SubagentConversation, Turn } from '../../protocol/types.js';
import { parseNativeCompaction, type NativeHistory } from './native-history.mjs';
import { AppServerReader, type AppServerEndpoint } from './app-server-reader.js';
import { loadAgentDocs } from '../shared-files/agent-docs.js';
import { INITIALIZE_PROJECT_FOLLOWUP, PROJECT_FOLLOWUP_FILE, projectFollowupDocument, type FollowupProject } from '../projects/followup.js';
import type { RuntimeLog } from '../infra/diagnostics/runtime-log.js';
import { HttpError } from '../../util/errors.js';
import { abortable } from '../../util/abortable.js';
import type { WorkspaceFileResult } from '../workspaces/files.js';

export interface ServiceProxyAccess {
  url: string;
  headers: Record<string, string>;
  release(): Promise<void>;
}

export interface SandboxRuntime {
  /** Native connections own transports only. App Server owns turn execution. */
  prepareNativeSession?(session: Session, signal: AbortSignal, onSandbox: SaveSandbox): Promise<{ threadId: string | null; threadOptions: Record<string, unknown>; turnOptions: { model?: string; effort?: string } }>;
  openNativeConnection?(session: Session, signal: AbortSignal): Promise<AppServerEndpoint & { release(): Promise<void> }>;
  nativeRequest?(session: Session, method: string, params: unknown): Promise<any>;
  compaction?(session: Session, selector: CompactionSelector, threadId?: string, signal?: AbortSignal): Promise<CompactionContent | undefined>;
  uploadNativeImage?(session: Session, path: string): Promise<string>;
  observe?(session: Session, turn: Turn, signal: AbortSignal): AsyncGenerator<NativeTurnObservation>;
	remoteArchives?: import('../archives/remote.js').RemoteArchives;
  currentImageIdentity?(target?: WorkspaceTarget): Promise<SandboxImageIdentity>;
  run(session: Session, turn: Turn, signal: AbortSignal, onSandbox: (value: SandboxState) => Promise<void>, onInputRequest?: InputRequestHook): AsyncGenerator<AgentEvent>;
  recover(session: Session, turn: Turn, signal: AbortSignal, onSandbox: (value: SandboxState) => Promise<void>, onInputRequest?: InputRequestHook): AsyncGenerator<AgentEvent>;
  detach(turn: Turn): void;
  interrupt?(session: Session, turn: Turn): Promise<void>;
  steer?(session: Session, turn: Turn, text: string, onInputRequest?: InputRequestHook): Promise<boolean>;
  openServiceAccess?(session: WorkspaceTarget, port: number, signal: AbortSignal): Promise<ServiceProxyAccess>;
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
  resume?(target: WorkspaceTarget, signal?: AbortSignal): Promise<void>;
  checkpoint?(target: WorkspaceTarget): Promise<void>;
  release?(target: WorkspaceTarget): Promise<SandboxState>;
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

export type NativeTurnObservation = { type: 'snapshot'; turn: Turn } | { type: 'event'; event: AgentEvent };
export type { AppServerEndpoint } from './app-server-reader.js';
export interface ContainerRuntimeOptions {
  paths: { root: string; runtime: string; codexHome: string; node: string };
  prepareRemote: (sandbox: SandboxHandle, target: WorkspaceTarget, signal: AbortSignal, info?: SandboxInfo) => Promise<boolean>;
  acquireRemoteUsage?: (sandboxId: string, initializationDirectory?: string, info?: SandboxInfo) => Promise<() => Promise<void>>;
  remoteArchives?: import('../archives/remote.js').RemoteArchives;
  sandboxes: ProjectSandboxes;
  provider: SandboxProvider;
  apiKey: string;
  baseUrl?: string;
  modelConfig?: Record<string, unknown>;
  resolveModel?: (session: Session) => Promise<Pick<ThreadOptions, 'model' | 'modelProvider' | 'providerConfig'>>;
  resolveProject?: (id: string) => Promise<FollowupProject | undefined>;
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
  preparation: Preparation;
  releaseRemote?: () => Promise<void>;
  info?: SandboxInfo;
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

  async currentImageIdentity(target?: WorkspaceTarget): Promise<SandboxImageIdentity> {
    if (target?.imageSelection) return { reference: target.imageSelection.image, id: target.imageSelection.image, repoDigests: [target.imageSelection.image] };
    const provider = this.options.provider as SandboxProvider & { currentImageIdentity?: () => Promise<SandboxImageIdentity> };
    if (!provider.currentImageIdentity) throw new Error('Sandbox provider does not support image switching');
    return provider.currentImageIdentity();
  }
  private safeError(error: unknown): Error {
    let message = error instanceof Error ? error.message : String(error);
    if (this.options.apiKey) message = message.replaceAll(this.options.apiKey, '[REDACTED]');
    const safe = new Error(message, { cause: error });
    if (error && typeof error === 'object' && 'code' in error) Object.assign(safe, { code: error.code });
    return safe;
  }

  private async acquire(target: WorkspaceTarget, create: boolean, notify?: SaveSandbox, signal?: AbortSignal, initialization = false): Promise<Entry> {
    if (this.closing) throw new Error('Sandbox 运行时正在关闭');
    const access = await this.sandboxes.acquire(target, { create, replaceMissing: initialization, save: notify, signal });
    let preparation = this.runtimePreparations.get(access.record.id);
    if (!preparation) {
      preparation = {};
      this.runtimePreparations.set(access.record.id, preparation);
    }
    let releaseRemote: (() => Promise<void>) | undefined;
    try {
      releaseRemote = await this.options.acquireRemoteUsage?.(access.record.id, initialization ? target.settings.workingDirectory : undefined, access.info);
      signal?.throwIfAborted();
    } catch (error) {
      await releaseRemote?.();
      throw error;
    }
    return { sandbox: access.sandbox, metadata: access.record, preparation, releaseRemote, info: access.info };
  }

  private async releaseEntry(entry: Entry, failed = false) {
    try {
      await entry.releaseRemote?.();
    }
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
      const fresh = await this.options.prepareRemote(entry.sandbox, target, executionSignal, entry.info);
      const project = await this.options.resolveProject?.(target.projectId ?? target.id);
      if (project) {
        const path = posix.join(project.workingDirectory, PROJECT_FOLLOWUP_FILE);
        const result = await this.command(entry,
          `${quote(this.node)} -e ${quote(INITIALIZE_PROJECT_FOLLOWUP)} ${quote(path)} ${quote(projectFollowupDocument(project))}`, executionSignal);
        if (result.exitCode !== 0) throw new Error('无法初始化项目跟进文件');
      }
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
  private async *runAppServer(session: Session, turn: Turn, signal: AbortSignal, onSandbox: SaveSandbox, onInputRequest?: InputRequestHook): AsyncGenerator<AgentEvent> {
    if (!this.options.appServer) throw new Error('Sandbox App Server endpoint is not configured');
    const observer = new AbortController();
    this.observers.set(turn.id, observer);
    if (this.detachRequests.has(turn.id)) observer.abort(new TurnObserverDetached());
    const startupSignal = AbortSignal.any([signal, observer.signal]);
    let entry: Entry | undefined;
    let codex: Codex | undefined;
    let connection: Awaited<ReturnType<AppServerReader['acquire']>> | undefined;
    let detached = false;
    try {
      const modelOptions = await this.options.resolveModel?.(session);
      entry = await this.acquire(session, true, onSandbox, startupSignal);
      // Publish the global AGENTS.md and shared docs before every turn.
      await this.prepareEnvironment(session, entry, startupSignal);
      observer.signal.throwIfAborted();
      const images: string[] = [];
      if (turn.images.length) {
        await entry.sandbox.commands.run(`mkdir -p ${quote(`${this.root}/images`)}`, { user: 'user', timeoutMs: 30_000 });
        for (const [index, path] of turn.images.entries()) {
          const destination = `${this.root}/images/${turn.id}-${index}${extname(basename(path))}`;
          await entry.sandbox.files.write(destination, new Uint8Array(await readFile(path)).buffer, { user: 'user', signal: startupSignal });
          images.push(destination);
        }
      }
      connection = await this.reader.acquire(entry.metadata.id, startupSignal);
      codex = new Codex({ apiKey: this.options.apiKey, baseUrl: this.options.baseUrl, config: this.options.modelConfig,
        configOverrides: this.options.configOverrides, appServerClient: connection.client });
      this.appServerObservers.set(turn.id, codex);
      observer.signal.throwIfAborted();
      const options = { workingDirectory: session.settings.workingDirectory, ...(session.settings.model ? { model: session.settings.model } : {}), ...modelOptions,
        modelReasoningEffort: session.settings.modelReasoningEffort, sandboxMode: 'danger-full-access' as const,
        webSearchMode: session.settings.webSearchMode, networkAccessEnabled: true, approvalPolicy: 'never' as const, skipGitRepoCheck: true, onInputRequest };
      const thread = session.threadId ? codex.resumeThread(session.threadId, options) : codex.startThread(options);
      const input = images.length ? [{ type: 'text' as const, text: turn.prompt }, ...images.map(path => ({ type: 'local_image' as const, path }))] : turn.prompt;
      const streamed = await thread.runStreamed(input, { signal });
      for await (const event of streamed.events) yield event;
    } catch (error) {
      detached = observer.signal.aborted || this.detachRequests.has(turn.id);
      if (detached) throw new TurnObserverDetached();
      throw error;
    }
    finally {
      if (this.observers.get(turn.id) === observer) this.observers.delete(turn.id);
      if (this.appServerObservers.get(turn.id) === codex) this.appServerObservers.delete(turn.id);
      this.detachRequests.delete(turn.id);
      await codex?.close();
      await connection?.release();
      // Native completion is authoritative; activity persistence is maintenance.
      if (entry) await this.releaseEntry(entry, true);
    }
  }

  async *run(session: Session, turn: Turn, signal: AbortSignal, onSandbox: SaveSandbox, onInputRequest?: InputRequestHook): AsyncGenerator<AgentEvent> {
    yield* this.runAppServer(session, turn, signal, onSandbox, onInputRequest);
  }

  async prepareNativeSession(session: Session, signal: AbortSignal, onSandbox: SaveSandbox) {
    const entry = await this.acquire(session, true, onSandbox, signal);
    try {
      await this.prepareEnvironment(session, entry, signal);
      const model = await this.options.resolveModel?.(session);
      const threadOptions = { cwd: session.settings.workingDirectory, approvalPolicy: 'never', sandbox: 'danger-full-access',
        ...(session.settings.model ? { model: session.settings.model } : {}),
        ...(model?.model ? { model: model.model } : {}), ...(model?.modelProvider ? { modelProvider: model.modelProvider } : {}),
        config: { web_search: session.settings.webSearchMode,
          'sandbox_workspace_write.network_access': true } };
      const threadId = await this.reader.read(entry.metadata.id, async client => {
        // Provider definitions belong in native configuration. The browser only
        // needs the provider name, never a channel credential.
        const edits = Object.entries(model?.providerConfig ?? {}).map(([keyPath, value]) => ({ keyPath, value, mergeStrategy: 'replace' }));
        if (edits.length) await client.request('config/batchWrite', { edits });
        // Create an initial thread on the browser's own socket, immediately
        // before its first turn. Empty paginated threads cannot be cold-resumed.
        if (!session.threadId) return null;
        let response;
        try { response = await client.request('thread/resume', { ...threadOptions, threadId: session.threadId, excludeTurns: true }); }
        catch (error) {
          const noAcceptedInput = !session.turnCount && !session.turns.some(turn => turn.codexAccepted);
          if (noAcceptedInput && error instanceof Error && /no rollout found|missing source rollout/.test(error.message)) return null;
          throw error;
        }
        if (session.threadId && model?.modelProvider && response.modelProvider && response.modelProvider !== model.modelProvider) {
          const forked = await client.request('thread/fork', { ...threadOptions, threadId: session.threadId });
          return forked.thread.id as string;
        }
        return response.thread.id as string;
      }, signal);
      return { threadId, threadOptions, turnOptions: { ...(model?.model || session.settings.model ? { model: model?.model || session.settings.model } : {}),
        effort: session.settings.modelReasoningEffort } };
    } finally { await this.releaseEntry(entry, true); }
  }

  async openNativeConnection(session: Session, signal: AbortSignal) {
    if (!this.options.appServer || !session.sandbox) throw new HttpError(409, '项目 Sandbox 尚未准备好');
    const entry = await this.acquire(session, false, undefined, signal);
    try {
      const endpoint = await this.options.appServer(entry.metadata.id);
      signal.throwIfAborted();
      return { ...endpoint, release: () => this.releaseEntry(entry, true) };
    } catch (error) { await this.releaseEntry(entry, true); throw error; }
  }

  async nativeRequest(session: Session, method: string, params: unknown) {
    if (!session.sandbox) throw new HttpError(409, '项目没有 Sandbox');
    return this.reader.read(session.sandbox.id, async client => {
      if (!['thread/start', 'thread/read'].includes(method) && session.threadId
        && (session.turnCount || session.turns.some(turn => turn.codexAccepted)))
        await client.threadResume({ threadId: session.threadId, excludeTurns: true });
      return client.request(method, params);
    });
  }

  async uploadNativeImage(session: Session, path: string) {
    const entry = await this.acquire(session, false);
    try {
      const destination = `${this.root}/images/${session.id}-${basename(path)}`;
      await entry.sandbox.commands.run(`mkdir -p ${quote(`${this.root}/images`)}`, { user: 'agent', timeoutMs: 30_000 });
      await entry.sandbox.files.write(destination, new Uint8Array(await readFile(path)), { user: 'agent' });
      return destination;
    } finally { await this.releaseEntry(entry, true); }
  }

  /** Observe an accepted turn without acquiring usage, sending input, or interrupting it. */
  async *observe(session: Session, turn: Turn, signal: AbortSignal): AsyncGenerator<NativeTurnObservation> {
    if (!session.sandbox || !session.threadId || !turn.nativeTurnId) return;
    const lease = await this.reader.acquire(session.sandbox.id, signal);
    const stream = lease.client.events();
    const adapter = new AppServerEventAdapter();
    const knownItems = new Set<string>();
    const belongs = (event: { params?: any }) => event.params?.threadId === session.threadId
      && (!event.params.turnId || event.params.turnId === turn.nativeTurnId)
      && (!event.params.turn?.id || event.params.turn.id === turn.nativeTurnId);
    const stop = () => { void stream.return(); };
    signal.addEventListener('abort', stop, { once: true });
    const snapshot = async () => {
      const boundarySignal = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
      let current: Turn | undefined;
      for (;;) {
        current = (await abortable(this.readAppServerTurns(lease.client, session.threadId!, true), boundarySignal))
          .find(candidate => candidate.id === turn.nativeTurnId);
        // Native deltas have no sequence/offset. If any crossed this read,
        // read again AFTER them instead of guessing whether to replay them.
        // A quiet read boundary avoids both missing and duplicated text.
        const crossed = stream.drain().some(event => belongs(event)
          && (event.method.startsWith('item/') || event.method.startsWith('turn/')));
        if (!crossed) break;
        boundarySignal.throwIfAborted();
      }
      if (!current) throw new Error('Native turn is unavailable for observation');
      adapter.seed(current.items);
      knownItems.clear();
      for (const item of current.items) knownItems.add(item.id);
      return current;
    };
    try {
      signal.throwIfAborted();
      // Rejoin only this existing thread, preserving its execution settings.
      await abortable(lease.client.threadResume({ threadId: session.threadId, excludeTurns: true }), signal);
      const initial = await snapshot();
      yield { type: 'snapshot', turn: initial };
      if (initial.status !== 'running') return;
      for await (const notification of stream) {
        signal.throwIfAborted();
        if (!belongs(notification)) continue;
        const itemId = notification.params?.itemId;
        if (itemId && !knownItems.has(itemId)) {
          // An item can start while the initial snapshot is being read.
          const current = await snapshot();
          yield { type: 'snapshot', turn: current };
          if (current.status !== 'running') return;
          continue;
        }
        if (notification.method === 'turn/completed') yield { type: 'snapshot', turn: await snapshot() };
        for (const event of adapter.accept(notification)) {
          if ('item' in event) knownItems.add(event.item.id);
          yield { type: 'event', event };
        }
        if (notification.method === 'turn/completed') return;
      }
      signal.throwIfAborted();
      throw new Error('App Server observation disconnected');
    } finally {
      signal.removeEventListener('abort', stop);
      await stream.return();
      await lease.release();
    }
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
          turn.userInputItemId = item.id;
          hasOriginalPrompt = true;
        } else {
          (turn.additionalUserInputs ??= []).push(text);
          (turn.additionalUserInputPositions ??= []).push({ beforeItemIndex: turn.items.length, itemId: item.id });
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
    const detached = new AbortController();
    this.observers.set(turn.id, detached);
    if (this.detachRequests.has(turn.id)) detached.abort(new TurnObserverDetached());
    const observerSignal = AbortSignal.any([signal, detached.signal]);
    let entry: Entry | undefined;
    let client: CodexAppServerClient | undefined;
    let connection: Awaited<ReturnType<AppServerReader['acquire']>> | undefined;
    let observerDetached = false;
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
      entry = await this.acquire(session, false, onSandbox, observerSignal);
      connection = await this.reader.acquire(entry.metadata.id, observerSignal);
      client = connection.client;
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
          yield { type: 'turn.failed', ...(native.status === 'cancelled' ? { cancelled: true } : {}),
            error: { message: native.error ?? (native.status === 'cancelled' ? 'Turn cancelled' : 'Turn failed') } };
          return;
        }
        await waitFor(1000, observerSignal);
      }
    } catch (error) {
      observerDetached = detached.signal.aborted || this.detachRequests.has(turn.id) || error instanceof TurnObserverDetached;
      if (observerDetached) throw new TurnObserverDetached();
      if (signal.aborted) {
        interrupt();
        await interruptRequest?.catch(() => {});
        throw new DOMException('任务已停止', 'AbortError');
      }
      throw this.safeError(error);
    } finally {
      if (this.observers.get(turn.id) === detached) this.observers.delete(turn.id);
      signal.removeEventListener('abort', interrupt);
      this.detachRequests.delete(turn.id);
      await connection?.release();
      if (entry) await this.releaseEntry(entry, true);
    }
  }

  async *recover(session: Session, turn: Turn, signal: AbortSignal, onSandbox: SaveSandbox, _onInputRequest?: InputRequestHook): AsyncGenerator<AgentEvent> {
    yield* this.recoverAppServer(session, turn, signal, onSandbox);
  }

  detach(turn: Turn) {
    this.detachRequests.add(turn.id);
    this.observers.get(turn.id)?.abort(new TurnObserverDetached());
    void this.appServerObservers.get(turn.id)?.close();
  }

  async openServiceAccess(session: WorkspaceTarget, port: number, signal: AbortSignal): Promise<ServiceProxyAccess> {
    if (!this.options.serviceAccess) throw new HttpError(503, 'Sandbox 服务代理未配置');
    const entry = await this.acquire(session, false, undefined, signal);
    let released = false;
    const release = async () => {
      if (released) return;
      released = true;
      await this.releaseEntry(entry, true);
    };
    try {
      const access = await this.options.serviceAccess(entry.sandbox.sandboxId, port);
      signal.throwIfAborted();
      return { ...access, release };
    } catch (error) { await release(); throw error; }
  }

  async service(session: WorkspaceTarget, port: number, path: string, request: Request): Promise<Response> {
    if (!this.options.serviceAccess) throw new HttpError(503, 'Sandbox 服务代理未配置');
    const entry = await this.acquire(session, false, undefined, request.signal);
    let released = false;
    const release = async () => {
      if (released) return;
      released = true;
      await this.releaseEntry(entry, true);
    };
    try {
      const access = await this.options.serviceAccess(entry.sandbox.sandboxId, port);
      const headers = new Headers(access.headers);
      for (const name of ['accept', 'accept-language', 'content-type', 'range', 'if-none-match', 'if-modified-since']) {
        const value = request.headers.get(name);
        if (value !== null) headers.set(name, value);
      }
      const url = `${access.url.replace(/\/$/, '')}${path}`;
      const upstream = await proxyFetch(new URL(access.url).origin, url, { method: request.method, headers,
        body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body, redirect: 'manual', signal: request.signal },
        { changeOrigin: true });
      const outHeaders = new Headers();
      for (const name of ['content-type', 'content-encoding', 'content-length', 'vary', 'content-disposition', 'cache-control', 'etag', 'last-modified', 'location', 'accept-ranges', 'content-range']) {
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
    try { entry = await this.acquire(session, false, undefined, request.signal); }
    catch (error) { throw Object.assign(new HttpError(502, this.safeError(error).message), { cause: this.safeError(error) }); }
    try {
      const response = await cellboxWorkspaceFileResponse(entry.sandbox, session.settings.workingDirectory, path, request);
      if (!response.body) { await this.releaseEntry(entry, false); return response; }
      return holdResponse(response, () => this.releaseEntry(entry, false), request.signal);
    } catch (error) {
      await this.releaseEntry(entry, true);
      if (error instanceof HttpError) throw error;
      throw Object.assign(new HttpError(502, this.safeError(error).message), { cause: this.safeError(error) });
    }
  }

  async file(session: WorkspaceTarget, path: string, signal?: AbortSignal): Promise<WorkspaceFileResult> {
    if (this.closing) throw new HttpError(503, 'Sandbox 运行时正在关闭');
    let entry: Entry;
    try { entry = await this.acquire(session, false, undefined, signal); }
    catch (error) { throw Object.assign(new HttpError(502, this.safeError(error).message), { cause: this.safeError(error) }); }
    let failed = false;
    try {
      return await readCellboxWorkspaceFile(entry.sandbox,
        session.settings.workingDirectory, path, signal);
    } catch (error) {
      failed = true;
      if (error instanceof HttpError) throw error;
      throw Object.assign(new HttpError(502, this.safeError(error).message), { cause: this.safeError(error) });
    } finally { await this.releaseEntry(entry, failed); }
  }

  async compaction(session: Session, selector: CompactionSelector, threadId = session.threadId!, signal?: AbortSignal): Promise<CompactionContent | undefined> {
    if (!session.sandbox || !session.threadId) throw new HttpError(404, '会话没有可读取的原生记录');
    return this.reader.read(session.sandbox.id, async client => {
      let current = threadId;
      let path: string | undefined;
      const seen = new Set<string>();
      for (;;) {
        if (seen.has(current) || seen.size >= 32) throw new HttpError(404, '找不到此会话的子线程');
        seen.add(current);
        const { thread } = await client.request('thread/read', { threadId: current, includeTurns: false });
        if (thread?.id !== current) throw new HttpError(404, '原生线程不匹配');
        if (current === threadId) path = thread.path;
        if (current === session.threadId) break;
        current = thread.source?.subAgent?.thread_spawn?.parent_thread_id;
        if (!current) throw new HttpError(404, '此线程不属于当前会话');
      }
      // The path comes from verified thread metadata, never from an HTTP caller.
      if (!path || !posix.isAbsolute(path) || !posix.basename(path).endsWith(`${threadId}.jsonl`))
        throw new HttpError(404, '原生线程没有可读取的会话文件');
      const result = await client.request('fs/readFile', { path });
      const maxBytes = 64 * 1024 * 1024;
      if (typeof result.dataBase64 !== 'string' || result.dataBase64.length > Math.ceil(maxBytes / 3) * 4)
        throw new HttpError(413, 'Codex 会话记录超过 64 MB 读取限制');
      const bytes = Buffer.from(result.dataBase64, 'base64');
      if (bytes.length > maxBytes) throw new HttpError(413, 'Codex 会话记录超过 64 MB 读取限制');
      const source = bytes.toString('utf8');
      let metadata;
      try { metadata = JSON.parse(source.slice(0, source.indexOf('\n'))); }
      catch { throw new HttpError(409, 'Codex 会话记录尚未写入完成，请稍后重试'); }
      if (metadata.type !== 'session_meta' || metadata.payload?.id !== threadId)
        throw new HttpError(409, 'Codex 会话记录与线程不匹配');
      return parseNativeCompaction(source, selector);
    }, signal).catch(error => { throw error instanceof HttpError ? error : this.safeError(error); });
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
  async steer(session: Session, turn: Turn, text: string, onInputRequest?: InputRequestHook): Promise<boolean> {
    if (!session.sandbox || !session.threadId || !turn.nativeTurnId) return false;
    return this.reader.read(session.sandbox.id, client => client.steerTurn(session.threadId!, turn.nativeTurnId!, text, onInputRequest));
  }
  async interrupt(session: Session, turn: Turn): Promise<void> {
    if (!session.sandbox || !session.threadId || !turn.nativeTurnId) {
      throw new Error('App Server turn interruption information is incomplete');
    }
    await this.reader.read(session.sandbox.id, client =>
      client.turnInterrupt({ threadId: session.threadId!, turnId: turn.nativeTurnId! }));
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
    // Disk capture holds a provider operation on a suspended box. That fence
    // prevents execution but does not change its paused runtime state.
    const status = info.state === 'running' ? 'ready' : info.state === 'paused' || phase === 'suspended' ? 'paused'
      : ['creating', 'resuming', 'restoring', 'checkpointing', 'suspending', 'staged'].includes(phase ?? '') ? 'starting' : 'unavailable';
    return { ...sandbox, status, phase, generation: info.metadata?.generation ? Number(info.metadata.generation) : undefined,
      ...(info.metadata?.ownerKey ? { ownerKey: info.metadata.ownerKey } : {}),
      ...(info.mounts ? { mounts: structuredClone(info.mounts) } : {}),
      ...(info.homeVolumeId ? { homeVolumeId: info.homeVolumeId } : {}),
      operationId: info.metadata?.operationId, observedAt: new Date().toISOString(), ...(info.templateIdentity ? { image: info.templateIdentity } : {}) };
  }

  async rebuild(target: WorkspaceTarget, onSandbox: SaveSandbox) {
    const entry = await this.acquire(target, true, onSandbox, undefined, true);
    try { await this.prepareEnvironment(target, entry, AbortSignal.timeout(300_000)); } finally { await this.releaseEntry(entry); }
  }
  async rebuildPersistent(_target: WorkspaceTarget, _requestId: string, _onSandbox: SaveSandbox): Promise<void> {
    throw new HttpError(422, '当前 Cellbox 不支持同 ID 重建；请明确选择从备份创建新环境。');
  }

  async resume(target: WorkspaceTarget, signal?: AbortSignal): Promise<void> {
    await this.sandboxes.refresh(target);
    if (!target.sandbox) throw new HttpError(409, '项目 Sandbox 不存在');
    if (!this.options.provider.resume) throw new HttpError(503, 'Sandbox 不支持恢复运行');
    await traced('sandbox.resume', { 'sandbox.id': target.sandbox.id },
      () => this.options.provider.resume!(target.sandbox!.id, { signal }));
  }

  async checkpoint(target: WorkspaceTarget): Promise<void> {
    await this.sandboxes.refresh(target);
    if (!target.sandbox) throw new HttpError(409, '项目 Sandbox 不存在');
    const sandboxId = target.sandbox.id;
    await this.sandboxes.lifecycle.run({ action: 'checkpoint',
      resourceKey: target.projectId ? `project:${target.projectId}` : `session:${target.id}`, sandboxId }, async () => {
      await this.reader.closeIdle(sandboxId);
      await traced('sandbox.checkpoint', { 'sandbox.id': sandboxId },
        () => this.options.provider.pause(sandboxId));
    });
  }

  async release(target: WorkspaceTarget): Promise<SandboxState> {
    await this.sandboxes.refresh(target);
    if (!target.sandbox) throw new HttpError(409, '项目 Sandbox 不存在');
    if (!this.options.provider.release) throw new HttpError(503, 'Sandbox 不支持保留磁盘的释放操作');
    const sandboxId = target.sandbox.id;
    const info = await this.sandboxes.lifecycle.run({ action: 'pause',
      resourceKey: target.projectId ? `project:${target.projectId}` : `session:${target.id}`, sandboxId }, async () => {
      await this.reader.closeIdle(sandboxId);
      const provider = this.options.provider;
      return traced('sandbox.release', { 'sandbox.id': sandboxId },
        () => provider.ensureDeleted ? provider.ensureDeleted(sandboxId) : provider.release!(sandboxId));
    }).catch(error => {
      if (['NOT_FOUND', 'not_found'].includes((error as { code?: string }).code ?? '')) return undefined;
      throw error;
    });
    return info ? this.sandboxObservation(target.sandbox, info)
      : { ...target.sandbox, status: 'unavailable', phase: 'deleted', operationId: undefined };
  }


  async verifySandbox(sandbox: SandboxState, timeoutMs?: number) {
    return this.verifySandboxOnce(sandbox, timeoutMs ?? 30_000);
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
    const signal = AbortSignal.timeout(timeoutMs);
    const info = await abortable(this.options.provider.getInfo(sandbox.id), signal);
    if (info.state !== 'running') throw new HttpError(502, 'Sandbox 尚未就绪');
    if (!this.options.sharedFilesMounted?.(sandbox.id)) {
      const handle = await abortable(this.options.provider.connectForSetup
        ? this.options.provider.connectForSetup(sandbox.id)
        : this.options.provider.connect(sandbox.id, { timeoutMs, signal }), signal);
      await abortable(handle.commands.run(`test -d ${quote(sandbox.workingDirectory)} && test -d ${quote(this.codexHome)}`, { timeoutMs, signal }), signal);
    }
    if (!this.options.appServer) throw new HttpError(503, 'Sandbox App Server 未配置');
    await this.reader.waitUntilReady(sandbox.id, signal, timeoutMs);
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
      await this.sandboxes.lifecycle.run({ action: 'pause', resourceKey: `sandbox:${sandbox.id}`, sandboxId: sandbox.id }, async () => {
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
    if (sandboxId) this.runtimePreparations.delete(sandboxId);
  }

  async pauseDanglingSandbox(sandboxId: string) {
    await this.sandboxes.lifecycle.run({ action: 'pause', resourceKey: `sandbox:${sandboxId}`, sandboxId }, async () => {
      await this.options.provider.pause(sandboxId).catch(error => {
        if (!/not found|no such container/i.test(String(error))) throw this.safeError(error);
      });
    });
  }

  async deleteDanglingSandbox(sandboxId: string) {
    await this.sandboxes.lifecycle.run({ action: 'destroy', resourceKey: `sandbox:${sandboxId}`, sandboxId }, async () => {
      const provider = this.options.provider;
      await (provider.ensureDeleted ? provider.ensureDeleted(sandboxId) : provider.kill(sandboxId)).catch(error => {
        if (['NOT_FOUND', 'not_found'].includes((error as { code?: string }).code ?? '')) return;
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
  }
}
