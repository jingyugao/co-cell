import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises';
import { posix } from 'node:path';
import type { CheckpointableSandboxProvider, SandboxCheckpoint, SandboxCommandHandle, SandboxCommandResult, SandboxHandle, SandboxInfo, SandboxProvider } from '../../types.js';
import { CellboxClient, CellboxError, type CellboxBox, type CellboxClientOptions, type CellboxOperation, type CellboxProfile } from './client.js';

export interface CellboxSandboxProviderOptions extends CellboxClientOptions {
  /** An admitted Cellbox profile. initialize() verifies Kubernetes checkpoint support. */
  profileId: string;
  /** Product-facing runtime kind; only k8s-resumable is implemented by this adapter. */
  kind?: 'k8s-resumable';
  /** Product workspace. Cellbox returns its actual workspace on each box. */
  workspace?: string;
  /** Upper bound for waiting on asynchronous operations. */
  operationTimeoutMs?: number;
  retryDelayMs?: number;
  /** Durable fallback for SandboxProvider.create when metadata has no caller-persisted key. */
  stateDirectory?: string;
}
type RunOptions = {
  user?: string; signal?: AbortSignal; timeoutMs?: number; background?: boolean;
  cwd?: string; envs?: Record<string, string>; onStdout?: (value: string) => void; onStderr?: (value: string) => void;
  /** Stable caller-persisted key allows reconnecting to an interrupted submission. */
  idempotencyKey?: string;
};
export interface CellboxServiceAccess {
  url: string;
  headers: Record<string, string>;
}

const inside = (path: string, root: string) => path === root || path.startsWith(`${root}/`);
const q = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const defaultWaitMs = 15 * 60_000;

function validAgent(user?: string) {
  if (user !== undefined && user !== 'agent' && user !== 'user')
    throw new CellboxError('UNSUPPORTED_CAPABILITY', 'Cellbox public commands and files run only as the agent identity');
}
function requirePath(path: string) {
  if (!path || path.includes('\0') || /[\x00-\x1f\x7f]/.test(path))
    throw new CellboxError('INVALID_REQUEST', 'A nonempty path without control characters is required');
  const parts = path.split('/');
  if (parts.includes('..')) throw new CellboxError('INVALID_REQUEST', 'Path traversal is not allowed');
  return posix.normalize(path);
}
function workspacePath(path: string, workspace: string) {
  const normalized = requirePath(path);
  const absolute = posix.isAbsolute(normalized) ? normalized : posix.join(workspace, normalized);
  if (!inside(absolute, workspace)) return undefined;
  return posix.relative(workspace, absolute) || '.';
}
function asBytes(value: Uint8Array | ArrayBuffer | string) {
  return typeof value === 'string' ? Buffer.from(value) : value instanceof ArrayBuffer ? new Uint8Array(value) : value;
}

/** Adapter for the resumable Kubernetes Cellbox profile. */
export class CellboxSandboxProvider implements CheckpointableSandboxProvider {
  readonly client: CellboxClient;
  private readonly profileId: string;
  private readonly kind: 'k8s-resumable';
  private readonly workspace?: string;
  private readonly maxWaitMs: number;
  private readonly retryMs: number;
  private readonly stateDirectory?: string;
  private initialized = false;
  private profile?: CellboxProfile;
  constructor(options: CellboxSandboxProviderOptions) {
    this.client = new CellboxClient(options);
    this.profileId = options.profileId;
    this.kind = options.kind ?? 'k8s-resumable';
    this.workspace = options.workspace && posix.normalize(options.workspace);
    this.maxWaitMs = options.operationTimeoutMs ?? defaultWaitMs;
    this.retryMs = options.retryDelayMs ?? 100;
    this.stateDirectory = options.stateDirectory;
    if (!this.profileId || this.maxWaitMs < 1 || this.retryMs < 1)
      throw new CellboxError('INVALID_REQUEST', 'Valid profileId and operation wait bounds are required');
  }
  async initialize() {
    const profile = (await this.client.listProfiles()).find(value => value.id === this.profileId);
    if (!profile) throw new CellboxError('NOT_FOUND', `Cellbox profile ${this.profileId} is unavailable to this client`);
    if (profile.provider !== 'resumable-k8s-pod' || profile.capabilities.suspend !== 'same-node-checkpoint')
      throw new CellboxError('UNSUPPORTED_CAPABILITY', `Cellbox profile ${this.profileId} is not a resumable Kubernetes pod`);
    if (profile.kind !== this.kind || profile.runtime !== 'k8s' || profile.behavior !== 'resumable')
      throw new CellboxError('UNSUPPORTED_CAPABILITY', `Cellbox profile ${this.profileId} does not provide ${this.kind}`);
    if (this.workspace && profile.workspace !== this.workspace)
      throw new CellboxError('CONFLICT', `Cellbox profile ${this.profileId} workspace differs from configured workspace`);
    if (!profile.capabilities.exec || !profile.capabilities.files || !profile.capabilities.http || !profile.capabilities.websocket)
      throw new CellboxError('UNSUPPORTED_CAPABILITY', `Cellbox profile ${this.profileId} lacks required CoCell capabilities`);
    if (!profile.image || !profile.workspace)
      throw new CellboxError('PROTOCOL', `Cellbox profile ${this.profileId} lacks image or workspace identity`);
    this.profile = profile;
    this.initialized = true;
    return profile;
  }
  private async ready() { if (!this.initialized) await this.initialize(); }
  private async box(id: string) {
    const box = await this.client.getBox(id);
    if (box.profileId !== this.profileId) throw new CellboxError('CONFLICT', `Box ${id} uses another profile`);
    if (this.workspace && box.workspace !== this.workspace)
      throw new CellboxError('CONFLICT', `Box ${id} workspace differs from configured workspace`);
    return box;
  }
  private async wait(op: CellboxOperation, timeoutMs = this.maxWaitMs, signal?: AbortSignal): Promise<CellboxOperation> {
    const until = Date.now() + timeoutMs;
    let current = op;
    for (;;) {
      if (current.status === 'succeeded') return current;
      if (current.status === 'failed')
        throw new CellboxError(current.error?.code ?? 'CONFLICT', current.error?.message ?? `Cellbox ${current.kind} failed`);
      if (signal?.aborted) throw new CellboxError('UNKNOWN_OUTCOME', `Cellbox operation ${op.id} continues after caller abort`);
      const remaining = until - Date.now();
      if (remaining <= 0) throw new CellboxError('UNKNOWN_OUTCOME', `Cellbox operation ${op.id} is still pending after the wait limit`);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.min(15_000, Math.max(1, until - Date.now())));
      try { current = await this.client.getOperation(op.id, signal ? AbortSignal.any([signal, controller.signal]) : controller.signal, Math.min(10_000, remaining)); }
      catch (error) {
        if (signal?.aborted) throw new CellboxError('UNKNOWN_OUTCOME', `Cellbox operation ${op.id} continues after caller abort`, undefined, undefined, { cause: error });
        if (Date.now() >= until) throw new CellboxError('UNKNOWN_OUTCOME', `Cellbox operation ${op.id} may still be pending`, undefined, undefined, { cause: error });
        if (error instanceof CellboxError && error.code === 'TRANSPORT') {
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, Math.min(this.retryMs, Math.max(1, until - Date.now())));
            const abort = () => { clearTimeout(timer); reject(new CellboxError('UNKNOWN_OUTCOME', `Cellbox operation ${op.id} continues after caller abort`)); };
            signal?.addEventListener('abort', abort, { once: true });
          });
          continue;
        }
        throw error;
      } finally { clearTimeout(timer); }
    }
  }
  waitForOperation(op: CellboxOperation, timeoutMs?: number, signal?: AbortSignal) { return this.wait(op, timeoutMs, signal); }
  inspectOperation(id: string) { return this.client.getOperation(id); }
  private async act(id: string, action: 'suspend' | 'resume' | 'destroy' | 'activate' | 'reconcile', key: string) {
    return this.wait(await this.client.actBox(id, action, key));
  }
  private async createJournal(ownerKey: string) {
    if (!this.stateDirectory) throw new CellboxError('INVALID_REQUEST', 'Create requires metadata.cellboxIdempotencyKey or provider stateDirectory');
    await mkdir(this.stateDirectory, { recursive: true, mode: 0o700 });
    const name = createHash('sha256').update(`${this.profileId}\0${ownerKey}`).digest('hex');
    const path = posix.join(this.stateDirectory, `${name}.json`);
    let record: { key: string; boxId?: string } | undefined;
    try { record = JSON.parse(await readFile(path, 'utf8')) as { key: string; boxId?: string }; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (record?.boxId) {
      try {
        const box = await this.box(record.boxId);
        if (box.phase === 'deleted' || (box.phase === 'failed' && !box.operationId)) record = undefined;
      } catch (error) {
        if (error instanceof CellboxError && error.code === 'NOT_FOUND') record = undefined;
        else throw error;
      }
    }
    if (!record) {
      record = { key: randomUUID() };
      await this.saveCreateJournal(path, record);
    }
    return { path, record };
  }
  private async saveCreateJournal(path: string, record: { key: string; boxId?: string }) {
    const temp = `${path}.${randomUUID()}.tmp`;
    try {
      const file = await open(temp, 'wx', 0o600);
      try { await file.writeFile(JSON.stringify(record)); await file.sync(); }
      finally { await file.close(); }
      await rename(temp, path);
      const directory = await open(posix.dirname(path), 'r');
      try { await directory.sync(); }
      finally { await directory.close(); }
    } finally { await unlink(temp).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }); }
  }
  async create(template: string, options: Parameters<SandboxProvider['create']>[1]): Promise<SandboxHandle> {
    await this.ready();
    if (template !== this.profileId) throw new CellboxError('INVALID_REQUEST', `Template must be Cellbox profile ${this.profileId}`);
    const ownerKey = options.metadata?.cellboxOwnerKey
      ?? (options.metadata?.projectId ? `project:${options.metadata.projectId}` : undefined)
      ?? (options.metadata?.sessionId ? `session:${options.metadata.sessionId}` : undefined);
    if (!ownerKey) throw new CellboxError('INVALID_REQUEST', 'Create requires a project, session, or explicit Cellbox owner key');
    const journal = options.metadata?.cellboxIdempotencyKey ? undefined : await this.createJournal(ownerKey);
    const key = options.metadata?.cellboxIdempotencyKey ?? journal!.record.key;
    const staged = options.metadata?.cellboxStaged === 'true';
    const op = await this.client.createBox({ profileId: this.profileId, ownerKey, ...(staged ? { staged: true } : {}), ...(options.metadata?.cellboxImportedImageId ? { importedImageId: options.metadata.cellboxImportedImageId } : {}) }, key);
    if (journal && journal.record.boxId !== op.targetId)
      await this.saveCreateJournal(journal.path, { key, boxId: op.targetId });
    await this.wait(op);
    const box = await this.box(op.targetId);
    if (box.phase === 'suspended') return this.connect(box.id);
    if (box.phase !== 'running' && !(staged && box.phase === 'staged')) throw new CellboxError('CONFLICT', `Created box ${box.id} is ${box.phase}`);
    return this.handle(box);
  }
  async connect(id: string): Promise<SandboxHandle> {
    await this.ready();
    let box = await this.box(id);
    if (box.phase === 'suspended') {
      await this.act(id, 'resume', `cocell-resume-${id}-${box.generation}`);
      box = await this.box(id);
    }
    if (box.phase !== 'running') throw new CellboxError('CONFLICT', `Box ${id} is ${box.phase}`);
    return this.handle(box);
  }
  /** Restore candidates accept agent setup while staged; no resume or activation occurs here. */
  async connectForSetup(id: string): Promise<SandboxHandle> {
    await this.ready();
    const box = await this.box(id);
    if (box.phase !== 'running' && box.phase !== 'staged')
      throw new CellboxError('CONFLICT', `Box ${id} is ${box.phase}`);
    return this.handle(box);
  }
  async getInfo(id: string): Promise<SandboxInfo> {
    await this.ready();
    const box = await this.box(id);
    return this.boxInfo(box);
  }
  async getInfos(ids: string[]): Promise<SandboxInfo[]> {
    if (!ids.length) return [];
    await this.ready();
    const wanted = new Set(ids);
    const boxes = await this.client.listResourceBoxes();
    return boxes.filter(box => wanted.has(box.id) && box.profileId === this.profileId)
      .map(box => this.boxInfo(box));
  }
  private boxInfo(box: CellboxBox): SandboxInfo {
    const startedAt = new Date(box.createdAt);
    return { sandboxId: box.id, state: box.phase === 'running' ? 'running' : box.phase === 'suspended' ? 'paused' : 'unknown',
      startedAt, endAt: new Date('9999-12-31T23:59:59.999Z'),
      metadata: { ownerKey: box.ownerKey, profileId: box.profileId, generation: String(box.generation), phase: box.phase },
      templateIdentity: { reference: box.image, id: box.imageId ?? box.image, repoDigests: [] } };
  }
  async pause(id: string) {
    await this.ready();
    const box = await this.box(id);
    if (box.phase === 'suspended') return true;
    if (box.phase !== 'running') throw new CellboxError('CONFLICT', `Box ${id} is ${box.phase}`);
    await this.act(id, 'suspend', `cocell-suspend-${id}-${box.generation}`);
    return true;
  }
  /** The marker refers to this box's same-node suspended state, not an independent checkpoint image. */
  async checkpoint(id: string): Promise<SandboxCheckpoint> {
    await this.pause(id);
    const box = await this.box(id);
    if (box.phase !== 'suspended') throw new CellboxError('CONFLICT', `Box ${id} did not suspend`);
    return { id: `cellbox-suspended:${id}:${box.generation}`, createdAt: new Date().toISOString() };
  }
  async restore(id: string, checkpointId: string): Promise<void> {
    const box = await this.box(id);
    if (checkpointId !== `cellbox-suspended:${id}:${box.generation}` || box.phase !== 'suspended')
      throw new CellboxError('CONFLICT', 'The same-node Cellbox suspension is no longer available');
    await this.act(id, 'resume', `cocell-resume-${id}-${box.generation}`);
  }
  async kill(id: string) {
    await this.ready();
    let box: CellboxBox | undefined;
    try { box = await this.box(id); }
    catch (error) { if (!(error instanceof CellboxError) || error.code !== 'NOT_FOUND') throw error; }
    if (box && box.phase !== 'deleted') await this.act(id, 'destroy', `cocell-destroy-${id}`);
    try {
      await this.client.purgeBoxArtifacts(id);
      await this.removeCreateJournal(id, box?.ownerKey);
    }
    catch (error) {
      // Generic provider consumers ignore missing-box errors. A missing purge
      // endpoint is instead an incomplete cleanup and must retain its retry journal.
      throw new CellboxError('CLEANUP_FAILED', 'Cellbox artifact cleanup has not completed', undefined, undefined, { cause: error });
    }
    return true;
  }
  private async removeCreateJournal(boxId: string, ownerKey?: string) {
    if (!this.stateDirectory) return;
    let names: string[];
    try { names = await readdir(this.stateDirectory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    let removed = false;
    const ownerHash = ownerKey && createHash('sha256').update(`${this.profileId}\0${ownerKey}`).digest('hex');
    for (const name of names) {
      if (!/^[a-f0-9]{64}\.(?:json|[a-f0-9-]{36}\.tmp)$/.test(name)) continue;
      const path = posix.join(this.stateDirectory, name);
      let raw: string;
      try { raw = await readFile(path, 'utf8'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      let record: { boxId?: string };
      try { record = JSON.parse(raw); } catch { record = {}; }
      if (record?.boxId === boxId || (ownerHash && name.startsWith(`${ownerHash}.`) && name.endsWith('.tmp'))) {
        await unlink(path).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
        removed = true;
      }
    }
    if (removed) {
      const directory = await open(this.stateDirectory, 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    }
  }
  async resumeBox(id: string, key: string) { await this.ready(); return this.act(id, 'resume', key); }
  async suspendBox(id: string, key: string) { await this.ready(); return this.act(id, 'suspend', key); }
  async activateBox(id: string, key: string) { await this.ready(); return this.act(id, 'activate', key); }
  async reconcileBox(id: string, key: string) { await this.ready(); return this.act(id, 'reconcile', key); }
  async restoreArchive(input: { ownerKey: string; archiveId: string }, key: string) {
    await this.ready();
    return this.wait(await this.client.restoreBox({ profileId: this.profileId, ...input }, key));
  }
  async captureArchive(id: string, key: string) { return this.wait(await this.client.captureArchive(id, key)); }
  async listInventory() {
    const [boxes, checkpoints] = await Promise.all([this.client.listBoxes(), this.client.listCheckpoints()]);
    return { boxes, checkpoints };
  }
  async listBoxes() {
    const { boxes: active, checkpoints } = await this.listInventory();
    const byId = new Map(active.map(box => [box.id, box]));
    for (const box of checkpoints) if (!byId.has(box.id)) byId.set(box.id, box);
    return [...byId.values()];
  }
  async currentImageIdentity(id?: string) {
    if (id) { const box = await this.box(id); return { reference: box.image, id: box.imageId ?? box.image, repoDigests: [] as string[] }; }
    await this.ready();
    const profile = this.profile!;
    return { reference: profile.image, id: profile.image, repoDigests: [] as string[] };
  }
  createLease(boxId: string, purpose: string, ttlSeconds = 60) { return this.client.createLease(boxId, purpose, ttlSeconds); }
  renewLease(id: string, purpose: string, ttlSeconds = 60) { return this.client.renewLease(id, purpose, ttlSeconds); }
  releaseLease(id: string) { return this.client.releaseLease(id); }
  private async serviceRoute(id: string, port: number) {
    if (!Number.isInteger(port) || port < 1 || port > 65535 || port === 40000)
      throw new CellboxError('INVALID_REQUEST', 'Service port must be 1..65535 excluding 40000');
    return this.client.createRoute(id, port);
  }
  /** Backend and preview connections both use the direct internal endpoint. */
  async getServiceAccess(id: string, port: number): Promise<CellboxServiceAccess> {
    return this.client.internalService(id, port);
  }
  private handle(box: CellboxBox): SandboxHandle & { getServiceAccess(port: number): Promise<CellboxServiceAccess> } {
    const id = box.id;
    const workspace = box.workspace;
    let commandTimeout = 30_000;
    const execute = async (command: string, options: RunOptions = {}) => {
      validAgent(options.user);
      if (!command || typeof command !== 'string') throw new CellboxError('INVALID_REQUEST', 'Command is required');
      if (Buffer.byteLength(command) > 8192) throw new CellboxError('INVALID_REQUEST', 'Cellbox shell command exceeds the 8192-byte guest argument limit');
      const cwd = options.cwd === undefined ? undefined : workspacePath(options.cwd, workspace);
      if (options.cwd !== undefined && cwd === undefined) throw new CellboxError('INVALID_REQUEST', 'Command cwd must be inside Cellbox workspace');
      const timeoutMs = options.timeoutMs ?? commandTimeout;
      if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000)
        throw new CellboxError('INVALID_REQUEST', 'Command timeoutMs must be 1..300000');
      const current = await this.box(id);
      if (current.phase !== 'running' && current.phase !== 'staged') throw new CellboxError('CONFLICT', `Box ${id} is ${current.phase}`);
      if (options.signal?.aborted) throw new CellboxError('TRANSPORT', 'Command was cancelled before submission');
      const key = options.idempotencyKey ?? randomUUID();
      const op = await this.client.exec(id, { argv: ['/bin/sh', '-c', command], expectedGeneration: current.generation,
        ...(cwd !== undefined ? { cwd } : {}), ...(options.envs ? { env: options.envs } : {}), timeoutMs }, key, options.signal);
      const finish = async (): Promise<SandboxCommandResult> => {
        let final: CellboxOperation | undefined;
        let waitError: unknown;
        try { final = await this.wait(op, Math.min(this.maxWaitMs, timeoutMs + 30_000), options.signal); }
        catch (error) { waitError = error; }
        if (options.signal?.aborted) throw new CellboxError('UNKNOWN_OUTCOME', `Cellbox execution operation ${op.id} may still be running`, undefined, key, { cause: waitError });
        const execId = final?.result?.execId ?? op.result?.execId;
        if (!execId) throw new CellboxError(waitError ? 'UNKNOWN_OUTCOME' : 'PROTOCOL',
          `Cellbox exec operation ${op.id} has no inspectable execId`, undefined, key, { cause: waitError });
        let execution;
        try { execution = await this.client.getExec(execId); }
        catch (cause) { throw new CellboxError('UNKNOWN_OUTCOME', `Cellbox execution ${execId} could not be inspected`, undefined, key, { cause }); }
        if (execution.state === 'unknown') throw new CellboxError('UNKNOWN_OUTCOME', `Cellbox execution ${execId} has an unknown outcome`, undefined, key);
        if (execution.state !== 'exited' || !execution.result) throw new CellboxError('UNKNOWN_OUTCOME', `Cellbox execution ${execId} is not known to have exited`, undefined, key, { cause: waitError });
        const result = execution.result;
        if (result.exitCode === 124 && result.truncated)
          throw Object.assign(new CellboxError('TIMEOUT', `Cellbox execution ${execId} exceeded its time limit`), result);
        if (result.truncated)
          throw Object.assign(new CellboxError('OUTPUT_TRUNCATED', `Cellbox execution ${execId} output was truncated`), result);
        if (result.stdout) options.onStdout?.(result.stdout);
        if (result.stderr) options.onStderr?.(result.stderr);
        if (result.exitCode) throw Object.assign(new Error(result.stderr || `exit ${result.exitCode}`), result);
        return result;
      };
      if (options.background) return { wait: finish, kill: async () => false,
        // Disconnect only drops this local handle. The bounded remote exec continues.
        disconnect: async () => {} } satisfies SandboxCommandHandle;
      return finish();
    };
    const shell = async (script: string, options: RunOptions = {}) => execute(script, options) as Promise<SandboxCommandResult>;
    const absolutePath = (path: string) => {
      const normalized = requirePath(path);
      return posix.isAbsolute(normalized) ? normalized : posix.join(workspace, normalized);
    };
    const fileBytes = async (path: string, signal?: AbortSignal) => {
      const relative = workspacePath(path, workspace);
      if (relative !== undefined) return this.client.readFile(id, relative, signal);
      const absolute = absolutePath(path);
      const result = await shell(`base64 -w0 -- ${q(absolute)}`, { signal });
      return Buffer.from(result.stdout, 'base64');
    };
    return { sandboxId: id, getHost: () => new URL(this.client.origin).hostname,
      getServiceUrl: async port => (await this.serviceRoute(id, port)).url,
      getServiceAccess: port => this.getServiceAccess(id, port),
      setTimeout: async timeoutMs => { if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new CellboxError('INVALID_REQUEST', 'Timeout must be positive'); commandTimeout = Math.min(timeoutMs, 300_000); },
      commands: { run: execute as SandboxHandle['commands']['run'] },
      files: {
        readResponse: async (path, options = {}) => {
          validAgent(options.user);
          const relative = workspacePath(path, workspace);
          if (relative === undefined) throw new CellboxError('FORBIDDEN', 'File must be within the workspace', 403);
          return this.client.fileResponse(id, relative, options);
        },
        readBytes: async (path, options = {}) => {
          validAgent(options.user);
          const relative = workspacePath(path, workspace);
          if (relative === undefined) throw new CellboxError('FORBIDDEN', 'File must be within the workspace', 403);
          return this.client.readFile(id, relative, options.signal);
        },
        read: async (path, options = {}) => { validAgent(options.user); return Buffer.from(await fileBytes(path, options.signal)).toString(); },
        write: async (path, value, options = {}) => {
          validAgent(options.user);
          const bytes = asBytes(value);
          const relative = workspacePath(path, workspace);
          if (relative !== undefined) {
            if (relative === '.') throw new CellboxError('INVALID_REQUEST', 'A workspace root is not a file path');
            await this.client.writeFile(id, relative, bytes, options.signal); return;
          }
          const absolute = absolutePath(path);
          if (bytes.byteLength > 256 * 1024)
            throw new CellboxError('UNSUPPORTED_CAPABILITY', 'Files outside Cellbox workspace exceed the safe bounded exec transfer size');
          const directory = posix.dirname(absolute);
          const temp = posix.join(directory, `.${posix.basename(absolute)}.cocell-${randomUUID()}.tmp`);
          try {
            await shell(`mkdir -p -- ${q(directory)} && (umask 077; : > ${q(temp)})`, { signal: options.signal });
            const input = Buffer.from(bytes);
            for (let offset = 0; offset < input.length; offset += 4096) {
              const chunk = input.subarray(offset, offset + 4096).toString('base64');
              await shell(`printf %s "$COCELL_FILE_CHUNK" | base64 -d >> ${q(temp)}`,
                { signal: options.signal, envs: { COCELL_FILE_CHUNK: chunk } });
            }
            await shell(`chmod 600 -- ${q(temp)} && mv -f -- ${q(temp)} ${q(absolute)}`, { signal: options.signal });
          } catch (error) {
            // A request with unknown outcome may still be writing this temp path.
            if (!(error instanceof CellboxError && error.code === 'UNKNOWN_OUTCOME'))
              await shell(`rm -f -- ${q(temp)}`).catch(() => {});
            throw error;
          }
        },
        exists: async (path, options = {}) => {
          validAgent(options.user);
          try { await shell(`test -e ${q(absolutePath(path))}`); return true; }
          catch (error) { if (error instanceof Error && 'exitCode' in error && error.exitCode === 1) return false; throw error; }
        },
        remove: async (path, options = {}) => { validAgent(options.user); await shell(`rm -rf -- ${q(absolutePath(path))}`, { signal: options.signal }); },
        rename: async (from, to, options = {}) => { validAgent(options.user); await shell(`mv -- ${q(absolutePath(from))} ${q(absolutePath(to))}`, { signal: options.signal }); },
      } };
  }
}
