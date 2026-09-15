import type { SandboxState } from '../../protocol/sandbox-types.js';
import type { WorkspaceTarget } from '../sandboxes/types.js';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AppServerEventAdapter, Codex, CodexAppServerClient } from '../../packages/agentcore/src/index.mjs';
import { readFile } from 'node:fs/promises';
import { basename, extname, posix } from 'node:path';
import type { SandboxCommandHandle, SandboxHandle, SandboxProvider, SandboxLease, SandboxRecord } from '@swarm-hive/sandbox';
import { ProjectSandboxes, type SaveSandbox } from '../sandboxes/project-sandboxes.js';
import type { AgentEvent, ContextUsage } from '../../protocol/types.js';
import type { RequestUserApproval } from '../../protocol/approval-types.js';
import type { Session, Turn } from '../../protocol/types.js';
import type { NativeHistory } from './native-history.mjs';
import { loadAgentDocs } from '../shared-files/agent-docs.js';
import { CONNECTION_ROOT, type ConnectionStore } from '../connections/store.js';
import { syncSandboxConnections } from '../connections/sandbox-sync.js';
import type { RuntimeLog } from '../infra/diagnostics/runtime-log.js';
import type { ImprovementContext, ImprovementReceipt } from '../../protocol/improvement-types.js';
import { HttpError } from '../../util/errors.js';
import type { ModelProxyKind } from './model-proxy.js';
import { parseWorkspaceFile, READ_SANDBOX_FILE_SCRIPT, workspaceFileRequest, type WorkspaceFileResult, type WorkspaceFileReadOptions } from '../workspaces/files.js';

export interface SandboxRuntime {
  track?(session: WorkspaceTarget, onSandbox: (value: SandboxState) => Promise<void>): void;
  trackExecution?(session: Session, turn: Turn): void;
  run(session: Session, turn: Turn, signal: AbortSignal, onSandbox: (value: SandboxState) => Promise<void>, onApproval?: RequestUserApproval, onExecution?: () => Promise<void>): AsyncGenerator<AgentEvent>;
  recover(session: Session, turn: Turn, signal: AbortSignal, onSandbox: (value: SandboxState) => Promise<void>, onApproval?: RequestUserApproval, onExecution?: () => Promise<void>): AsyncGenerator<AgentEvent>;
  detach(turn: Turn): void;
  preview(session: WorkspaceTarget, port: number): Promise<string>;
  proxyHost(session: WorkspaceTarget): Promise<string>;
  file(session: WorkspaceTarget, path: string, options?: WorkspaceFileReadOptions): Promise<WorkspaceFileResult>;
  history(session: Session, includeBlocks?: boolean): Promise<NativeHistory>;
  delete(session: WorkspaceTarget): Promise<void>;
  rebuild(target: WorkspaceTarget, onSandbox: (value: SandboxState) => Promise<void>): Promise<void>;
  restoreArchive?(target: WorkspaceTarget, archivePath: string): Promise<void>;
  createArchive?(target: WorkspaceTarget, archivePath: string): Promise<{ sizeBytes: number; sha256: string }>;
  detachSandbox?(target: WorkspaceTarget): Promise<void>;
  pauseDanglingSandbox?(sandboxId: string): Promise<void>;
  deleteDanglingSandbox?(sandboxId: string): Promise<void>;
  close(): Promise<void>;
}
export interface ContainerRuntimeOptions {
  sandboxes: ProjectSandboxes;
  provider: SandboxProvider;
  connections?: ConnectionStore;
  apiKey: string;
  baseUrl?: string;
  proxyKind?: ModelProxyKind;
  modelConfig?: Record<string, unknown>;
  configOverrides?: string[];
  sharedDataDirectory?: URL;
  logger?: RuntimeLog;
  submitImprovement?: (context: Omit<ImprovementContext, 'projectName'>, input: unknown, requestId: string) => Promise<ImprovementReceipt>;
  appServer?: (sandboxId: string) => Promise<{ url: string; token: string }>;
}
type Preparation = {
  preparing?: Promise<void>;
  sharedDocPaths?: Set<string>;
  initialized?: boolean;
};
type Entry = {
  sandbox: SandboxHandle;
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
// Keep control processes independent of a project's Node selection. Legacy base
// sandboxes retain their existing interpreter until moved to the dev template.
const NODE = '"$(if test -x /opt/codex-runtime/bin/node; then echo /opt/codex-runtime/bin/node; else command -v node; fi)"';
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const checkAbort = (signal: AbortSignal) => { if (signal.aborted) throw new DOMException('任务已停止', 'AbortError'); };
const transportFailure = (error: unknown) => /timeout|timed out|network|fetch failed|ECONN|EAI_AGAIN|ENOTFOUND|socket|5\d\d|429|unavailable|transport/i.test(String(error));
const waitFor = (delayMs: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  const timer = setTimeout(done, delayMs);
  const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason); };
  function done() { signal.removeEventListener('abort', abort); resolve(); }
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
});

/** Prepares and observes Codex workers using independently managed sandbox leases. */
export class ContainerCodexRuntime implements SandboxRuntime {
  private closing = false;
  private runtimePreparations = new Map<string, Preparation>();
  private observers = new Map<string, AbortController>();
  private appServerObservers = new Map<string, { close(): Promise<void> }>();
  private detachRequests = new Set<string>();
  private preparations = new Map<string, AbortController>();
  private readonly sandboxes: ProjectSandboxes;

  constructor(private options: ContainerRuntimeOptions) {
    this.sandboxes = options.sandboxes;
  }

  track(target: WorkspaceTarget, notify: SaveSandbox) { this.sandboxes.track(target, notify); }
  trackExecution(session: Session, turn: Turn) {
    if (turn.execution && session.sandbox && (!turn.execution.sandboxId || turn.execution.sandboxId === session.sandbox.id)) {
      this.sandboxes.holdUsage(session, turn.execution.workerId);
    } else if (!turn.execution && turn.codexAccepted && turn.nativeTurnId && session.threadId && session.sandbox) {
      this.sandboxes.holdUsage(session, turn.id);
    }
  }
  private safeError(error: unknown): Error {
    let message = error instanceof Error ? error.message : String(error);
    if (this.options.apiKey) message = message.replaceAll(this.options.apiKey, '[REDACTED]');
    return new Error(message);
  }

  private async acquire(target: WorkspaceTarget, create: boolean, notify?: SaveSandbox, usageId?: string, signal?: AbortSignal): Promise<Entry> {
    if (this.closing) throw new Error('Sandbox 运行时正在关闭');
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
      throw new Error('Sandbox worker identity is invalid');
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
        if (index !== lines.length - 1) throw new Error('Sandbox worker journal contains an invalid event');
        continue;
      }
      if (envelope.v !== 1 || envelope.workerId !== turn.execution?.workerId || envelope.turnId !== turn.id
        || !Number.isSafeInteger(envelope.seq) || envelope.seq !== result.length + 1
        || !envelope.event || typeof envelope.event.type !== 'string') throw new Error('Sandbox worker journal contains an invalid envelope');
      result.push(envelope);
    }
    return result;
  }

  private async observeRead<T>(read: () => Promise<T>, signal: AbortSignal): Promise<T> {
    while (true) {
      signal.throwIfAborted();
      try { return await read(); }
      catch (error) {
        // A lost Web-to-Sandbox connection says nothing about whether the remote
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
          if (!applied && envelope.seq !== (turn.execution?.lastAppliedSeq ?? 0) + 1) throw new Error('Sandbox worker journal has an event gap');
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
                ...fields, source: 'sandbox-proxy', sessionId: session.id, projectId: session.projectId,
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
          throw new Error('Sandbox worker state does not match this turn');
        }
        // The worker can finish between our journal read and state read. Drain
        // the final committed sequence before acting on its terminal state.
        const drained = state && (turn.execution?.lastAppliedSeq ?? 0) >= state.lastSeq;
        if (drained && state.status === 'completed') return;
        if (drained && state.status === 'failed') throw this.safeError(state.error || 'Sandbox Codex worker failed');
        if (drained && state.status === 'cancelled') throw new DOMException('任务已停止', 'AbortError');
        if (state?.status === 'running' && Date.now() - lastHealthCheck >= 5_000) {
          lastHealthCheck = Date.now();
          const alive = await entry.sandbox.commands.run(`kill -0 ${state.pid}`, { user: 'user', timeoutMs: 5_000 })
            .then(() => true, error => (error as { exitCode?: number }).exitCode === 1 ? false : undefined);
          if (alive !== false) deadSince = 0;
          else if (!deadSince) deadSince = Date.now();
          else if (Date.now() - deadSince >= 2_000) throw new Error('Sandbox Codex worker exited without a terminal event');
        }
        if (advanced) idleSince = 0;
        else idleSince ||= Date.now();
        if (!state && idleSince && Date.now() - idleSince > 30_000) throw new Error('Sandbox Codex worker state missing');
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
    let handle: SandboxCommandHandle | undefined;
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
      // Shared documents are read on every turn, including resumed threads.
      // Global AGENTS.md is a required host mount on all supported Sandboxes.
      const sharedData = this.options.sharedDataDirectory ?? SHARED_DATA;
      const sharedDocs = await loadAgentDocs(new URL('docs/', sharedData));
      await this.command(entry, `sh -c ${quote(`mkdir -p ${quote(RUNTIME)} ${quote(`${RUNTIME}/agentcore`)} ${quote(`${RUNTIME}/node_modules/.bin`)} ${quote(`${ROOT}/images`)} /home/user/.codex ${quote(target.settings.workingDirectory)} && chmod 700 ${quote(ROOT)} /home/user/.codex && if test -x /usr/local/bin/codex; then ln -sfn /usr/local/bin/codex ${quote(`${RUNTIME}/node_modules/.bin/codex`)}; fi && cd ${quote(RUNTIME)} && if ! test -x ${quote(`${RUNTIME}/node_modules/.bin/codex`)}; then npm install --no-audit --no-fund --save-exact @openai/codex@0.153.4; fi`)}`, executionSignal, { timeoutMs: 300_000 });
      const connectionEnvs = this.options.connections
        ? await syncSandboxConnections(this.options.connections)
        : {};
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
      // The long-lived App Server owns execution. Its active turn path does
      // not use the retired per-turn worker bundle; history inspection writes
      // its small helper lazily in `inspect()`.
      entry.preparation.initialized = true;
      return connectionEnvs;
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
      // App Server is long-lived, but the project environment still needs to
      // be prepared before every turn. In particular, this publishes the
      // global AGENTS.md and shared docs; previously that happened only in
      // the retired per-turn worker path below.
      const connectionEnvs = await this.prepareEnvironment(session, entry, startupSignal);
      observer.signal.throwIfAborted();
      const endpoint = await this.options.appServer(entry.metadata.id);
      const images: string[] = [];
      if (turn.images.length) {
        await entry.sandbox.commands.run(`mkdir -p ${quote(`${ROOT}/images`)}`, { user: 'user', timeoutMs: 30_000 });
        for (const [index, path] of turn.images.entries()) {
          const destination = `${ROOT}/images/${turn.id}-${index}${extname(basename(path))}`;
          await entry.sandbox.files.write(destination, new Uint8Array(await readFile(path)).buffer, { user: 'user', signal: startupSignal });
          images.push(destination);
        }
      }
      codex = new Codex({ apiKey: this.options.apiKey, baseUrl: this.options.baseUrl, config: this.options.modelConfig,
        configOverrides: this.options.configOverrides, appServerUrl: endpoint.url,
        appServerHeaders: { Authorization: `Bearer ${endpoint.token}` } });
      this.appServerObservers.set(turn.id, codex);
      observer.signal.throwIfAborted();
      const options = { workingDirectory: session.settings.workingDirectory, ...(session.settings.model ? { model: session.settings.model } : {}),
        modelReasoningEffort: session.settings.modelReasoningEffort, sandboxMode: 'danger-full-access' as const,
        webSearchMode: session.settings.webSearchMode, networkAccessEnabled: true, approvalPolicy: 'never' as const, skipGitRepoCheck: true,
        additionalDirectories: Object.keys(connectionEnvs).length ? [CONNECTION_ROOT] : [] };
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

  async *run(session: Session, turn: Turn, signal: AbortSignal, onSandbox: SaveSandbox, onApproval?: RequestUserApproval,
    onExecution?: () => Promise<void>): AsyncGenerator<AgentEvent> {
    yield* this.runAppServer(session, turn, signal, onSandbox);
    return;
    if (this.detachRequests.delete(turn.id)) throw new TurnLaunchCancelled();
    if (this.closing) throw new Error('Sandbox 运行时正在关闭');
    if (!this.options.apiKey) throw new Error('Sandbox 模式需要 CODEX_API_KEY 或 OPENAI_API_KEY');
    checkAbort(signal);
    let acquired: Entry | undefined;
    let inputPath: string | undefined;
    let handle: SandboxCommandHandle | undefined;
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
      for (const name of ['sandbox-worker.mjs', 'improvement-bridge.mjs', 'improvement-mcp.mjs', 'approval-bridge.mjs', 'approval-mcp.mjs']) {
        await this.command(entry, `cp ${quote(`${RUNTIME}/${name}`)} ${quote(`${bundleDirectory}/${name}`)}`, executionSignal);
      }
      await this.command(entry, `cp ${quote(`${RUNTIME}/agentcore/index.mjs`)} ${quote(`${bundleDirectory}/agentcore/index.mjs`)}`, executionSignal);
      inputPath = `${runDirectory}/input.json`;
      checkAbort(executionSignal);
      await entry!.sandbox.files.write(inputPath!, JSON.stringify({
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
      const body = `umask 077; echo $$ > ${quote(marker)}; exec ${NODE} ${quote(`${bundleDirectory}/sandbox-worker.mjs`)} ${quote(inputPath!)}`;
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
        if (signal.aborted && launchRequested) detached = !await this.terminateWorker(acquired!, turn, handle);
        else await handle?.disconnect().catch(() => { });
        await this.release(acquired!, failed, detached);
        if (signal.aborted && detached) {
          if (turn.execution) turn.execution!.stopRequested = true;
          throw new TurnTerminationUnconfirmed();
        }
      }
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
      client = await CodexAppServerClient.spawn({ url: endpoint.url, headers: { Authorization: `Bearer ${endpoint.token}` }, requestTimeoutMs: 120_000 });
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

  async *recover(session: Session, turn: Turn, signal: AbortSignal, onSandbox: SaveSandbox, onApproval?: RequestUserApproval,
    onExecution?: () => Promise<void>): AsyncGenerator<AgentEvent> {
    if (!turn.execution) {
      yield* this.recoverAppServer(session, turn, signal, onSandbox);
      return;
    }
    if (!turn.execution || !session.sandbox || (turn.execution.sandboxId && turn.execution.sandboxId !== session.sandbox.id)) {
      throw new Error('Sandbox worker recovery information is incomplete');
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
    void this.appServerObservers.get(turn.id)?.close();
  }

  private async terminateWorker(entry: Entry, turn: Turn, handle?: SandboxCommandHandle) {
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

  async preview(session: WorkspaceTarget, port: number): Promise<string> {
    if (this.closing) throw new Error('Sandbox 运行时正在关闭');
    if (!session.sandbox) throw new Error('项目沙箱尚未创建，请先启动服务');
    const entry = await this.acquire(session, false);
    let failed = false;
    try {
      return `http://${entry.sandbox.getHost(port)}:${port}`;
    } catch (error) { failed = true; throw error; }
    finally { await this.release(entry, failed); }
  }

  async proxyHost(session: WorkspaceTarget): Promise<string> {
    if (this.closing) throw new Error('Sandbox 运行时正在关闭');
    if (!session.sandbox) throw new Error('项目沙箱尚未创建，请先启动服务');
    const entry = await this.acquire(session, false);
    try {
      // Docker DNS resolves container names, not IDs. Convert.
      const exec = promisify(execFile);
      const { stdout } = await exec('docker', ['inspect', '--format', '{{.Name}}', entry.sandbox.sandboxId]);
      return stdout.trim().replace(/^\//, '');
    } finally { await this.release(entry, false); }
  }

  async file(session: WorkspaceTarget, path: string, options?: WorkspaceFileReadOptions): Promise<WorkspaceFileResult> {
    if (this.closing) throw new HttpError(503, 'Sandbox 运行时正在关闭');
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

  async history(session: Session, _includeBlocks?: boolean): Promise<NativeHistory> {
    if (!session.threadId) return { turns: [] };
    if (!session.sandbox) throw new Error('Codex 会话对应的沙箱不可用');
    if (!this.options.appServer) throw new Error('Sandbox App Server endpoint is not configured');
    let entry: Entry | undefined;
    let client: CodexAppServerClient | undefined;
    let failed = false;
    try {
      entry = await this.acquire(session, false);
      const endpoint = await this.options.appServer(entry.metadata.id);
      client = await CodexAppServerClient.spawn({ url: endpoint.url, headers: { Authorization: `Bearer ${endpoint.token}` }, requestTimeoutMs: 120_000 });
      return { turns: await this.readAppServerTurns(client, session.threadId) };
    } catch (error) { failed = true; throw this.safeError(error); }
    finally {
      await client?.close();
      if (entry) await this.release(entry, failed);
    }
  }
  async delete(session: WorkspaceTarget) {
    await this.sandboxes.delete(session);
    if (session.sandbox) this.runtimePreparations.delete(session.sandbox.id);
  }

  async rebuild(target: WorkspaceTarget, onSandbox: SaveSandbox) {
    const lease = await this.sandboxes.acquire(target, { create: true, save: onSandbox });
    await lease.release();
  }

  async restoreArchive(target: WorkspaceTarget, archivePath: string) {
    const entry = await this.acquire(target, false);
    try {
      const content = await readFile(archivePath);
      const remote = `${RUNTIME}/archives/${randomUUID()}.tar.gz`;
      await entry.sandbox.files.write(remote, content, { user: 'root' });
      // AGENTS.md is a read-only host mount in freshly created Sandboxes. An
      // older archive may contain the previous copied version, but it must not
      // replace the current global instructions (and tar cannot overwrite the
      // mount in any case).
      const result = await entry.sandbox.commands.run(`set -eu; tar --exclude=home/user/.codex/AGENTS.md --exclude=home/user/.codex/AGENTS.md/* -xzf ${quote(remote)} -C /; rm -f ${quote(remote)}`, { user: 'root', timeoutMs: COMMAND_TIMEOUT_MS });
      if (result && 'exitCode' in result && result.exitCode) throw new Error(result.stderr || '归档恢复失败');
    } finally { await this.release(entry); }
  }

  async createArchive(target: WorkspaceTarget, archivePath: string) {
    if (!target.sandbox) throw new Error('Sandbox 不可用，无法归档');
    const client = this.options.provider as SandboxProvider & { archive?: (id: string, destination: string) => Promise<{ sizeBytes: number; sha256: string }> };
    if (!client.archive) throw new Error('Sandbox provider 不支持数据归档');
    return client.archive(target.sandbox.id, archivePath);
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
