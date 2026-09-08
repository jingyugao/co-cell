import type { SandboxState } from '../../shared/sandbox-types.js';
import type { WorkspaceTarget, ThreadWorkspace } from './types.js';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, extname, posix } from 'node:path';
import { Sandbox, type CommandHandle, type ConnectionOpts } from 'e2b';
import type { AgentEvent } from '../../shared/types.js';
import type { Changes, RawToolPage, Session, Turn } from '../../shared/types.js';
import { loadAgentDocs } from '../shared-files/agent-docs.js';
import { CONNECTION_ROOT, type ConnectionStore } from '../connections/store.js';
import { syncSandboxConnections } from '../connections/sandbox-sync.js';
import type { RuntimeLog } from '../diagnostics/runtime-log.js';
import type { ImprovementContext, ImprovementReceipt } from '../../shared/improvement-types.js';
import type { StoredArchive } from './archive-storage.js';
import { HttpError } from '../core/errors.js';
import type { ModelProxyKind } from '../execution/model-proxy.js';
import { parseWorkspaceFile, READ_SANDBOX_FILE_SCRIPT, workspaceFileRequest, type WorkspaceFileResult } from '../workspaces/files.js';

export interface SandboxSnapshotArchive {
  archive(sandboxId: string): Promise<StoredArchive>;
  restore(sandboxId: string, archive: StoredArchive): Promise<void>;
}

export interface E2BRuntime {
  track?(session: WorkspaceTarget, onSandbox: (value: SandboxState) => Promise<void>): void;
  run(session: Session, turn: Turn, signal: AbortSignal, onSandbox: (value: SandboxState) => Promise<void>): AsyncGenerator<AgentEvent>;
  changes(session: WorkspaceTarget): Promise<Changes>;
  preview(session: WorkspaceTarget, port: number): Promise<string>;
  file(session: WorkspaceTarget, path: string): Promise<WorkspaceFileResult>;
  rawTools(session: ThreadWorkspace, cursor?: number): Promise<RawToolPage>;
  delete(session: WorkspaceTarget): Promise<void>;
  close(): Promise<void>;
}
export interface E2BCodexOptions {
  connection: ConnectionOpts;
  template: string;
  archives?: SandboxSnapshotArchive;
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
type Entry = {
  sandbox: Sandbox;
  metadata: SandboxState;
  notify?: (value: SandboxState) => Promise<void>;
  readers: number;
  running: number;
  preparing?: Promise<void>;
  sharedDocPaths?: Set<string>;
  lastActiveAt: number;
  pausing?: Promise<void>;
  disposed?: boolean;
  initialized?: boolean;
  needsRecovery?: boolean;
  renewedAt: number;
  leaseLimitReported?: boolean;
};
type Tracked = Pick<Entry, 'metadata' | 'notify' | 'lastActiveAt' | 'pausing'>;
export const SANDBOX_PAUSE_TTL_MS = 24 * 60 * 60 * 1000;
export const SANDBOX_ARCHIVE_AFTER_MS = 7 * SANDBOX_PAUSE_TTL_MS;
export const IDLE_SCAN_MS = 60 * 1000;
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
const ownerKey = (session: WorkspaceTarget) => session.projectId ? `project:${session.projectId}` : `session:${session.id}`;

/** Owns one remote Codex installation and workspace per project; threads stay session-specific. */
export class E2BCodexRuntime implements E2BRuntime {
  private entries = new Map<string, Entry>();
  private connecting = new Map<string, Promise<Entry>>();
  private closing = false;
  private tracked = new Map<string, Tracked>();
  private sweepTimer: ReturnType<typeof setInterval>;
  private sweeping?: Promise<void>;
  private readonly timeoutMs = SANDBOX_PAUSE_TTL_MS;
  constructor(private options: E2BCodexOptions) {
    this.sweepTimer = setInterval(() => { void this.sweep(); }, IDLE_SCAN_MS);
    this.sweepTimer.unref();
  }

  // Register persisted owners without connecting to or resuming their sandboxes.
  track(session: WorkspaceTarget, notify: Entry['notify']) {
    if (!session.sandbox || this.entries.has(ownerKey(session))) return;
    const parsed = Date.parse(session.sandbox.lastActiveAt ?? session.updatedAt);
    const lastActiveAt = Number.isFinite(parsed) ? parsed : Date.now();
    this.tracked.set(ownerKey(session), { metadata: { ...session.sandbox, lastActiveAt: new Date(lastActiveAt).toISOString() }, lastActiveAt, notify });
  }

  private sweep() {
    if (this.closing) return Promise.resolve();
    if (this.sweeping) return this.sweeping;
    this.sweeping = (async () => {
      for (const [key, entry] of this.entries) {
        if (this.closing) break;
        if (entry.disposed || entry.pausing || this.connecting.has(key)) continue;
        try { await this.scan(entry, key); }
        catch (error) { await this.pauseError(entry, error); }
      }
      for (const [key, entry] of this.tracked) {
        if (this.closing) break;
        if (this.connecting.has(key) || entry.pausing) continue;
        try { await this.scan(entry, key); }
        catch (error) { await this.pauseError(entry, error); }
      }
    })().catch(error => { void this.options.logger?.write({ event: 'sandbox.idle_scan_failed', message: this.safeError(error).message }); }).finally(() => { this.sweeping = undefined; });
    return this.sweeping;
  }

  private async scan(entry: Tracked, key: string) {
    if (entry.metadata.status === 'archived') return;
    if (entry.metadata.status === 'restoring' && entry.metadata.archive) {
      await this.state(entry, 'archived');
      return;
    }
    // Status inspection is not activity: E2B owns expiry and timeout-pause.
    const info = await this.refreshState(entry);
    if (this.connecting.has(key) || entry.pausing) return;
    if (info.state !== 'paused' || !this.options.archives) return;
    if ('running' in entry && ((entry as Entry).running || (entry as Entry).readers)) return;
    const pausedAt = Date.parse(entry.metadata.pausedAt ?? '');
    if (!Number.isFinite(pausedAt) || Date.now() - pausedAt <= SANDBOX_ARCHIVE_AFTER_MS) return;
    const previous = { ...entry.metadata };
    entry.pausing = (async () => {
      try {
        await this.state(entry, 'archiving');
        const archive = await this.options.archives!.archive(entry.metadata.id);
        if ((await Sandbox.getInfo(entry.metadata.id, this.options.connection)).state !== 'paused') {
          throw new Error('归档期间沙箱已恢复，保留原沙箱并取消归档状态更新');
        }
        entry.metadata = { ...entry.metadata, archive };
        await this.state(entry, 'archived');
        void this.options.logger?.write({ event: 'sandbox.archived', sandboxId: entry.metadata.id, archiveKey: archive.key, sizeBytes: archive.sizeBytes });
      } catch (error) {
        entry.metadata = previous;
        await this.state(entry, 'paused');
        throw error;
      }
    })();
    try { await entry.pausing; } finally { entry.pausing = undefined; }
  }

  private async restoreArchive(entry: Tracked) {
    if (!['archived', 'restoring'].includes(entry.metadata.status)) return;
    if (!entry.metadata.archive || !this.options.archives) throw new Error('沙箱已归档，但归档存储未配置或归档记录缺失');
    try {
      await this.state(entry, 'restoring');
      await this.options.archives.restore(entry.metadata.id, entry.metadata.archive);
      await this.state(entry, 'paused');
      void this.options.logger?.write({ event: 'sandbox.archive_restored', sandboxId: entry.metadata.id, archiveKey: entry.metadata.archive.key });
    } catch (error) {
      await this.state(entry, 'archived');
      throw new Error(`沙箱归档恢复失败：${this.safeError(error).message}`);
    }
  }

  private async pauseError(entry: Tracked, error: unknown) {
    if (/not found|404/i.test(String(error))) await this.refreshState(entry).catch(() => {});
    void this.options.logger?.write({ event: 'sandbox.lifecycle_error', sandboxId: entry.metadata.id, message: this.safeError(error).message });
  }

  private async refreshState(entry: Tracked) {
    try {
      const info = await Sandbox.getInfo(entry.metadata.id, this.options.connection);
      if (info.state === 'paused' && 'sandbox' in entry) (entry as Entry).needsRecovery = true;
      const status = info.state === 'paused' ? 'paused' : entry.metadata.status === 'starting' ? 'starting' : 'ready';
      if (status !== entry.metadata.status || (status === 'paused' && !entry.metadata.pausedAt)) await this.state(entry, status);
      return info;
    } catch (error) {
      // A command-endpoint 404 may only mean paused. Only the management API
      // can tell us that the sandbox itself is missing.
      if (/not found|404/i.test(String(error)) && entry.metadata.status !== 'unavailable') await this.state(entry, 'unavailable');
      throw error;
    }
  }

  private async renew(entry: Entry, signal?: AbortSignal) {
    await entry.sandbox.setTimeout(this.timeoutMs, { signal });
    const info = await this.refreshState(entry);
    if (info.state === 'paused') throw new Error('E2B 沙箱已被平台暂停，请重新发送消息恢复');
    entry.renewedAt = Date.now();
    const capped = info.endAt.getTime() < entry.renewedAt + this.timeoutMs - 5_000;
    if (capped && !entry.leaseLimitReported) {
      void this.options.logger?.write({ event: 'sandbox.lease_capped', sandboxId: entry.metadata.id,
        startedAt: info.startedAt.toISOString(), expiresAt: info.endAt.toISOString(), requestedTimeoutMs: this.timeoutMs,
        message: '平台单次运行时长上限截断了续期，请调整 E2B 平台限制' });
    }
    entry.leaseLimitReported = capped;
  }

  setDefaultTemplate(template: string) { this.options.template = template; }

  private safeError(error: unknown): Error {
    let message = error instanceof Error ? error.message : String(error);
    for (const secret of [this.options.apiKey, this.options.connection.apiKey]) if (secret) message = message.replaceAll(secret, '[REDACTED]');
    return new Error(message);
  }
  private connectionError(id: string, error: unknown) {
    const detail = this.safeError(error).message;
    return new Error(/404|not found/i.test(detail)
      ? `E2B 沙箱 ${id} 不存在或已过期。${detail}`
      : `E2B 沙箱 ${id} 连接失败，请重试。${detail}`);
  }
  private async state(entry: Tracked, status: SandboxState['status']) {
    const previous = entry.metadata.status;
    entry.metadata = { ...entry.metadata, status };
    if (status === 'paused') entry.metadata.pausedAt ??= new Date().toISOString();
    else if (status === 'ready' || status === 'starting') delete entry.metadata.pausedAt;
    await entry.notify?.({ ...entry.metadata });
    if (previous !== status) void this.options.logger?.write({ event: 'sandbox.state_changed', sandboxId: entry.metadata.id, previous, status });
  }
  private touch(entry: Entry) {
    entry.lastActiveAt = Date.now();
    entry.metadata.lastActiveAt = new Date(entry.lastActiveAt).toISOString();
  }
  private async idle(entry: Entry) {
    this.touch(entry);
    if (!entry.disposed && entry.metadata.status === 'ready') {
      // End of use gets a full day as well. Do not extend idle sandboxes during scans.
      await this.renew(entry).catch(error => this.pauseError(entry, error));
    }
    if (!entry.disposed && !entry.running && !entry.readers) await this.state(entry, entry.metadata.status);
  }
  private async acquire(session: WorkspaceTarget, create: boolean, notify?: Entry['notify']): Promise<Entry> {
    const key = ownerKey(session);
    const pending = this.connecting.get(key);
    if (pending) {
      const entry = await pending;
      if (notify) entry.notify = notify;
      return entry;
    }
    const operation = (async () => {
      const tracked = this.tracked.get(key);
      await tracked?.pausing;
      if (tracked) {
        await this.restoreArchive(tracked);
        session.sandbox = { ...tracked.metadata };
        notify ??= tracked.notify;
      }
      let entry = this.entries.get(key);
      if (entry) {
        if (entry.disposed) throw new Error('E2B 项目沙箱正在删除');
        this.touch(entry);
        await entry.pausing;
        if (notify) entry.notify = notify;
        await this.restoreArchive(entry);
        try {
          // The platform can pause a sandbox at its maximum lifetime even while
          // lease renewals return success. Cached readiness is not authoritative.
          const info = await this.refreshState(entry);
          if (info.state !== 'paused' && !entry.needsRecovery) return entry;
          if (entry.running || entry.readers) throw new Error('沙箱连接已中断，正在结束旧任务，请稍后重试');
          entry.sandbox = await Sandbox.connect(entry.metadata.id, { ...this.options.connection, timeoutMs: this.timeoutMs });
          entry.renewedAt = Date.now();
          if (entry.needsRecovery) await this.recover(entry);
          await this.state(entry, 'ready');
          return entry;
        } catch (error) {
          await this.state(entry, 'unavailable');
          throw this.connectionError(entry.metadata.id, error);
        }
      }
      if (session.sandbox && ['archived', 'restoring'].includes(session.sandbox.status)) {
        const archived = { metadata: session.sandbox, notify, lastActiveAt: Date.now() };
        await this.restoreArchive(archived);
        session.sandbox = archived.metadata;
      }
      if (!session.sandbox && !create) throw new Error('E2B 沙箱尚未创建，请先发送一条消息');
      // Capture once: activating a default while create awaits must not relabel it.
      const template = this.options.template;
      let sandbox: Sandbox;
      try {
        sandbox = session.sandbox
          ? await Sandbox.connect(session.sandbox.id, { ...this.options.connection, timeoutMs: this.timeoutMs })
          : await Sandbox.create(template, {
            ...this.options.connection, timeoutMs: this.timeoutMs,
            // Preserve the workspace if the Web backend crashes before its
            // idle scan runs. Reconnection remains explicit through this runtime.
            lifecycle: { onTimeout: 'pause', autoResume: false },
            metadata: { app: 'codex-web', sessionId: session.id, ...(session.projectId ? { projectId: session.projectId } : {}) },
          });
      } catch (error) {
        if (session.sandbox) {
          await notify?.({ ...session.sandbox, status: 'unavailable' });
          throw this.connectionError(session.sandbox.id, error);
        }
        throw this.safeError(error);
      }
      entry = {
        sandbox, readers: 0, running: 0, lastActiveAt: Date.now(), notify, renewedAt: Date.now(), initialized: false, needsRecovery: Boolean(session.sandbox),
        metadata: { ...(session.sandbox?.archive ? { archive: session.sandbox.archive } : {}), id: sandbox.sandboxId, status: session.sandbox ? 'ready' : 'starting', template: session.sandbox?.template ?? template, workingDirectory: session.settings.workingDirectory },
      };
      this.touch(entry);
      this.entries.set(key, entry);
      this.tracked.delete(key);
      if (session.sandbox) await this.recover(entry);
      await notify?.({ ...entry.metadata });
      return entry;
    })();
    this.connecting.set(key, operation);
    try { return await operation; } finally { this.connecting.delete(key); }
  }

  private async recover(entry: Entry) {
    // A backend crash can leave a worker in a memory snapshot. Reap only this
    // runtime's marked processes when attaching after a restart, before another
    // turn can run. Check command lines as well, so a stale PID cannot target an
    // unrelated process after a filesystem-only sandbox reboot.
    const script = `
const fs=require('node:fs'),cp=require('node:child_process');
const markers=fs.readdirSync('/tmp').filter(name=>/^codex-web-[a-f0-9-]{36}\\.pid$/.test(name)).map(name=>'/tmp/'+name);
const roots=[];
for(const marker of markers){
  let pid,command='';
  try{pid=Number(fs.readFileSync(marker,'utf8').trim());if(Number.isInteger(pid)&&pid>1)command=fs.readFileSync('/proc/'+pid+'/cmdline','utf8')}catch{}
  if(command.includes(${JSON.stringify(RUNTIME)})||command.includes('@openai/codex-sdk'))roots.push(pid);
}
const rows=cp.execFileSync('ps',['-e','-o','pid=,ppid='],{encoding:'utf8'}).trim().split('\\n').map(s=>s.trim().split(/\\s+/).map(Number));
const targets=new Set(roots);let changed=true;
while(changed){changed=false;for(const [pid,ppid] of rows)if(targets.has(ppid)&&!targets.has(pid)){targets.add(pid);changed=true}}
const kill=(pid,signal)=>{try{process.kill(pid,signal)}catch{}};
for(const root of roots)kill(-root,'SIGTERM');for(const pid of targets)kill(pid,'SIGTERM');
const finish=()=>{for(const root of roots)kill(-root,'SIGKILL');for(const pid of targets)kill(pid,'SIGKILL');for(const marker of markers)try{fs.unlinkSync(marker)}catch{}};
if(roots.length)setTimeout(finish,1200);else finish();`;
    try {
      await entry.sandbox.commands.run(`${NODE} -e ${quote(script)}`, { user: 'user', timeoutMs: 10_000 });
      // A new session has no thread yet, but its project's helper may already exist.
      entry.initialized = await entry.sandbox.files.exists(`${RUNTIME}/e2b-inspect.mjs`, { user: 'user' });
      entry.needsRecovery = false;
    }
    catch (error) {
      await this.state(entry, 'unavailable');
      throw new Error(`无法清理 E2B 中断任务，请重试恢复沙箱：${this.safeError(error).message}`);
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
        user: 'user', background: true, timeoutMs: options.timeoutMs ?? this.timeoutMs,
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
      await stopping?.catch(() => {});
      // Marker cleanup is bounded and does not affect any other process group.
      await entry.sandbox.files.remove(marker, { user: 'user' }).catch(() => {});
    }
  }

  private async writeAtomic(entry: Entry, path: string, content: string | ArrayBuffer, signal: AbortSignal) {
    const staging = path + '.' + randomUUID() + '.tmp';
    try {
      await entry.sandbox.files.write(staging, content, { user: 'user', signal });
      await entry.sandbox.files.rename(staging, path, { user: 'user', signal });
    } finally { await entry.sandbox.files.remove(staging, { user: 'user' }).catch(() => {}); }
  }

  // Serialize application-owned installation/sync only. Codex workers run concurrently.
  private async prepare<T>(entry: Entry, signal: AbortSignal, action: () => Promise<T>): Promise<T> {
    let started = false;
    const operation = (entry.preparing ?? Promise.resolve()).then(() => {
      checkAbort(signal);
      started = true;
      return action();
    });
    entry.preparing = operation.then(() => {}, () => {});
    // Cancelling a queued turn must not wait for another turn's installation.
    return new Promise<T>((resolve, reject) => {
      const abort = () => { if (!started) reject(new DOMException('任务已停止', 'AbortError')); };
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    });
  }

  async *run(session: Session, turn: Turn, signal: AbortSignal, onSandbox: Entry['notify']): AsyncGenerator<AgentEvent> {
    if (this.closing) throw new Error('E2B 运行时正在关闭');
    if (!this.options.apiKey) throw new Error('E2B 模式需要 CODEX_API_KEY 或 OPENAI_API_KEY');
    checkAbort(signal);
    const entry = await this.acquire(session, true, onSandbox);
    if (entry.disposed) throw new Error('E2B 项目沙箱正在删除');
    entry.metadata.workingDirectory = session.settings.workingDirectory;
    entry.running++;
    this.touch(entry);
    let inputPath: string | undefined;
    let improvementReplyDirectory: string | undefined;
    const improvementRequests = new Map<string, Promise<void>>();
    let renewal: ReturnType<typeof setInterval> | undefined;
    let renewing = false;
    const lease = new AbortController();
    const executionSignal = AbortSignal.any([signal, lease.signal]);
    let leaseError: Error | undefined;
    try {
      checkAbort(signal);
      await this.renew(entry, executionSignal);
      renewal = setInterval(() => {
        if (renewing) return;
        renewing = true;
        void this.renew(entry).catch(error => {
          leaseError = new Error(`E2B 沙箱续期失败：${this.safeError(error).message}`);
          lease.abort();
        }).finally(() => { renewing = false; });
      }, Math.max(1000, Math.min(60_000, this.timeoutMs / 3)));
      renewal.unref();
      const connectionEnvs = await this.prepare(entry, executionSignal, async () => {
        // Read on every turn, including resumed threads. Global guidance applies
        // across Git roots without replacing any project-owned AGENTS.md.
        const sharedData = this.options.sharedDataDirectory ?? SHARED_DATA;
        const sharedAgents = await readFile(new URL('AGENTS.md', sharedData), 'utf8').catch(error => {
          if (error.code === 'ENOENT') return ''; // Deleting global rules clears the remote copy next turn.
          throw error;
        });
        const sharedDocs = await loadAgentDocs(new URL('docs/', sharedData));
        await this.command(entry, `sh -c ${quote(`mkdir -p ${quote(RUNTIME)} ${quote(`${ROOT}/images`)} /home/user/.codex ${quote(session.settings.workingDirectory)} && chmod 700 ${quote(ROOT)} /home/user/.codex && cd ${quote(RUNTIME)} && if ! ${NODE} -e 'if(require("./node_modules/@openai/codex-sdk/package.json").version!=="0.153.4")process.exit(1)' >/dev/null 2>&1; then npm install --no-audit --no-fund --save-exact @openai/codex-sdk@0.153.4; fi`)}`, executionSignal, { timeoutMs: 300_000 });
        const connectionEnvs = this.options.connections ? await syncSandboxConnections(entry.sandbox, this.options.connections, executionSignal) : {};
        checkAbort(executionSignal);
        // Clear a legacy mirror only on the first preparation, before any worker
        // starts. Subsequent turns update files atomically while siblings run.
        const docDirectories = new Set([SHARED_DOCS, ...sharedDocs.map(file => posix.dirname(`${SHARED_DOCS}/${file.path}`))]);
        const clearLegacy = entry.sharedDocPaths ? '' : `rm -rf ${quote(SHARED_DOCS)} ${quote(`${ROOT}/docs`)} && `;
        await this.command(entry, `sh -c ${quote(`${clearLegacy}mkdir -p ${[...docDirectories].map(quote).join(' ')}`)}`, executionSignal);
        for (const file of sharedDocs) {
          checkAbort(executionSignal);
          await this.writeAtomic(entry, `${SHARED_DOCS}/${file.path}`, file.contents, executionSignal);
        }
        const currentPaths = new Set(sharedDocs.map(file => file.path));
        for (const path of entry.sharedDocPaths ?? []) {
          if (!currentPaths.has(path)) await entry.sandbox.files.remove(`${SHARED_DOCS}/${path}`, { user: 'user', signal: executionSignal });
        }
        entry.sharedDocPaths = currentPaths;
        await this.writeAtomic(entry, `${CODEX_HOME}/AGENTS.md`, sharedAgents, executionSignal);
        for (const name of ['e2b-worker.mjs', 'e2b-inspect.mjs', 'diagnostic-proxy.mjs', 'improvement-bridge.mjs', 'improvement-mcp.mjs']) {
          checkAbort(executionSignal);
          await this.writeAtomic(entry, `${RUNTIME}/${name}`, await readFile(new URL(`../execution/worker/${name}`, import.meta.url), 'utf8'), executionSignal);
        }
        entry.initialized = true;
        return connectionEnvs;
      });
      const images: string[] = [];
      for (const path of turn.images) {
        checkAbort(executionSignal);
        const destination = `${ROOT}/images/${turn.id}-${images.length}${extname(basename(path))}`;
        await entry.sandbox.files.write(destination, new Uint8Array(await readFile(path)).buffer, { user: 'user', signal: executionSignal });
        images.push(destination);
      }
      inputPath = `${RUNTIME}/input-${randomUUID()}.json`;
      if (this.options.submitImprovement) {
        // Host chooses an isolated, opaque directory; tool arguments never select
        // context IDs or filesystem paths, including when sibling turns run.
        improvementReplyDirectory = `${RUNTIME}/improvement-replies-${randomUUID()}`;
        await this.command(entry, `mkdir -m 700 ${quote(improvementReplyDirectory)}`, executionSignal);
      }
      checkAbort(executionSignal);
      await entry.sandbox.files.write(inputPath, JSON.stringify({
        threadId: session.threadId, prompt: turn.prompt, images, settings: session.settings,
        connectionDirectories: Object.keys(connectionEnvs).length ? [CONNECTION_ROOT, ...('MEEGLE_HOST' in connectionEnvs ? ['/home/user/.meegle'] : []), ...('KUBECONFIG' in connectionEnvs ? ['/home/user/.kube'] : [])] : [],
        baseUrl: this.options.baseUrl, proxyKind: this.options.proxyKind,
        modelConfig: this.options.modelConfig, configOverrides: this.options.configOverrides,
        improvementReplyDirectory,
      }), { user: 'user', signal: executionSignal });
      await this.state(entry, 'ready');
      const queue: AgentEvent[] = [];
      let wake: (() => void) | undefined;
      let buffer = '', stderr = '', done = false, failure: unknown;
      const operation = this.command(entry, `${NODE} ${quote(`${RUNTIME}/e2b-worker.mjs`)} ${quote(inputPath)}`, executionSignal, {
        timeoutMs: 0,
        envs: { ...connectionEnvs, CODEX_API_KEY: this.options.apiKey, CODEX_HOME },
        onStderr: chunk => { stderr = (stderr + chunk).slice(-16_384); },
        onStdout: chunk => {
          buffer += chunk;
          let end: number;
          while ((end = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
            if (!line.trim()) continue;
            try {
              const event = JSON.parse(line);
              if (event.type === 'runtime.improvement_proposal') {
                const requestId = event.requestId;
                if (!this.options.submitImprovement || !improvementReplyDirectory || executionSignal.aborted
                  || typeof requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)
                  || improvementRequests.has(requestId)) continue;
                const replyPath = `${improvementReplyDirectory}/${requestId}.json`;
                const submit = this.options.submitImprovement;
                const request = (async () => {
                  let reply;
                  try {
                    const receipt = await submit({ projectId: session.projectId ?? null, sessionId: session.id,
                      sessionTitle: session.title, turnId: turn.id, sandboxId: entry.metadata.id }, event.input, requestId);
                    reply = { ok: true, receipt };
                  } catch {
                    // Never send DB internals or connection credentials to Codex.
                    reply = { ok: false, error: '建议未能保存，请检查五个字段均为有效文本后重试。' };
                    void this.options.logger?.write({ event: 'improvement.save_failed', sessionId: session.id, turnId: turn.id, requestId });
                  }
                  if (!executionSignal.aborted) await this.writeAtomic(entry, replyPath, JSON.stringify(reply), executionSignal);
                })().catch(() => {
                  void this.options.logger?.write({ event: 'improvement.receipt_failed', sessionId: session.id, turnId: turn.id, requestId });
                });
                improvementRequests.set(requestId, request);
              } else if (event.type === 'runtime.diagnostic') {
                // Diagnostics are not SDK events and never contain prompt/tool bodies.
                const allowed = ['event', 'requestId', 'method', 'path', 'upstream', 'status', 'httpStatus', 'durationMs', 'requestBytes', 'responseBytes', 'model', 'inputItems', 'responseId', 'upstreamRequestId', 'requestIds', 'error', 'message', 'code', 'terminalEvent', 'terminationReason', 'reason', 'incompleteReason', 'transportComplete', 'contentType', 'contentEncoding', 'sseEvents', 'parseError', 'clientAborted', 'requestAttempt', 'attempt', 'maxRetries', 'delayMs', 'nextRetryAt', 'channelId'];
                const diagnostic = event.diagnostic;
                if (diagnostic && typeof diagnostic === 'object') {
                  const fields = Object.fromEntries(allowed.filter(key => key in diagnostic).map(key => [key, diagnostic[key]]));
                  void this.options.logger?.write({ ...fields, source: 'e2b-proxy', sessionId: session.id, projectId: session.projectId, turnId: turn.id,
                    threadId: session.threadId, sandboxId: entry.metadata.id, model: session.settings.model });
                }
              } else queue.push(event as AgentEvent);
            }
            catch { failure = new Error('E2B Codex 返回了无效的事件 JSON'); }
          }
          wake?.();
        },
      }).catch(error => { failure = error; }).finally(() => { done = true; wake?.(); });
      try {
        while (!done || queue.length) {
          if (queue.length) { yield queue.shift()!; continue; }
          await new Promise<void>(resolve => { wake = resolve; });
          wake = undefined;
        }
        if (leaseError) throw leaseError;
        if (failure) throw this.safeError(stderr ? `${(failure as Error).message}\n${stderr}` : failure);
        if (buffer.trim()) throw new Error('E2B Codex 事件流在完整 JSON 行之前断开');
      } finally { await operation; await this.options.logger?.flush(); }
    } finally {
      clearInterval(renewal);
      await Promise.allSettled(improvementRequests.values());
      if (improvementReplyDirectory) await entry.sandbox.files.remove(improvementReplyDirectory, { user: 'user' }).catch(() => {});
      if (inputPath) await entry.sandbox.files.remove(inputPath, { user: 'user' }).catch(() => {});
      await this.refreshState(entry).catch(error => {
        void this.options.logger?.write({ event: 'sandbox.state_check_failed', sandboxId: entry.metadata.id, message: this.safeError(error).message });
      });
      entry.running--;
      if (entry.metadata.status === 'starting') await this.state(entry, 'ready');
      await this.idle(entry);
    }
  }

  private async inspect<T>(session: WorkspaceTarget, mode: string, args: string[]): Promise<T> {
    const entry = await this.acquire(session, false);
    entry.readers++;
    this.touch(entry);
    try {
      if (entry.disposed) throw new Error('E2B 项目沙箱正在删除');
      if (!entry.initialized) throw new Error('E2B Codex 尚未完成初始化，请等待当前任务启动后重试');
      if (Date.now() - entry.renewedAt > IDLE_SCAN_MS) {
        await this.renew(entry);
      }
      const result = await entry.sandbox.commands.run(`${NODE} ${quote(`${RUNTIME}/e2b-inspect.mjs`)} ${quote(mode)} ${args.map(quote).join(' ')}`, { user: 'user', timeoutMs: 30_000 });
      return JSON.parse(result.stdout) as T;
    } catch (error) {
      const stdout = (error as { stdout?: string })?.stdout;
      if (stdout) {
        let detail;
        try { detail = JSON.parse(stdout); } catch { /* Retain the transport error. */ }
        if (typeof detail?.error === 'string') throw this.safeError(detail.error);
      }
      if (/not found|404/i.test(String(error))) await this.refreshState(entry).catch(() => {});
      throw this.safeError(error);
    }
    finally { entry.readers--; await this.idle(entry); }
  }
  async preview(session: WorkspaceTarget, port: number): Promise<string> {
    if (this.closing) throw new Error('E2B 运行时正在关闭');
    if (!session.sandbox) throw new Error('项目沙箱尚未创建，请先启动服务');
    const entry = await this.acquire(session, false);
    entry.readers++;
    this.touch(entry);
    try {
      if (entry.disposed) throw new Error('项目沙箱正在删除');
      await this.renew(entry);
      const gateway = this.options.connection.sandboxUrl;
      const url = new URL(gateway ?? `https://${entry.sandbox.getHost(port)}`);
      url.hostname = entry.sandbox.getHost(port);
      url.pathname = '/'; url.search = ''; url.hash = '';
      return url.origin;
    } finally { entry.readers--; await this.idle(entry); }
  }

  async file(session: WorkspaceTarget, path: string): Promise<WorkspaceFileResult> {
    if (this.closing) throw new HttpError(503, 'E2B 运行时正在关闭');
    const request = workspaceFileRequest(session.settings.workingDirectory, path);
    let entry: Entry;
    try { entry = await this.acquire(session, false); }
    catch (error) { throw new HttpError(502, this.safeError(error).message); }
    entry.readers++;
    this.touch(entry);
    try {
      if (entry.disposed) throw new HttpError(409, '项目沙箱正在删除');
      if (Date.now() - entry.renewedAt > IDLE_SCAN_MS) await this.renew(entry);
      const encoded = Buffer.from(JSON.stringify(request)).toString('base64');
      const result = await entry.sandbox.commands.run(`${NODE} --input-type=commonjs -e ${quote(READ_SANDBOX_FILE_SCRIPT)} ${quote(encoded)}`, { user: 'user', timeoutMs: 30_000 });
      return parseWorkspaceFile(result.stdout);
    } catch (error) {
      if (error instanceof HttpError) throw error;
      if (/not found|404/i.test(String(error))) await this.refreshState(entry).catch(() => {});
      throw new HttpError(502, this.safeError(error).message);
    } finally { entry.readers--; await this.idle(entry); }
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
  async delete(session: WorkspaceTarget) {
    const key = ownerKey(session);
    await this.connecting.get(key);
    const tracked = this.tracked.get(key);
    await tracked?.pausing;
    const entry = this.entries.get(key);
    if (entry) this.touch(entry);
    if (entry?.running) throw new Error('请先停止 E2B 中的当前任务');
    const sandboxId = entry?.metadata.id ?? session.sandbox?.id;
    if (!sandboxId) return;
    if (entry) entry.disposed = true;
    await entry?.pausing;
    try { await Sandbox.kill(sandboxId, this.options.connection); }
    catch (error) {
      if (!/not found|404/i.test(String(error))) {
        if (entry) { entry.disposed = false; await this.idle(entry); }
        throw this.safeError(error);
      }
    }
    this.entries.delete(key);
    this.tracked.delete(key);
  }
  async close() {
    this.closing = true;
    clearInterval(this.sweepTimer);
    await this.sweeping;
    // Closing the Web service is not idle activity and must not force a pause.
  }
}
