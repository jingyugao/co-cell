import { injectTraceHeaders, traced } from '../../tracing.js';
import { SpanKind } from '@opentelemetry/api';

const cellboxVolumeIdPattern = /^[a-z0-9]([-a-z0-9]{0,53}[a-z0-9])?$/;
const cellboxBackupIdPattern = /^[0-9a-f]{64}$/;
/** The internal Cellbox REST contract. Calls require no Cellbox credential. */
export interface CellboxCapabilities {
  exec: boolean; files: boolean; http: boolean; websocket: boolean;
  pty: boolean; reconnectExec: boolean; freeze: boolean;
  suspend: 'none' | 'same-node-checkpoint'; archives: string; protectedTools: boolean;
  sharedDirectory?: boolean;
  persistentHome?: boolean;
  mountedDebugHome?: boolean;
  rootDebug?: boolean;
  credentialBatch?: boolean;
  internalServices?: boolean;
  /** Stop execution and archive persistent files without a process checkpoint. */
  diskArchives?: boolean;
}
/** Conceptual product matrix; Cellbox currently implements only two combinations. */
export type CellboxRuntimeKind = 'docker-normal' | 'docker-resumable' | 'k8s-normal' | 'k8s-resumable';
export type CellboxImplementedKind = Extract<CellboxRuntimeKind, 'docker-normal' | 'k8s-resumable'>;
export interface CellboxProfile {
  id: string; provider: 'docker' | 'resumable-k8s-pod'; capabilities: CellboxCapabilities;
  runtime: 'docker' | 'k8s'; behavior: 'normal' | 'resumable'; kind: CellboxImplementedKind;
  image: string; workspace: string; agent: { uid: number; gid: number };
  cpu: number; memoryMiB: number;
}
export interface CellboxTemplate {
  id: string; name: string; description?: string; defaultWarmSlots: number;
  stableRevisionId?: string; generation: number; createdAt: string; updatedAt: string;
}
export interface CellboxTemplateRevision {
  id: string; templateId: string; templateName: string; description?: string; userVersion: string;
  revision: number; version: string; profileId: string; baseImage: string; resolvedBaseImage: string;
  image: string; buildCommand?: string; runCommand?: string; platform: string; cpu: number;
  memoryMiB: number; warmSlots: number; status: 'active' | 'retired'; generation: number;
  buildOperationId: string; createdAt: string; updatedAt: string;
}
export interface CellboxBuildRequest {
  userVersion: string; baseImage: string; profileId: string; buildCommand?: string;
  runCommand?: string; platform?: string; warmSlots?: number;
}
export type CellboxPhase = 'creating' | 'running' | 'checkpointing' | 'suspending' | 'suspended'
  | 'resuming' | 'restoring' | 'staged' | 'deleting' | 'deleted' | 'failed';
export interface CellboxMount { volumeId: string; mountPath: string; readOnly?: boolean }
export interface CellboxVolume {
  id: string; ownerKey: string; profileId: string; nodeName: string; phase: string;
  resourceVersion: number; createdAt: string; operationId?: string; error?: { code: string; message: string };
}
export interface CellboxBackupPolicy {
  engine: 'restic'; scope: 'volume'; keepLast: number; enabled: boolean;
}
export interface CellboxVolumeBackup {
  id: string; createdAt: string; volumeId: string; ownerKey: string; profileId: string;
  sizeBytes?: number; addedBytes?: number;
}
export interface CellboxBox {
  mounts?: CellboxMount[];
  homeVolumeId?: string;
  id: string; ownerKey: string; profileId: string; templateId: string; revisionId: string;
  templateName: string; templateVersion: string; phase: CellboxPhase; generation: number;
  resourceVersion: number; image: string; imageId?: string; workspace: string;
  capabilities: CellboxCapabilities; operationId?: string; executionId?: string; observedAt?: string; createdAt: string;
  error?: { code: string; message: string };
}
export interface CellboxOperation {
  box?: CellboxBox;
  id: string; kind: string; targetId: string; status: 'queued' | 'running' | 'succeeded' | 'failed';
  stage?: string; input?: CellboxBuildRequest; version: number; createdAt: string; startedAt?: string;
  updatedAt?: string; finishedAt?: string;
  result?: Record<string, string>; error?: { code: string; message: string };
}
export interface CellboxExecution {
  id: string; boxId: string; operationId: string; state: 'running' | 'exited' | 'unknown';
  result?: { stdout: string; stderr: string; exitCode: number; truncated?: boolean };
}
export interface CellboxArchive {
  id: string; sourceBoxId: string; profileId: string; imageId: string; templateId: string;
  revisionId: string; templateName: string; templateVersion: string; manifestVersion?: number;
  agent: { uid: number; gid: number }; sha256: string; size: number;
  consistency: string; createdAt: string;
  portable?: boolean;
}
export type CellboxErrorCode =
  | 'INVALID_REQUEST' | 'UNAUTHENTICATED' | 'FORBIDDEN' | 'NOT_FOUND' | 'CONFLICT' | 'BUSY'
  | 'STALE_GENERATION' | 'UNSUPPORTED_CAPABILITY' | 'TIMEOUT' | 'ARCHIVE_INCOMPATIBLE'
  | 'UNKNOWN_OUTCOME' | 'TRANSPORT' | 'PROTOCOL' | string;

export class CellboxError extends Error {
  constructor(public readonly code: CellboxErrorCode, message: string, public readonly status?: number,
    options?: ErrorOptions) {
    super(message, options);
    this.name = 'CellboxError';
  }
}

function statusCode(status: number): CellboxErrorCode {
  switch (status) {
    case 400: return 'INVALID_REQUEST';
    case 401: return 'UNAUTHENTICATED';
    case 403: return 'FORBIDDEN';
    case 404: return 'NOT_FOUND';
    case 409: return 'CONFLICT';
    case 422: return 'UNSUPPORTED_CAPABILITY';
    case 504: return 'TIMEOUT';
    default: return 'PROTOCOL';
  }
}

export interface CellboxClientOptions {
  baseUrl: string;
  /** Tenant namespace; defaults to the API's configured clientId. */
  clientId?: string;
  fetch?: typeof fetch;
  requestTimeoutMs?: number;
}

/** No mutation is retried automatically. A transport failure after submission has an unknown outcome. */
export class CellboxClient {
  private readonly baseUrl: string;
  private readonly clientId?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly requestTimeoutMs: number;
  constructor(options: CellboxClientOptions) {
    const url = new URL(options.baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
      throw new CellboxError('INVALID_REQUEST', 'Cellbox baseUrl must be an HTTP(S) origin or path without credentials');
    this.baseUrl = url.toString().replace(/\/$/, '');
    this.clientId = options.clientId;
    if (this.clientId !== undefined && !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(this.clientId))
      throw new CellboxError('INVALID_REQUEST', 'Invalid Cellbox client namespace');
    this.fetchImpl = options.fetch ?? fetch;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    if (!Number.isInteger(this.requestTimeoutMs) || this.requestTimeoutMs < 1)
      throw new CellboxError('INVALID_REQUEST', 'requestTimeoutMs must be a positive integer');
  }
  get origin() { return new URL(this.baseUrl).origin; }
  private clientHeaders(): Record<string, string> {
    return this.clientId ? { 'X-Cellbox-Client-ID': this.clientId } : {};
  }
  /** Direct access needs no route registration, grant, or token. */
  internalService(boxId: string, port: number) {
    if (!Number.isInteger(port) || port < 1 || port > 65535 || port === 40000)
      throw new CellboxError('INVALID_REQUEST', 'Invalid internal service port');
    return { url: `${this.baseUrl}/v1/boxes/${this.id(boxId)}/services/${port}/`, headers: this.clientHeaders() };
  }
  private request<T>(method: string, path: string, options: {
    body?: unknown; bytes?: Uint8Array; signal?: AbortSignal; response?: 'json' | 'bytes' | 'empty'; maxBytes?: number; timeoutMs?: number;
  } = {}): Promise<T> {
    // GETs and metadata mutations keep trace context flowing through them, while
    // retaining spans for the box lifecycle and exec operations.
    const endpoint = path.split('?')[0];
    const coreMutation = method === 'POST' && (endpoint === '/v1/boxes' || endpoint === '/v1/boxes:restore'
      || endpoint === '/v1/volumes' || endpoint === '/v1/volumes:restore'
      || /^\/v1\/boxes\/[^/]+:(?:suspend|resume|destroy|activate)$/.test(endpoint)
      || /^\/v1\/boxes\/[^/]+\/execs$/.test(endpoint)
      || /^\/v1\/volumes\/[^/]+\/backups$/.test(endpoint))
      || method === 'DELETE' && /^\/v1\/volumes\/[^/]+$/.test(endpoint);
    if (!coreMutation) return this.requestImpl<T>(method, path, options);
    return traced('cellbox.http.client', { 'http.request.method': method, 'url.path': path.split('?')[0],
      'http.request.timeout_ms': options.timeoutMs ?? this.requestTimeoutMs },
    () => this.requestImpl<T>(method, path, options), SpanKind.CLIENT);
  }
  private async requestImpl<T>(method: string, path: string, options: {
    body?: unknown; bytes?: Uint8Array; signal?: AbortSignal; response?: 'json' | 'bytes' | 'empty'; maxBytes?: number; timeoutMs?: number;
  }): Promise<T> {
    if (options.signal?.aborted) throw new CellboxError('TRANSPORT', 'Cellbox request was cancelled before submission');
    const outgoing = this.clientHeaders();
    injectTraceHeaders(outgoing);
    const headers = new Headers(outgoing);
    let body: BodyInit | undefined;
    if (options.bytes) { headers.set('Content-Type', 'application/octet-stream'); body = new Uint8Array(options.bytes); }
    else if (options.body !== undefined) { headers.set('Content-Type', 'application/json'); body = JSON.stringify(options.body); }
    let response: Response;
    const timeout = AbortSignal.timeout(options.timeoutMs ?? this.requestTimeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, { method, headers, body, signal, redirect: 'error' });
    } catch (cause) {
      const mutation = method !== 'GET';
      throw new CellboxError(mutation ? 'UNKNOWN_OUTCOME' : 'TRANSPORT',
        mutation ? 'Cellbox mutation outcome is unknown; inspect server state before deciding what to do'
          : 'Cellbox request failed', undefined, { cause });
    }
    if (!response.ok) {
      let error: { code?: string; message?: string } | undefined;
      try { error = (JSON.parse(Buffer.from(await this.readBounded(response, 1024 * 1024)).toString()) as { error?: { code?: string; message?: string } }).error; }
      catch { /* Preserve HTTP status. */ }
      throw new CellboxError(error?.code ?? statusCode(response.status), error?.message ?? `Cellbox HTTP ${response.status}`, response.status);
    }
    if (options.response === 'empty') return undefined as T;
    let bytes: Uint8Array;
    try { bytes = await this.readBounded(response, options.maxBytes ?? (options.response === 'bytes' ? 16 * 1024 * 1024 : 8 * 1024 * 1024)); }
    catch (cause) {
      if (cause instanceof CellboxError && method === 'GET') throw cause;
      throw new CellboxError(method === 'GET' ? 'TRANSPORT' : 'UNKNOWN_OUTCOME',
        method === 'GET' ? 'Cellbox response could not be read' : 'Cellbox mutation response was interrupted; inspect server state before deciding what to do',
        response.status, { cause });
    }
    if (options.response === 'bytes') return bytes as T;
    try { return JSON.parse(Buffer.from(bytes).toString()) as T; }
    catch (cause) { throw new CellboxError(method === 'GET' ? 'PROTOCOL' : 'UNKNOWN_OUTCOME',
      method === 'GET' ? 'Cellbox returned invalid JSON' : 'Cellbox mutation response was invalid; inspect server state before deciding what to do',
      response.status, { cause }); }
  }
  private async readBounded(response: Response, maxBytes: number): Promise<Uint8Array> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new CellboxError('INVALID_REQUEST', 'Response byte limit must be a nonnegative safe integer');
    const declared = response.headers.get('Content-Length');
    if (declared && Number(declared) > maxBytes) {
      await response.body?.cancel();
      throw new CellboxError('INVALID_REQUEST', `Cellbox response exceeds ${maxBytes} bytes`);
    }
    if (!response.body) return new Uint8Array();
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) {
          await reader.cancel();
          throw new CellboxError('INVALID_REQUEST', `Cellbox response exceeds ${maxBytes} bytes`);
        }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const result = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
    return result;
  }
  private id(id: string) { return encodeURIComponent(id); }
  listTemplates(signal?: AbortSignal) { return this.request<CellboxTemplate[]>('GET', '/v1/templates', { signal }); }
  getTemplate(id: string, signal?: AbortSignal) { return this.request<CellboxTemplate>('GET', `/v1/templates/${this.id(id)}`, { signal }); }
  createTemplate(input: { name: string; description?: string; defaultWarmSlots?: number }) {
    return this.request<CellboxTemplate>('POST', '/v1/templates', { body: input });
  }
  updateTemplate(id: string, input: { expectedGeneration: number; description?: string; defaultWarmSlots?: number; stableRevisionId?: string }) {
    return this.request<CellboxTemplate>('PATCH', `/v1/templates/${this.id(id)}`, { body: input });
  }
  listTemplateRevisions(templateId: string, userVersion?: string, signal?: AbortSignal) {
    const query = userVersion === undefined ? '' : `?userVersion=${encodeURIComponent(userVersion)}`;
    return this.request<CellboxTemplateRevision[]>('GET', `/v1/templates/${this.id(templateId)}/revisions${query}`, { signal });
  }
  createTemplateRevision(templateId: string, input: CellboxBuildRequest) {
    return this.request<CellboxOperation>('POST', `/v1/templates/${this.id(templateId)}/revisions`, { body: input });
  }
  getTemplateRevision(id: string, signal?: AbortSignal) {
    return this.request<CellboxTemplateRevision>('GET', `/v1/template-revisions/${this.id(id)}`, { signal });
  }
  updateTemplateRevision(id: string, input: { expectedGeneration: number; description?: string; status?: 'active' | 'retired'; warmSlots?: number }) {
    return this.request<CellboxTemplateRevision>('PATCH', `/v1/template-revisions/${this.id(id)}`, { body: input });
  }
  listProfiles(signal?: AbortSignal) { return this.request<CellboxProfile[]>('GET', '/v1/profiles', { signal }); }
  listBoxes(signal?: AbortSignal) { return this.request<CellboxBox[]>('GET', '/v1/boxes', { signal }); }
  listResourceBoxes(signal?: AbortSignal) { return this.request<CellboxBox[]>('GET', '/v1/boxes?observation=resource', { signal }); }
  listCheckpoints(signal?: AbortSignal) { return this.request<CellboxBox[]>('GET', '/v1/checkpoints', { signal }); }
  getBox(id: string, signal?: AbortSignal) { return this.request<CellboxBox>('GET', `/v1/boxes/${this.id(id)}`, { signal }); }
  listVolumes(signal?: AbortSignal) { return this.request<CellboxVolume[]>('GET', '/v1/volumes', { signal }); }
  getVolume(id: string, signal?: AbortSignal) { return this.request<CellboxVolume>('GET', `/v1/volumes/${this.id(id)}`, { signal }); }
  getBackupPolicy(signal?: AbortSignal) { return this.request<CellboxBackupPolicy>('GET', '/v1/backup-policy', { signal }); }
  createVolume(input: { id?: string; ownerKey: string; profileId: string }) {
    return this.request<CellboxOperation>('POST', '/v1/volumes', { body: input });
  }
  deleteVolume(id: string) { return this.request<CellboxOperation>('DELETE', `/v1/volumes/${this.id(id)}`); }
  createVolumeBackup(volumeId: string) {
    if (!cellboxVolumeIdPattern.test(volumeId))
      throw new CellboxError('INVALID_REQUEST', 'Invalid Cellbox volume ID');
    return this.request<CellboxOperation>('POST', `/v1/volumes/${this.id(volumeId)}/backups`, { body: {} });
  }
  listVolumeBackups(volumeId: string, signal?: AbortSignal) {
    if (!cellboxVolumeIdPattern.test(volumeId))
      throw new CellboxError('INVALID_REQUEST', 'Invalid Cellbox volume ID');
    return this.request<CellboxVolumeBackup[]>('GET', `/v1/volumes/${this.id(volumeId)}/backups`, { signal });
  }
  getVolumeBackup(volumeId: string, backupId: string, signal?: AbortSignal) {
    if (!cellboxVolumeIdPattern.test(volumeId))
      throw new CellboxError('INVALID_REQUEST', 'Invalid Cellbox volume ID');
    if (!cellboxBackupIdPattern.test(backupId))
      throw new CellboxError('INVALID_REQUEST', 'A full 64-character backup ID is required');
    return this.request<CellboxVolumeBackup>('GET', `/v1/volumes/${this.id(volumeId)}/backups/${this.id(backupId)}`, { signal });
  }
  restoreVolume(input: { sourceVolumeId: string; backupId: string; ownerKey: string; id?: string }) {
    if (!cellboxVolumeIdPattern.test(input.sourceVolumeId) || !cellboxBackupIdPattern.test(input.backupId) ||
      typeof input.ownerKey !== 'string' || Buffer.byteLength(input.ownerKey, 'utf8') < 1 || Buffer.byteLength(input.ownerKey, 'utf8') > 256 ||
      (input.id !== undefined && !cellboxVolumeIdPattern.test(input.id)))
      throw new CellboxError('INVALID_REQUEST', 'Valid source volume ID, full backup ID, owner key, and optional target volume ID are required');
    return this.request<CellboxOperation>('POST', '/v1/volumes:restore', { body: input });
  }
  createBox(input: { id?: string; ownerKey: string; revisionId?: string; templateId?: string; staged?: boolean;
    homeVolumeId?: string; mounts?: CellboxMount[] }, _legacyKey?: string) {
    if (Boolean(input.revisionId) === Boolean(input.templateId)) throw new CellboxError('INVALID_REQUEST', 'Exactly one of revisionId or templateId is required');
    if (input.homeVolumeId && input.mounts?.length) throw new CellboxError('INVALID_REQUEST', 'Specify mounts or homeVolumeId, not both');
    return this.request<CellboxOperation>('POST', '/v1/boxes', { body: input });
  }
  restoreBox(input: { ownerKey: string; archiveId: string; revisionId?: string; templateId?: string; acceptImageChange?: boolean }, _legacyKey?: string) {
    if (Boolean(input.revisionId) === Boolean(input.templateId)) throw new CellboxError('INVALID_REQUEST', 'Exactly one of revisionId or templateId is required');
    return this.request<CellboxOperation>('POST', '/v1/boxes:restore', { body: input });
  }
  actBox(id: string, action: 'suspend' | 'resume' | 'destroy' | 'activate', _legacyKey?: string,
    options: { timeoutMs?: number; expectedGeneration?: number; signal?: AbortSignal } = {}) {
    if (options.expectedGeneration !== undefined && (!Number.isSafeInteger(options.expectedGeneration) || options.expectedGeneration < 1))
      throw new CellboxError('INVALID_REQUEST', 'expectedGeneration must be a positive safe integer');
    const body = options.expectedGeneration === undefined ? undefined : { expectedGeneration: options.expectedGeneration };
    return this.request<CellboxOperation>('POST', `/v1/boxes/${this.id(id)}:${action}`, { body, timeoutMs: options.timeoutMs, signal: options.signal });
  }

  /** Purge owned artifacts after destruction; old APIs must fail rather than silently skip cleanup. */
  purgeBoxArtifacts(id: string) {
    return this.request<void>('POST', `/v1/boxes/${this.id(id)}:purge`, { response: 'empty' });
  }
  exec(id: string, input: { argv: string[]; expectedGeneration: number; cwd?: string; env?: Record<string, string>; timeoutMs?: number }, signal?: AbortSignal) {
    return this.request<CellboxOperation>('POST', `/v1/boxes/${this.id(id)}/execs`, { body: input, signal });
  }
  getOperation(id: string, signal?: AbortSignal, waitMs = 0) {
    if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > 10_000) throw new CellboxError('INVALID_REQUEST', 'waitMs must be 0..10000');
    return this.request<CellboxOperation>('GET', `/v1/operations/${this.id(id)}${waitMs ? `?waitMs=${waitMs}` : ''}`, { signal });
  }
  getExec(id: string, signal?: AbortSignal) { return this.request<CellboxExecution>('GET', `/v1/execs/${this.id(id)}`, { signal }); }
  async fileResponse(id: string, path: string, options: { method?: 'GET' | 'HEAD'; headers?: Headers; signal?: AbortSignal } = {}): Promise<Response> {
    const headers = new Headers({ ...this.clientHeaders(), 'Accept-Encoding': 'identity' });
    for (const name of ['range', 'if-range', 'if-match', 'if-unmodified-since', 'if-none-match', 'if-modified-since']) {
      const value = options.headers?.get(name);
      if (value !== undefined && value !== null) headers.set(name, value);
    }
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), this.requestTimeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/v1/boxes/${this.id(id)}/files?path=${encodeURIComponent(path)}`, {
        method: options.method ?? 'GET', headers, redirect: 'error',
        signal: options.signal ? AbortSignal.any([options.signal, timeout.signal]) : timeout.signal,
      });
    } catch (cause) { throw new CellboxError('TRANSPORT', 'Cellbox file request failed', undefined, { cause }); }
    finally { clearTimeout(timer); }
    if (!response.ok && response.status !== 304 && response.status !== 416 && response.status !== 412) {
      let error: { code?: string; message?: string } | undefined;
      try { error = JSON.parse(Buffer.from(await this.readBounded(response, 1024 * 1024)).toString()).error; }
      catch { /* Preserve the HTTP status. */ }
      throw new CellboxError(error?.code ?? statusCode(response.status), error?.message ?? `Cellbox HTTP ${response.status}`, response.status);
    }
    return response;
  }

  readFile(id: string, path: string, signal?: AbortSignal) {
    return this.request<Uint8Array>('GET', `/v1/boxes/${this.id(id)}/files?path=${encodeURIComponent(path)}`, { signal, response: 'bytes' });
  }
  listFiles(id: string, path: string, signal?: AbortSignal) {
    return this.request<Array<{ name: string; directory: boolean; size: number }>>('GET',
      `/v1/boxes/${this.id(id)}/files?path=${encodeURIComponent(path)}&list=1`, { signal });
  }
  writeFile(id: string, path: string, bytes: Uint8Array, signal?: AbortSignal) {
    if (bytes.byteLength > 16 * 1024 * 1024)
      throw new CellboxError('INVALID_REQUEST', 'Cellbox files are limited to 16 MiB per transfer');
    return this.request<void>('PUT', `/v1/boxes/${this.id(id)}/files?path=${encodeURIComponent(path)}`, { bytes, signal, response: 'empty' });
  }
  writeCredential(boxId: string, slot: string, bytes: Uint8Array, signal?: AbortSignal) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(slot) || bytes.byteLength < 1 || bytes.byteLength > 1024 * 1024)
      throw new CellboxError('INVALID_REQUEST', 'Credential slot and 1..1048576 bytes are required');
    return this.request<void>('PUT', `/v1/boxes/${this.id(boxId)}/credentials/${this.id(slot)}`,
      { bytes, signal, response: 'empty' });
  }
  writeCredentials(boxId: string, expectedGeneration: number, slots: Record<string, Uint8Array>, signal?: AbortSignal) {
    const entries = Object.entries(slots);
    if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 1 || entries.length < 1 || entries.length > 32 ||
      entries.some(([slot, bytes]) => !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(slot) || bytes.byteLength < 1 || bytes.byteLength > 1024 * 1024) ||
      entries.reduce((size, [, bytes]) => size + bytes.byteLength, 0) > 2 * 1024 * 1024)
      throw new CellboxError('INVALID_REQUEST', 'Invalid credential batch');
    return this.request<void>('PUT', `/v1/boxes/${this.id(boxId)}/credentials`, {
      body: { expectedGeneration, slots: Object.fromEntries(entries.map(([slot, bytes]) => [slot, Buffer.from(bytes).toString('base64')])) },
      signal, response: 'empty',
    });
  }
  runTool(boxId: string, tool: string, args: string[] = [], timeoutMs = 30_000) {
    return this.request<{ stdout: string; stderr: string; exitCode: number; truncated?: boolean }>('POST',
      `/v1/boxes/${this.id(boxId)}/tools/${this.id(tool)}`, { body: { args, timeoutMs }, timeoutMs: timeoutMs + 30_000 });
  }
  captureArchive(boxId: string, _legacyKey?: string, options?: { diskOnly: boolean }) {
    if (options?.diskOnly) throw new CellboxError('UNSUPPORTED_CAPABILITY', 'Cellbox archives do not support diskOnly capture');
    return this.request<CellboxOperation>('POST', `/v1/boxes/${this.id(boxId)}/archives`);
  }
  listArchives() { return this.request<CellboxArchive[]>('GET', '/v1/archives'); }
  getArchive(id: string) { return this.request<CellboxArchive>('GET', `/v1/archives/${this.id(id)}`); }
  downloadArchive(id: string, maxBytes = 256 * 1024 * 1024) {
    return this.request<Uint8Array>('GET', `/v1/archives/${this.id(id)}/content`, { response: 'bytes', maxBytes });
  }
  deleteArchive(id: string) { return this.request<void>('DELETE', `/v1/archives/${this.id(id)}`, { response: 'empty' }); }
}
