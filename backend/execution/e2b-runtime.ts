import type { SandboxState, SandboxDataArchive } from '../../protocol/sandbox-types.js';
import type { WorkspaceTarget, ThreadWorkspace } from '../sandboxes/types.js';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { basename, extname, join, posix } from 'node:path';
import { tmpdir } from 'node:os';
import type { Sandbox, CommandHandle, ConnectionOpts } from 'e2b';
import { E2BSandboxManager, type SandboxLease, type SandboxRecord, type SandboxSnapshotArchive } from '@swarm-hive/sandbox';
import { ProjectSandboxes, type SaveSandbox } from '../sandboxes/project-sandboxes.js';
import type { AgentEvent, ContextUsage } from '../../protocol/types.js';
import type { RequestUserApproval } from '../../protocol/approval-types.js';
import type { Changes, RawToolPage, Session, Turn } from '../../protocol/types.js';
import type { NativeHistory } from './native-history.mjs';
import { loadAgentDocs } from '../shared-files/agent-docs.js';
import { CONNECTION_ROOT, type ConnectionStore } from '../connections/store.js';
import { syncSandboxConnections } from '../connections/sandbox-sync.js';
import type { RuntimeLog } from '../infra/diagnostics/runtime-log.js';
import type { ImprovementContext, ImprovementReceipt } from '../../protocol/improvement-types.js';
import { HttpError } from '../../util/errors.js';
import type { ModelProxyKind } from './model-proxy.js';
import { parseWorkspaceFile, READ_SANDBOX_FILE_SCRIPT, workspaceFileRequest, type WorkspaceFileResult, type WorkspaceFileReadOptions } from '../workspaces/files.js';
import { archiveSandbox, restoreSandbox, deleteDanglingSandbox, pauseDanglingSandbox, type SandboxRestoreOptions } from './sandbox-upgrade.js';
import { LocalSandboxArchiveStorage, type SandboxArchiveStorage } from '../sandboxes/archive-storage.js';

export type { SandboxSnapshotArchive } from '@swarm-hive/sandbox';

export interface E2BRuntime {
  track?(session: WorkspaceTarget, onSandbox: (value: SandboxState) => Promise<void>): void;
  trackExecution?(session: Session, turn: Turn): void;
  run(session: Session, turn: Turn, signal: AbortSignal, onSandbox: (value: SandboxState) => Promise<void>, onApproval?: RequestUserApproval, onExecution?: () => Promise<void>): AsyncGenerator<AgentEvent>;
  recover(session: Session, turn: Turn, signal: AbortSignal, onSandbox: (value: SandboxState) => Promise<void>, onApproval?: RequestUserApproval, onExecution?: () => Promise<void>): AsyncGenerator<AgentEvent>;
  detach(turn: Turn): void;
  changes(session: WorkspaceTarget): Promise<Changes>;
  preview(session: WorkspaceTarget, port: number): Promise<string>;
  file(session: WorkspaceTarget, path: string, options?: WorkspaceFileReadOptions): Promise<WorkspaceFileResult>;
  rawTools(session: ThreadWorkspace, cursor?: number): Promise<RawToolPage>;
  history(session: ThreadWorkspace, includeBlocks?: boolean): Promise<NativeHistory>;
  delete(session: WorkspaceTarget): Promise<void>;
  archiveSandbox?(target: WorkspaceTarget, threadIds: string[], onSandbox: SaveSandbox): Promise<SandboxDataArchive>;
  restoreSandbox?(target: WorkspaceTarget, archive: SandboxDataArchive, options: SandboxRestoreOptions): Promise<void>;
  detachSandbox?(target: WorkspaceTarget): Promise<void>;
  verifyDataArchive?(archive: SandboxDataArchive): Promise<void>;
  deleteDataArchive?(archive: SandboxDataArchive): Promise<void>;
  pauseDanglingSandbox?(sandboxId: string, provenance?: SandboxDataArchive): Promise<void>;
  deleteDanglingSandbox?(sandboxId: string, provenance?: SandboxDataArchive): Promise<void>;
  close(): Promise<void>;
}
export interface E2BCodexOptions {
  connection: ConnectionOpts;
  sandboxes?: ProjectSandboxes;
  template: string;
  archives?: SandboxSnapshotArchive;
  dataArchives?: SandboxArchiveStorage;
  apiKey: string;
  baseUrl?: string;
  proxyKind?: ModelProxyKind;
  modelConfig?: Record<string, unknown>;
  configOverrides?: string[];
  sharedDataDirectory?: URL;
  connections?: ConnectionStore;
  logger?: RuntimeLog;
  submitImprovement?: (context: Omit<ImprovementContext, 'projectName'>, input: unknown, requestId: string) => Promise<ImprovementReceipt>;
}
type Preparation = {
  preparing?: Promise<void>;
  sharedDocPaths?: Set<string>;
  initialized?: boolean;
};
type Entry = {
  sandbox: Sandbox;
  readonly metadata: SandboxRecord;
  lease: SandboxLease;
  preparation: Preparation;
};
type WorkerEnvelope = { v: 1; workerId: string; turnId: string; seq: number; event: Record<string, unknown> };
type WorkerState = {
  protocolVersion: 1; workerId: string; sessionId: string; turnId: string; pid: number;
  status: 'running' | 'completed' | 'failed' | 'cancelled'; threadId: string | null; lastSeq: number; error?: string
};
type WorkerEvent = Record<string, unknown> & { type: string; requestId?: string; input?: unknown; diagnostic?: Record<string, unknown> };
export class TurnObserverDetached extends Error {
  constructor() { super('Web observer detached'); this.name = 'TurnObserverDetached'; }
}
export class TurnTerminationUnconfirmed extends TurnObserverDetached {
  constructor() {
    super();
    this.name = 'TurnTerminationUnconfirmed';
    this.message = '沙箱中的停止操作尚未确认，请稍后重试停止。';
  }
}
export class TurnLaunchCancelled extends Error {
  constructor() { super('Web shut down before the worker was launched'); this.name = 'TurnLaunchCancelled'; }
}
// Command budgets are execution policy, separate from the sandbox's idle lease.
const COMMAND_TIMEOUT_MS = 3 * 60 * 60 * 1000;
const ROOT = '/home/user/.codex-web';
const RUNTIME = `${ROOT}/runtime`;
const CODEX_HOME = '/home/user/.codex';
const SHARED_DATA = new URL('../../data/', import.meta.url);
const SHARED_DOCS = `${CODEX_HOME}/docs`;
const SANDBOX_PERSISTENCE_GUIDANCE = `# Sandbox persistence

The platform may replace or reclaim this project's sandbox. It persists the project workspace and Codex conversation context, then restores them into a new sandbox.

- Keep durable code, files, and business data inside the project workspace.
- Operating-system packages, global installations, running processes, terminals, and port services are not preserved.
- Declare dependencies in manifests and lockfiles, and keep repeatable setup and startup scripts in the workspace so the environment can be rebuilt.
- Platform-managed credentials, shared rules, and shared documents are synchronized again after restoration; do not copy secrets into the repository.`;
// Keep control processes independent of a project's Node selection. Legacy base
// sandboxes retain their existing interpreter until moved to the dev template.
const NODE = '"$(if test -x /opt/codex-runtime/bin/node; then echo /opt/codex-runtime/bin/node; else command -v node; fi)"';
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const checkAbort = (signal: AbortSignal) => { if (signal.aborted) throw new DOMException('任务已停止', 'AbortError'); };
const transportFailure = (error: unknown) => /timeout|timed out|network|fetch failed|ECONN|EAI_AGAIN|ENOTFOUND|socket|5\d\d|429|unavailable|transport/i.test(String(error));

/** Prepares and observes Codex workers using independently managed sandbox leases. */
export class E2BCodexRuntime implements E2BRuntime {
  private closing = false;
  private runtimePreparations = new Map<string, Preparation>();
  private observers = new Map<string, AbortController>();
  private detachRequests = new Set<string>();
  private preparations = new Map<string, AbortController>();
  private readonly sandboxes: ProjectSandboxes;
  private readonly dataArchives: SandboxArchiveStorage;
  private upgrading = new Set<string>();

  constructor(private options: E2BCodexOptions) {
    this.dataArchives = options.dataArchives ?? new LocalSandboxArchiveStorage(new URL('../../data/sandbox-data-archives/', import.meta.url));
    this.sandboxes = options.sandboxes ?? new ProjectSandboxes(new E2BSandboxManager({
      connection: options.connection, archives: options.archives, logger: options.logger,
    }), options.template);
  }

  track(target: WorkspaceTarget, notify: SaveSandbox) { this.sandboxes.track(target, notify); }
  trackExecution(session: Session, turn: Turn) {
    if (turn.execution && session.sandbox && (!turn.execution.sandboxId || turn.execution.sandboxId === session.sandbox.id)) {
      this.sandboxes.holdUsage(session, turn.execution.workerId);
    }
  }
  setDefaultTemplate(template: string) { this.sandboxes.setDefaultTemplate(template); }

  private safeError(error: unknown): Error {
    let message = error instanceof Error ? error.message : String(error);
    for (const secret of [this.options.apiKey, this.options.connection.apiKey]) if (secret) message = message.replaceAll(secret, '[REDACTED]');
    return new Error(message);
  }

  private async acquire(target: WorkspaceTarget, create: boolean, notify?: SaveSandbox, usageId?: string, signal?: AbortSignal): Promise<Entry> {
    if (this.closing) throw new Error('E2B 运行时正在关闭');
    if (this.upgrading.has(target.projectId ?? target.id)) throw new HttpError(409, '项目沙箱正在升级，请稍后重试');
    const lease = await this.sandboxes.acquire(target, { create, save: notify, usageId, signal });
    let preparation = this.runtimePreparations.get(lease.record.id);
    if (!preparation) {
      preparation = {};
      this.runtimePreparations.set(lease.record.id, preparation);
    }
    return { sandbox: lease.sandbox, get metadata() { return lease.record; }, lease, preparation };
  }

  private async release(entry: Entry, failed = false, detached = false) {
    try { await entry.lease.release({ detached }); }
    catch (error) {
      void this.options.logger?.write({ event: 'sandbox.release_failed', sandboxId: entry.metadata.id, message: this.safeError(error).message });
      if (!failed) throw this.safeError(error);
    }
  }

  private runDirectory(turn: Turn) {
    if (!/^[0-9a-f-]{36}$/i.test(turn.id) || !turn.execution || !/^[0-9a-f-]{36}$/i.test(turn.execution.workerId)) {
      throw new Error('E2B worker identity is invalid');
    }
    return `${RUNTIME}/turns/${turn.id}/${turn.execution.workerId}`;
  }

  private async readWorkerState(entry: Entry, turn: Turn): Promise<WorkerState | undefined> {
    try { return JSON.parse(await entry.sandbox.files.read(`${this.runDirectory(turn)}/state.json`, { user: 'user' })); }
    catch (error) { if ((error as Error).message.includes('404') || /not found/i.test(String(error))) return undefined; throw error; }
  }

  private async readWorkerEvents(entry: Entry, turn: Turn): Promise<WorkerEnvelope[]> {
    let contents: string;
    try { contents = await entry.sandbox.files.read(`${this.runDirectory(turn)}/events.jsonl`, { user: 'user' }); }
    catch (error) { if ((error as Error).message.includes('404') || /not found/i.test(String(error))) return []; throw error; }
    const lines = contents.split('\n');
    const result: WorkerEnvelope[] = [];
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      if (!line.trim()) continue;
      let envelope: WorkerEnvelope;
      try {
        envelope = JSON.parse(line) as WorkerEnvelope;
      } catch {
        // Only an incomplete trailing append is recoverable.
        if (index !== lines.length - 1) throw new Error('E2B worker journal contains an invalid event');
        continue;
      }
      if (envelope.v !== 1 || envelope.workerId !== turn.execution?.workerId || envelope.turnId !== turn.id
        || !Number.isSafeInteger(envelope.seq) || envelope.seq !== result.length + 1
        || !envelope.event || typeof envelope.event.type !== 'string') throw new Error('E2B worker journal contains an invalid envelope');
      result.push(envelope);
    }
    return result;
  }

  private async observeRead<T>(read: () => Promise<T>, signal: AbortSignal): Promise<T> {
    while (true) {
      signal.throwIfAborted();
      try { return await read(); }
      catch (error) {
        // A lost Web-to-E2B connection says nothing about whether the remote
        // worker is alive. Keep its turn reserved until observation recovers.
        if (!transportFailure(error)) throw error;
        await new Promise<void>((resolve, reject) => {
          const done = () => { signal.removeEventListener('abort', abort); resolve(); };
          const timer = setTimeout(done, 1000);
          const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason); };
          signal.addEventListener('abort', abort, { once: true });
          if (signal.aborted) abort();
        });
      }
    }
  }

  private async *observeWorker(entry: Entry, session: Session, turn: Turn, signal: AbortSignal,
    onApproval?: RequestUserApproval, onExecution?: () => Promise<void>): AsyncGenerator<AgentEvent> {
    const detached = new AbortController();
    this.observers.set(turn.id, detached);
    if (this.detachRequests.has(turn.id)) detached.abort(new TurnObserverDetached());
    const observerSignal = AbortSignal.any([signal, detached.signal]);
    const approvalTasks = new Map<string, Promise<void>>();
    const improvementTasks = new Map<string, Promise<void>>();
    let idleSince = 0;
    let deadSince = 0;
    let lastHealthCheck = 0;
    try {
      while (true) {
        if (detached.signal.aborted) throw new TurnObserverDetached();
        signal.throwIfAborted();
        const envelopes = await this.observeRead(() => this.readWorkerEvents(entry, turn), observerSignal);
        const cancelledApprovals = new Set(envelopes.filter(value => value.event.type === 'runtime.user_approval_cancelled')
          .map(value => value.event.requestId));
        let advanced = false;
        for (const envelope of envelopes) {
          if (detached.signal.aborted) throw new TurnObserverDetached();
          signal.throwIfAborted();
          const event = envelope.event as WorkerEvent;
          const applied = envelope.seq <= (turn.execution?.lastAppliedSeq ?? 0);
          const control = event.type === 'runtime.user_approval_request' || event.type === 'runtime.improvement_proposal';
          // The UI cursor does not acknowledge delivery of a control reply. Replay
          // those requests after a Web crash, using their durable business IDs.
          if (applied && !control) continue;
          if (!applied && envelope.seq !== (turn.execution?.lastAppliedSeq ?? 0) + 1) throw new Error('E2B worker journal has an event gap');
          if (event.type === 'runtime.user_approval_request') {
            const requestId = event.requestId;
            if (requestId && !/^[0-9a-f-]{36}$/i.test(requestId)) throw new Error('Invalid worker approval request ID');
            if (onApproval && requestId && !cancelledApprovals.has(requestId) && !approvalTasks.has(requestId)) {
              const task = (async () => {
                let reply;
                try { reply = { ok: true, approval: await onApproval(requestId, event.input, signal) }; }
                catch {
                  if (detached.signal.aborted) return;
                  reply = { ok: false, error: '未获得用户同意，请检查请求内容或等待状态。不得执行该操作。' };
                }
                observerSignal.throwIfAborted();
                await this.writeAtomic(entry, `${this.runDirectory(turn)}/approvals/${requestId}.json`, JSON.stringify(reply), observerSignal);
              })().catch(() => { approvalTasks.delete(requestId); });
              approvalTasks.set(requestId, task);
            }
          } else if (event.type === 'runtime.improvement_proposal') {
            const requestId = event.requestId;
            if (requestId && !/^[0-9a-f-]{36}$/i.test(requestId)) throw new Error('Invalid worker improvement request ID');
            if (requestId && this.options.submitImprovement && !improvementTasks.has(requestId)) {
              const task = (async () => {
                let reply;
                try {
                  const receipt = await this.options.submitImprovement!({
                    projectId: session.projectId ?? null,
                    sessionId: session.id, sessionTitle: session.title, turnId: turn.id, sandboxId: entry.metadata.id
                  }, event.input, requestId);
                  reply = { ok: true, receipt };
                } catch { reply = { ok: false, error: '建议未能保存，请检查五个字段均为有效文本后重试。' }; }
                observerSignal.throwIfAborted();
                await this.writeAtomic(entry, `${this.runDirectory(turn)}/improvements/${requestId}.json`, JSON.stringify(reply), observerSignal);
              })().catch(() => { improvementTasks.delete(requestId); });
              improvementTasks.set(requestId, task);
            }
          } else if (event.type === 'runtime.diagnostic') {
            const allowed = ['event', 'requestId', 'method', 'path', 'upstream', 'status', 'httpStatus', 'durationMs', 'requestBytes', 'responseBytes', 'model', 'inputItems', 'responseId', 'upstreamRequestId', 'requestIds', 'error', 'message', 'code', 'terminalEvent', 'terminationReason', 'reason', 'incompleteReason', 'transportComplete', 'contentType', 'contentEncoding', 'sseEvents', 'parseError', 'clientAborted', 'requestAttempt', 'attempt', 'maxRetries', 'delayMs', 'nextRetryAt', 'channelId', 'inputTokens', 'cachedInputTokens', 'outputTokens', 'rawUsage'];
            const diagnostic = event.diagnostic;
            if (diagnostic && typeof diagnostic === 'object') {
              const fields = Object.fromEntries(allowed.filter(key => key in diagnostic).map(key => [key, diagnostic[key]]));
              void this.options.logger?.write({
                ...fields, source: 'e2b-proxy', sessionId: session.id, projectId: session.projectId,
                turnId: turn.id, threadId: session.threadId, sandboxId: entry.metadata.id, model: session.settings.model
              });
              const inputTokens = diagnostic.inputTokens;
              const cachedInputTokens = diagnostic.cachedInputTokens;
              const outputTokens = diagnostic.outputTokens;
              if (diagnostic.event === 'api.completed' && typeof inputTokens === 'number' && Number.isSafeInteger(inputTokens) && inputTokens >= 0) {
                yield {
                  type: 'runtime.context_usage',
                  contextUsage: {
                    model: session.settings.model,
                    source: 'responses',
                    ...(typeof diagnostic.requestId === 'string' ? { requestId: diagnostic.requestId } : {}),
                    ...(typeof diagnostic.responseId === 'string' ? { responseId: diagnostic.responseId } : {}),
                    ...(typeof diagnostic.requestAttempt === 'number' && Number.isSafeInteger(diagnostic.requestAttempt) && diagnostic.requestAttempt > 0
                      ? { requestAttempt: diagnostic.requestAttempt } : {}),
                    ...(diagnostic.requestIds && typeof diagnostic.requestIds === 'object'
                      ? { requestIds: Object.fromEntries(Object.entries(diagnostic.requestIds).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) } : {}),
                    ...(diagnostic.rawUsage && typeof diagnostic.rawUsage === 'object'
                      ? { rawUsage: diagnostic.rawUsage as ContextUsage['rawUsage'] } : {}),
                    inputTokens,
                    ...(typeof cachedInputTokens === 'number' && Number.isSafeInteger(cachedInputTokens) && cachedInputTokens >= 0
                      ? { cachedInputTokens } : {}),
                    ...(typeof outputTokens === 'number' && Number.isSafeInteger(outputTokens) && outputTokens >= 0
                      ? { outputTokens } : {}),
                    observedAt: new Date().toISOString(),
                  },
                };
              }
            }
          } else if (!event.type.startsWith('runtime.worker_')) {
            yield event as unknown as AgentEvent;
          }
          if (!applied) {
            // The consumer must apply and persist the yielded event before a
            // concurrent save can expose its cursor. Replaying an already
            // saved SDK item is idempotent; skipping an unapplied item is not.
            if (turn.execution) turn.execution.lastAppliedSeq = envelope.seq;
            await onExecution?.();
            advanced = true;
          }
        }
        const state = await this.observeRead(() => this.readWorkerState(entry, turn), observerSignal);
        if (state && (state.workerId !== turn.execution?.workerId || state.turnId !== turn.id || state.sessionId !== session.id
          || state.protocolVersion !== 1 || !Number.isSafeInteger(state.lastSeq) || state.lastSeq < 0
          || !Number.isSafeInteger(state.pid) || state.pid <= 1)) {
          throw new Error('E2B worker state does not match this turn');
        }
        // The worker can finish between our journal read and state read. Drain
        // the final committed sequence before acting on its terminal state.
        const drained = state && (turn.execution?.lastAppliedSeq ?? 0) >= state.lastSeq;
        if (drained && state.status === 'completed') return;
        if (drained && state.status === 'failed') throw this.safeError(state.error || 'E2B Codex worker failed');
        if (drained && state.status === 'cancelled') throw new DOMException('任务已停止', 'AbortError');
        if (state?.status === 'running' && Date.now() - lastHealthCheck >= 5_000) {
          lastHealthCheck = Date.now();
          const alive = await entry.sandbox.commands.run(`kill -0 ${state.pid}`, { user: 'user', timeoutMs: 5_000 })
            .then(() => true, error => (error as { exitCode?: number }).exitCode === 1 ? false : undefined);
          if (alive !== false) deadSince = 0;
          else if (!deadSince) deadSince = Date.now();
          else if (Date.now() - deadSince >= 2_000) throw new Error('E2B Codex worker exited without a terminal event');
        }
        if (advanced) idleSince = 0;
        else idleSince ||= Date.now();
        if (!state && idleSince && Date.now() - idleSince > 30_000) throw new Error('E2B Codex worker state missing');
        await new Promise<void>((resolve, reject) => {
          const done = () => { observerSignal.removeEventListener('abort', abort); resolve(); };
          const timer = setTimeout(done, 250);
          const abort = () => { clearTimeout(timer); observerSignal.removeEventListener('abort', abort); reject(observerSignal.reason); };
          observerSignal.addEventListener('abort', abort, { once: true });
          if (observerSignal.aborted) abort();
        }).catch(error => { if (detached.signal.aborted) throw new TurnObserverDetached(); throw error; });
      }
    } catch (error) {
      if (detached.signal.aborted) throw new TurnObserverDetached();
      if (signal.aborted || error instanceof DOMException && error.name === 'AbortError') throw error;
      throw this.safeError(error);
    } finally {
      if (this.observers.get(turn.id) === detached) this.observers.delete(turn.id);
      this.detachRequests.delete(turn.id);
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
    const marker = `/tmp/codex-web-${randomUUID()}.pid`;
    const body = `umask 077; echo $$ > ${quote(marker)}; exec ${command}`;
    let handle: CommandHandle | undefined;
    let stopping: Promise<void> | undefined;
    const stop = () => {
      if (!handle || stopping) return;
      stopping = (async () => {
        try {
          // Capture descendants before terminating the group: shell tools can create
          // their own process groups. TERM lets the SDK abort and reap its children;
          // the bounded KILL pass also catches a command that ignores termination.
          const terminate = `const fs=require('node:fs');const cp=require('node:child_process');let root;try{root=Number(fs.readFileSync(${JSON.stringify(marker)},'utf8').trim())}catch{process.exit(0)}if(!Number.isInteger(root)||root<2)process.exit(1);const rows=cp.execFileSync('ps',['-e','-o','pid=,ppid='],{encoding:'utf8'}).trim().split('\\n').map(s=>s.trim().split(/\\s+/).map(Number));const targets=new Set([root]);let changed=true;while(changed){changed=false;for(const [pid,ppid] of rows)if(targets.has(ppid)&&!targets.has(pid)){targets.add(pid);changed=true}}const kill=(pid,sig)=>{try{process.kill(pid,sig)}catch{}};kill(-root,'SIGTERM');for(const pid of targets)kill(pid,'SIGTERM');setTimeout(()=>{kill(-root,'SIGKILL');for(const pid of targets)kill(pid,'SIGKILL');try{fs.unlinkSync(${JSON.stringify(marker)})}catch{}},1200);`;
          await entry.sandbox.commands.run(
            `${NODE} -e ${quote(terminate)}`,
            { user: 'user', timeoutMs: 10_000 },
          );
        } finally { await handle?.kill().catch(() => false); }
      })();
    };
    signal.addEventListener('abort', stop, { once: true });
    try {
      handle = await entry.sandbox.commands.run(`setsid sh -c ${quote(body)}`, {
        user: 'user', background: true, timeoutMs: options.timeoutMs ?? COMMAND_TIMEOUT_MS,
        onStdout: options.onStdout, onStderr: options.onStderr, envs: options.envs,
      });
      if (signal.aborted) stop();
      const result = await handle.wait();
      checkAbort(signal);
      return result;
    } catch (error) {
      stop();
      if (signal.aborted) throw new DOMException('任务已停止', 'AbortError');
      throw this.safeError(error);
    } finally {
      signal.removeEventListener('abort', stop);
      await stopping?.catch(() => { });
      // Marker cleanup is bounded and does not affect any other process group.
      await entry.sandbox.files.remove(marker, { user: 'user' }).catch(() => { });
    }
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
      // Read on every turn, including resumed threads. Global guidance applies
      // across Git roots without replacing any project-owned AGENTS.md.
      const sharedData = this.options.sharedDataDirectory ?? SHARED_DATA;
      const sharedAgents = await readFile(new URL('AGENTS.md', sharedData), 'utf8').catch(error => {
        if (error.code === 'ENOENT') return ''; // Deleting global rules clears the remote copy next turn.
        throw error;
      });
      const sharedDocs = await loadAgentDocs(new URL('docs/', sharedData));
      await this.command(entry, `sh -c ${quote(`mkdir -p ${quote(RUNTIME)} ${quote(`${RUNTIME}/agentcore`)} ${quote(`${ROOT}/images`)} /home/user/.codex ${quote(target.settings.workingDirectory)} && chmod 700 ${quote(ROOT)} /home/user/.codex && cd ${quote(RUNTIME)} && if ! ${NODE} -e 'if(require("./node_modules/@openai/codex/package.json").version!=="0.153.4")process.exit(1)' >/dev/null 2>&1; then npm install --no-audit --no-fund --save-exact @openai/codex@0.153.4; fi`)}`, executionSignal, { timeoutMs: 300_000 });
      const connectionEnvs = this.options.connections ? await syncSandboxConnections(entry.sandbox, this.options.connections, executionSignal) : {};
      checkAbort(executionSignal);
      // Clear a legacy mirror only on the first preparation, before any worker
      // starts. Subsequent turns update files atomically while siblings run.
      const docDirectories = new Set([SHARED_DOCS, ...sharedDocs.map(file => posix.dirname(`${SHARED_DOCS}/${file.path}`))]);
      const clearLegacy = entry.preparation.sharedDocPaths ? '' : `rm -rf ${quote(SHARED_DOCS)} ${quote(`${ROOT}/docs`)} && `;
      await this.command(entry, `sh -c ${quote(`${clearLegacy}mkdir -p ${[...docDirectories].map(quote).join(' ')}`)}`, executionSignal);
      for (const file of sharedDocs) {
        checkAbort(executionSignal);
        await this.writeAtomic(entry, `${SHARED_DOCS}/${file.path}`, file.contents, executionSignal);
      }
      const currentPaths = new Set(sharedDocs.map(file => file.path));
      for (const path of entry.preparation.sharedDocPaths ?? []) {
        if (!currentPaths.has(path)) await entry.sandbox.files.remove(`${SHARED_DOCS}/${path}`, { user: 'user', signal: executionSignal });
      }
      entry.preparation.sharedDocPaths = currentPaths;
      const managedAgents = [sharedAgents.trim(), SANDBOX_PERSISTENCE_GUIDANCE].filter(Boolean).join('\n\n') + '\n';
      await this.writeAtomic(entry, `${CODEX_HOME}/AGENTS.md`, managedAgents, executionSignal);
      for (const name of ['e2b-worker.mjs', 'e2b-inspect.mjs', 'improvement-bridge.mjs', 'improvement-mcp.mjs', 'approval-bridge.mjs', 'approval-mcp.mjs']) {
        checkAbort(executionSignal);
        await this.writeAtomic(entry, `${RUNTIME}/${name}`, await readFile(new URL(`../execution/worker/${name}`, import.meta.url), 'utf8'), executionSignal);
      }
      await this.writeAtomic(entry, `${RUNTIME}/agentcore/index.mjs`,
        await readFile(new URL('../../packages/agentcore/src/index.mjs', import.meta.url), 'utf8'), executionSignal);
      entry.preparation.initialized = true;
      return connectionEnvs;
    });
  }

  async *run(session: Session, turn: Turn, signal: AbortSignal, onSandbox: SaveSandbox, onApproval?: RequestUserApproval,
    onExecution?: () => Promise<void>): AsyncGenerator<AgentEvent> {
    if (this.detachRequests.delete(turn.id)) throw new TurnLaunchCancelled();
    if (this.closing) throw new Error('E2B 运行时正在关闭');
    if (!this.options.apiKey) throw new Error('E2B 模式需要 CODEX_API_KEY 或 OPENAI_API_KEY');
    checkAbort(signal);
    let acquired: Entry | undefined;
    let inputPath: string | undefined;
    let handle: CommandHandle | undefined;
    let failed = false;
    let detached = false;
    let launchRequested = false;
    const preparation = new AbortController();
    this.preparations.set(turn.id, preparation);
    if (this.detachRequests.has(turn.id)) preparation.abort();
    try {
      const acquireSignal = AbortSignal.any([signal, preparation.signal]);
      const entry = acquired = await this.acquire(session, true, onSandbox, turn.execution?.workerId ?? turn.id, acquireSignal);
      const executionSignal = AbortSignal.any([signal, entry.lease.signal, preparation.signal]);
      checkAbort(executionSignal);
      const connectionEnvs = await this.prepareEnvironment(session, entry, executionSignal);
      const images: string[] = [];
      for (const path of turn.images) {
        checkAbort(executionSignal);
        const destination = `${ROOT}/images/${turn.id}-${images.length}${extname(basename(path))}`;
        await entry.sandbox.files.write(destination, new Uint8Array(await readFile(path)).buffer, { user: 'user', signal: executionSignal });
        images.push(destination);
      }
      const runDirectory = this.runDirectory(turn);
      const bundleDirectory = `${runDirectory}/bundle`;
      const approvalReplyDirectory = `${runDirectory}/approvals`;
      const improvementReplyDirectory = `${runDirectory}/improvements`;
      await this.command(entry, `mkdir -p ${quote(bundleDirectory)} ${quote(`${bundleDirectory}/agentcore`)} ${quote(approvalReplyDirectory)} ${quote(improvementReplyDirectory)}`, executionSignal);
      for (const name of ['e2b-worker.mjs', 'improvement-bridge.mjs', 'improvement-mcp.mjs', 'approval-bridge.mjs', 'approval-mcp.mjs']) {
        await this.command(entry, `cp ${quote(`${RUNTIME}/${name}`)} ${quote(`${bundleDirectory}/${name}`)}`, executionSignal);
      }
      await this.command(entry, `cp ${quote(`${RUNTIME}/agentcore/index.mjs`)} ${quote(`${bundleDirectory}/agentcore/index.mjs`)}`, executionSignal);
      inputPath = `${runDirectory}/input.json`;
      checkAbort(executionSignal);
      await entry.sandbox.files.write(inputPath, JSON.stringify({
        workerId: turn.execution!.workerId, sessionId: session.id, turnId: turn.id, runDirectory,
        agentcorePath: `${bundleDirectory}/agentcore/index.mjs`,
        threadId: session.threadId, prompt: turn.prompt, images, settings: session.settings,
        connectionDirectories: Object.keys(connectionEnvs).length ? [CONNECTION_ROOT, ...('MEEGLE_HOST' in connectionEnvs ? ['/home/user/.meegle'] : []), ...('KUBECONFIG' in connectionEnvs ? ['/home/user/.kube'] : [])] : [],
        baseUrl: this.options.baseUrl, proxyKind: this.options.proxyKind,
        modelConfig: this.options.modelConfig, configOverrides: this.options.configOverrides,
        improvementReplyDirectory: this.options.submitImprovement ? improvementReplyDirectory : undefined,
        approvalReplyDirectory: onApproval ? approvalReplyDirectory : undefined,
      }), { user: 'user', signal: executionSignal });
      const marker = `${runDirectory}/worker.pid`;
      const body = `umask 077; echo $$ > ${quote(marker)}; exec ${NODE} ${quote(`${bundleDirectory}/e2b-worker.mjs`)} ${quote(inputPath)}`;
      checkAbort(executionSignal);
      // Once the launch request is sent, its outcome may already be remote.
      // Shutdown must wait for its identity and then detach the observer.
      this.preparations.delete(turn.id);
      try {
        launchRequested = true;
        handle = await entry.sandbox.commands.run(`setsid sh -c ${quote(body)}`, {
          user: 'user', background: true,
          timeoutMs: 0,
          envs: { ...connectionEnvs, CODEX_API_KEY: this.options.apiKey, CODEX_HOME },
        });
      } catch (error) {
        // A timed-out launch may already have started remotely. Observe the
        // preassigned run directory; never send the launch request twice.
        if (!transportFailure(error)) throw error;
      }
      turn.execution!.commandPid = handle?.pid;
      turn.execution!.sandboxId = entry.metadata.id;
      turn.execution!.state = 'running';
      await onExecution?.();
      for await (const event of this.observeWorker(entry, session, turn, signal, onApproval, onExecution)) yield event;
    } catch (error) {
      failed = true;
      detached = error instanceof TurnObserverDetached;
      if (preparation.signal.aborted) throw new TurnLaunchCancelled();
      if (detached || signal.aborted) throw error;
      throw this.safeError(error);
    } finally {
      this.preparations.delete(turn.id);
      this.detachRequests.delete(turn.id);
      if (acquired) {
        if (signal.aborted && launchRequested) detached = !await this.terminateWorker(acquired, turn, handle);
        else await handle?.disconnect().catch(() => { });
        await this.release(acquired, failed, detached);
        if (signal.aborted && detached) {
          if (turn.execution) turn.execution.stopRequested = true;
          throw new TurnTerminationUnconfirmed();
        }
      }
    }
  }

  async *recover(session: Session, turn: Turn, signal: AbortSignal, onSandbox: SaveSandbox, onApproval?: RequestUserApproval,
    onExecution?: () => Promise<void>): AsyncGenerator<AgentEvent> {
    if (!turn.execution || !session.sandbox || (turn.execution.sandboxId && turn.execution.sandboxId !== session.sandbox.id)) {
      throw new Error('E2B worker recovery information is incomplete');
    }
    if (turn.execution.stopRequested) signal = AbortSignal.any([signal, AbortSignal.abort()]);
    this.sandboxes.holdUsage(session, turn.execution.workerId);
    const reconnect = new AbortController();
    this.observers.set(turn.id, reconnect);
    if (this.detachRequests.has(turn.id)) reconnect.abort(new TurnObserverDetached());
    let acquired: Entry | undefined;
    let failed = false;
    let detached = false;
    try {
      const reconnectSignal = AbortSignal.any([signal, reconnect.signal]);
      const entry = acquired = await this.observeRead(
        () => this.acquire(session, false, onSandbox, turn.execution!.workerId, reconnectSignal), reconnectSignal);
      if (this.observers.get(turn.id) === reconnect) this.observers.delete(turn.id);
      if (!turn.prompt) {
        const input = JSON.parse(await entry.sandbox.files.read(`${this.runDirectory(turn)}/input.json`, { user: 'user', signal }));
        turn.prompt = typeof input.prompt === 'string' ? input.prompt : '';
        turn.images = Array.isArray(input.images) ? input.images.filter((path: unknown) => typeof path === 'string') : [];
      }
      turn.execution.sandboxId = entry.metadata.id;
      turn.execution.state = 'running';
      await onExecution?.();
      for await (const event of this.observeWorker(entry, session, turn, signal, onApproval, onExecution)) yield event;
    } catch (error) {
      failed = true;
      detached = reconnect.signal.aborted || error instanceof TurnObserverDetached;
      if (detached) throw new TurnObserverDetached();
      if (signal.aborted) throw new DOMException('任务已停止', 'AbortError');
      throw this.safeError(error);
    } finally {
      if (this.observers.get(turn.id) === reconnect) this.observers.delete(turn.id);
      if (signal.aborted && !acquired) {
        // Cancellation can win while a shared connect is still in flight. Try
        // once to stop the existing worker using its original identity. The
        // manager discards late cancelled acquisitions without leaking leases.
        try {
          acquired = await this.acquire(session, false, onSandbox, turn.execution.workerId, AbortSignal.timeout(10_000));
        } catch (error) {
          void this.options.logger?.write({ event: 'sandbox.worker_termination_unconfirmed',
            sandboxId: session.sandbox.id, turnId: turn.id, message: this.safeError(error).message });
        }
      }
      if (acquired) {
        if (signal.aborted) detached = !await this.terminateWorker(acquired, turn);
        await this.release(acquired, failed, detached);
      }
      if (signal.aborted && (!acquired || detached)) {
        turn.execution.stopRequested = true;
        throw new TurnTerminationUnconfirmed();
      }
    }
  }

  detach(turn: Turn) {
    if (turn.execution) turn.execution.state = 'detached';
    this.detachRequests.add(turn.id);
    this.preparations.get(turn.id)?.abort();
    this.observers.get(turn.id)?.abort(new TurnObserverDetached());
  }

  private async terminateWorker(entry: Entry, turn: Turn, handle?: CommandHandle) {
    const marker = `${this.runDirectory(turn)}/worker.pid`;
    const script = `
const fs = require('node:fs'), cp = require('node:child_process');
const reply = confirmed => process.stdout.write(JSON.stringify({ confirmed }));
(async () => {
  let root;
  try { root = Number(fs.readFileSync(${JSON.stringify(marker)}, 'utf8').trim()); } catch {}
  if (!Number.isInteger(root) || root <= 1) {
    // An unacknowledged launch may still be pending remotely. Missing PID is
    // not proof that no worker exists or will start.
    let state;
    try { state = JSON.parse(fs.readFileSync(${JSON.stringify(this.runDirectory(turn) + '/state.json')}, 'utf8')); } catch {}
    reply(Boolean(state && state.workerId === ${JSON.stringify(turn.execution?.workerId)}
      && state.turnId === ${JSON.stringify(turn.id)} && ['completed', 'failed', 'cancelled'].includes(state.status)));
    return;
  }
  const rows = cp.execFileSync('ps', ['-e', '-o', 'pid=,ppid='], { encoding: 'utf8' }).trim()
    .split('\\n').map(row => row.trim().split(/\\s+/).map(Number));
  const targets = new Set([root]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [pid, ppid] of rows) if (targets.has(ppid) && !targets.has(pid)) { targets.add(pid); changed = true; }
  }
  let confirmed = true;
  const kill = (pid, signal) => {
    try { process.kill(pid, signal); }
    catch (error) { if (error.code !== 'ESRCH') confirmed = false; }
  };
  kill(-root, 'SIGTERM');
  for (const pid of targets) kill(pid, 'SIGTERM');
  await new Promise(resolve => setTimeout(resolve, 1200));
  kill(-root, 'SIGKILL');
  for (const pid of targets) kill(pid, 'SIGKILL');
  reply(confirmed);
})().catch(() => reply(false));
`;
    const signalled = await entry.sandbox.commands.run(`${NODE} -e ${quote(script)}`, { user: 'user', timeoutMs: 10_000 })
      .then(result => { try { return JSON.parse(result.stdout).confirmed === true; } catch { return false; } }, () => false);
    const killed = await handle?.kill().catch(() => false);
    if (!signalled && !killed) {
      void this.options.logger?.write({ event: 'sandbox.worker_termination_unconfirmed', sandboxId: entry.metadata.id, turnId: turn.id });
    }
    return signalled || Boolean(killed);
  }

  private async inspect<T>(session: WorkspaceTarget, mode: string, args: string[]): Promise<T> {
    const entry = await this.acquire(session, false);
    let failed = false;
    try {
      entry.preparation.initialized ||= await entry.sandbox.files.exists(`${RUNTIME}/e2b-inspect.mjs`, { user: 'user' });
      if (!entry.preparation.initialized) throw new Error('E2B Codex 尚未完成初始化，请等待当前任务启动后重试');
      if (mode === 'history' || mode === 'billing') {
        // Upgrade the reader independently of worker/model startup for existing threads.
        const signal = AbortSignal.timeout(30_000);
        await this.writeAtomic(entry, `${RUNTIME}/native-history.mjs`, await readFile(new URL('../execution/native-history.mjs', import.meta.url), 'utf8'), signal);
        await this.writeAtomic(entry, `${RUNTIME}/e2b-inspect.mjs`, await readFile(new URL('../execution/worker/e2b-inspect.mjs', import.meta.url), 'utf8'), signal);
      }
      // Native rollout history is parsed and serialized in the sandbox. Long
      // conversations can legitimately exceed the ordinary inspection budget.
      const timeoutMs = mode === 'history' || mode === 'billing' ? 120_000 : 30_000;
      const result = await entry.sandbox.commands.run(`${NODE} ${quote(`${RUNTIME}/e2b-inspect.mjs`)} ${quote(mode)} ${args.map(quote).join(' ')}`, { user: 'user', timeoutMs });
      return JSON.parse(result.stdout) as T;
    } catch (error) {
      failed = true;
      const stdout = (error as { stdout?: string })?.stdout;
      if (stdout) {
        let detail;
        try { detail = JSON.parse(stdout); } catch { /* Retain the transport error. */ }
        if (typeof detail?.error === 'string') throw this.safeError(detail.error);
      }
      if (/not found|404/i.test(String(error))) await this.sandboxes.inspect(session).catch(() => { });
      throw this.safeError(error);
    }
    finally { await this.release(entry, failed); }
  }
  async preview(session: WorkspaceTarget, port: number): Promise<string> {
    if (this.closing) throw new Error('E2B 运行时正在关闭');
    if (!session.sandbox) throw new Error('项目沙箱尚未创建，请先启动服务');
    const entry = await this.acquire(session, false);
    let failed = false;
    try {
      const gateway = this.options.connection.sandboxUrl;
      const url = new URL(gateway ?? `https://${entry.sandbox.getHost(port)}`);
      url.hostname = entry.sandbox.getHost(port);
      url.pathname = '/'; url.search = ''; url.hash = '';
      return url.origin;
    } catch (error) { failed = true; throw error; }
    finally { await this.release(entry, failed); }
  }

  async file(session: WorkspaceTarget, path: string, options?: WorkspaceFileReadOptions): Promise<WorkspaceFileResult> {
    if (this.closing) throw new HttpError(503, 'E2B 运行时正在关闭');
    const request = workspaceFileRequest(session.settings.workingDirectory, path, options);
    let entry: Entry;
    try { entry = await this.acquire(session, false); }
    catch (error) { throw new HttpError(502, this.safeError(error).message); }
    let failed = false;
    try {
      const encoded = Buffer.from(JSON.stringify(request)).toString('base64');
      const result = await entry.sandbox.commands.run(`${NODE} --input-type=commonjs -e ${quote(READ_SANDBOX_FILE_SCRIPT)} ${quote(encoded)}`, { user: 'user', timeoutMs: 30_000 });
      return parseWorkspaceFile(result.stdout);
    } catch (error) {
      failed = true;
      if (error instanceof HttpError) throw error;
      if (/not found|404/i.test(String(error))) await this.sandboxes.inspect(session).catch(() => { });
      throw new HttpError(502, this.safeError(error).message);
    } finally { await this.release(entry, failed); }
  }

  async changes(session: WorkspaceTarget): Promise<Changes> {
    if (!session.sandbox) return { branch: '', files: [], diff: '', error: 'E2B 沙箱尚未创建，请先发送一条消息' };
    return this.inspect(session, 'changes', [session.settings.workingDirectory]);
  }
  async rawTools(session: ThreadWorkspace, cursor = 0): Promise<RawToolPage> {
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error('原始消息游标无效');
    if (!session.threadId || !session.sandbox) return {
      source: 'codex-rollout', location: 'e2b', sandboxId: session.sandbox?.id,
      threadId: session.threadId, availability: 'pending', messages: [], nextCursor: cursor, hasMore: false, skippedLines: 0,
    };
    const page = await this.inspect<RawToolPage>(session, 'raw', [session.threadId, String(cursor)]);
    return { ...page, location: 'e2b', sandboxId: session.sandbox.id };
  }
  async history(session: ThreadWorkspace, includeBlocks?: boolean): Promise<NativeHistory> {
    if (!session.threadId) return { turns: [] };
    if (!session.sandbox) throw new Error('Codex 会话对应的沙箱不可用');
    return this.inspect<NativeHistory>(session, includeBlocks ? 'billing' : 'history', [session.threadId, '', session.startedAt ?? '', session.nativeHistoryPath ?? '']);
  }
  async delete(session: WorkspaceTarget) {
    await this.sandboxes.delete(session);
    if (session.sandbox) this.runtimePreparations.delete(session.sandbox.id);
  }

  async detachSandbox(target: WorkspaceTarget) {
    const sandboxId = target.sandbox?.id;
    await this.sandboxes.detach(target);
    if (sandboxId) this.runtimePreparations.delete(sandboxId);
  }

  async archiveSandbox(target: WorkspaceTarget, threadIds: string[], onSandbox: SaveSandbox) {
    const key = target.projectId ?? target.id;
    if (this.closing || this.upgrading.has(key)) throw new HttpError(409, '沙箱正在维护');
    this.upgrading.add(key);
    try { return await archiveSandbox(target, threadIds, onSandbox, this.sandboxes, this.dataArchives); }
    catch (error) { throw this.safeError(error); }
    finally { this.upgrading.delete(key); }
  }

  async restoreSandbox(target: WorkspaceTarget, archive: SandboxDataArchive, options: SandboxRestoreOptions) {
    const key = target.projectId ?? target.id;
    if (this.closing || this.upgrading.has(key)) throw new HttpError(409, '沙箱正在维护');
    this.upgrading.add(key);
    try {
      await restoreSandbox(target, archive, options, this.sandboxes, this.options.connection, this.dataArchives, async (lease, signal) => {
        const entry: Entry = { sandbox: lease.sandbox, metadata: lease.record, lease, preparation: {} };
        const envs = await this.prepareEnvironment(target, entry, signal);
        // Resume each original thread without starting a model turn. This checks
        // the actual App Server index/rollout compatibility of the new template.
        const script = `import { CodexAppServerClient, appServerArgs } from ${JSON.stringify(`${RUNTIME}/agentcore/index.mjs`)};
let client;
try {
  client = await CodexAppServerClient.spawn({ command: ${JSON.stringify(`${RUNTIME}/node_modules/.bin/codex`)}, args: appServerArgs(${JSON.stringify(this.options.modelConfig ?? {})}, ${JSON.stringify(this.options.configOverrides ?? [])}), cwd: ${JSON.stringify(target.settings.workingDirectory)} });
  for (const threadId of ${JSON.stringify(archive.threadIds)}) {
    const response = await client.request('thread/resume', { threadId, cwd: ${JSON.stringify(target.settings.workingDirectory)}, approvalPolicy: 'never', sandbox: 'danger-full-access' });
    if (response.thread.id !== threadId) throw new Error('Thread identity mismatch');
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { await client?.close(); }`;
        try {
          await lease.sandbox.commands.run(`${NODE} --input-type=module -e ${quote(script)}`, {
            user: 'user', signal, timeoutMs: 120_000,
            envs: { ...envs, CODEX_API_KEY: this.options.apiKey, CODEX_HOME },
          });
        } catch (error) {
          const stderr = (error as { stderr?: string }).stderr;
          const detail = stderr?.trim().split('\n').at(-1)?.slice(0, 300);
          const fallback = target.sandbox ? '已保留原沙箱' : '新沙箱未绑定到项目';
          throw new Error(`新沙箱无法恢复已有 Codex 对话，${fallback}${detail ? `：${detail}` : ''}`);
        }
        this.runtimePreparations.set(lease.record.id, entry.preparation);
      });
    } catch (error) { throw this.safeError(error); }
    finally { this.upgrading.delete(key); }
  }

  async deleteDataArchive(archive: SandboxDataArchive) { await this.dataArchives.delete(archive); }

  async verifyDataArchive(archive: SandboxDataArchive) {
    const directory = await mkdtemp(join(tmpdir(), 'swarm-hive-archive-verify-'));
    try { await this.dataArchives.get(archive, join(directory, 'archive.tar.gz')); }
    finally { await rm(directory, { recursive: true, force: true }); }
  }

  async pauseDanglingSandbox(sandboxId: string, provenance?: SandboxDataArchive) {
    try { await pauseDanglingSandbox(sandboxId, this.options.connection, provenance); }
    catch (error) { throw this.safeError(error); }
  }

  async deleteDanglingSandbox(sandboxId: string, provenance?: SandboxDataArchive) {
    try { await deleteDanglingSandbox(sandboxId, this.options.connection, provenance); }
    catch (error) { throw this.safeError(error); }
  }

  async close() {
    this.closing = true;
    await this.sandboxes.close();
  }
}
