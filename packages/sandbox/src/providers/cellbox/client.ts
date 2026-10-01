/** The public Cellbox REST contract. Tokens and grants must stay on the server. */
export interface CellboxCapabilities {
  exec: boolean; files: boolean; http: boolean; websocket: boolean;
  pty: boolean; reconnectExec: boolean; freeze: boolean;
  suspend: 'none' | 'same-node-checkpoint'; archives: string; protectedTools: boolean;
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
export type CellboxPhase = 'creating' | 'running' | 'freezing' | 'frozen' | 'unfreezing'
  | 'checkpointing' | 'suspending' | 'suspended' | 'resuming' | 'restoring' | 'staged' | 'deleting' | 'deleted' | 'failed';
export interface CellboxBox {
  id: string; ownerKey: string; profileId: string; phase: CellboxPhase; generation: number;
  resourceVersion: number; importedImageId?: string; image: string; imageId?: string; workspace: string;
  capabilities: CellboxCapabilities; operationId?: string; createdAt: string;
  error?: { code: string; message: string };
}
export interface CellboxImportedImage {
  id: string; source: string; resolvedSource: string; image: string; platform: string;
  command: string[]; env: Record<string, string>; workingDir: string;
  buildCommand?: string; ports: number[]; warnings: string[]; key: string; createdAt: string;
  deleting?: boolean;
}
export interface CellboxImportImageInput {
  url: string; buildCommand?: string; runCommand?: string; platform?: 'linux/amd64';
  registryAuth?: { username: string; password: string };
}
export interface CellboxOperation {
  id: string; kind: string; targetId: string; status: 'queued' | 'running' | 'succeeded' | 'failed';
  version: number; createdAt: string; finishedAt?: string;
  result?: Record<string, string>; error?: { code: string; message: string };
}
export interface CellboxExecution {
  id: string; boxId: string; operationId: string; state: 'running' | 'exited' | 'unknown';
  result?: { stdout: string; stderr: string; exitCode: number; truncated?: boolean };
}
export interface CellboxRoute { id: string; boxId: string; port: number; url: string }
export interface CellboxGrant { id: string; routeId: string; subject: string; expiresAt: string; revoked: boolean }
export interface CellboxArchive {
  id: string; sourceBoxId: string; profileId: string; imageId: string;
  agent: { uid: number; gid: number }; sha256: string; size: number;
  consistency: string; createdAt: string;
  portable?: boolean;
}
export interface CellboxLease { id: string; boxId: string; purpose: string; expiresAt: string }
export interface CellboxAccessRequest {
  id: string; routeId: string; boxId: string; callbackUrl: string;
  expiresAt: string; approved: boolean; consumed: boolean;
}

export type CellboxErrorCode =
  | 'INVALID_REQUEST' | 'UNAUTHENTICATED' | 'FORBIDDEN' | 'NOT_FOUND' | 'CONFLICT' | 'BUSY'
  | 'STALE_GENERATION' | 'UNSUPPORTED_CAPABILITY' | 'TIMEOUT' | 'ARCHIVE_INCOMPATIBLE'
  | 'UNKNOWN_OUTCOME' | 'TRANSPORT' | 'PROTOCOL' | string;

export class CellboxError extends Error {
  constructor(public readonly code: CellboxErrorCode, message: string, public readonly status?: number,
    public readonly idempotencyKey?: string, options?: ErrorOptions) {
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

export interface CellboxClientOptions { baseUrl: string; token: string; fetch?: typeof fetch; requestTimeoutMs?: number }

/** No mutation is retried automatically. A transport failure after submission has an unknown outcome. */
export class CellboxClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly requestTimeoutMs: number;
  constructor(options: CellboxClientOptions) {
    const url = new URL(options.baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
      throw new CellboxError('INVALID_REQUEST', 'Cellbox baseUrl must be an HTTP(S) origin or path without credentials');
    if (!options.token) throw new CellboxError('INVALID_REQUEST', 'Cellbox client token is required');
    this.baseUrl = url.toString().replace(/\/$/, '');
    this.token = options.token;
    this.fetchImpl = options.fetch ?? fetch;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    if (!Number.isInteger(this.requestTimeoutMs) || this.requestTimeoutMs < 1)
      throw new CellboxError('INVALID_REQUEST', 'requestTimeoutMs must be a positive integer');
  }
  get origin() { return new URL(this.baseUrl).origin; }
  /** Server-side access uses the configured API gateway, independent of public route DNS. */
  serviceUrl(routeId: string) { return `${this.baseUrl}/s/${this.id(routeId)}/`; }
  private async request<T>(method: string, path: string, options: {
    body?: unknown; bytes?: Uint8Array; key?: string; signal?: AbortSignal; response?: 'json' | 'bytes' | 'empty'; maxBytes?: number; timeoutMs?: number;
  } = {}): Promise<T> {
    if (options.signal?.aborted) throw new CellboxError('TRANSPORT', 'Cellbox request was cancelled before submission');
    const headers = new Headers({ Authorization: `Bearer ${this.token}` });
    if (options.key !== undefined) {
      if (!options.key || options.key.length > 200) throw new CellboxError('INVALID_REQUEST', 'Idempotency key must contain 1..200 characters');
      headers.set('Idempotency-Key', options.key);
    }
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
        mutation ? options.key
          ? 'Cellbox mutation outcome is unknown; retry with the same idempotency key or inspect its operation'
          : 'Cellbox mutation outcome is unknown; inspect server state before retry'
          : 'Cellbox request failed',
        undefined, options.key, { cause });
    }
    if (!response.ok) {
      let error: { code?: string; message?: string } | undefined;
      try { error = (JSON.parse(Buffer.from(await this.readBounded(response, 1024 * 1024)).toString()) as { error?: { code?: string; message?: string } }).error; }
      catch { /* Preserve HTTP status. */ }
      throw new CellboxError(error?.code ?? statusCode(response.status), error?.message ?? `Cellbox HTTP ${response.status}`, response.status, options.key);
    }
    if (options.response === 'empty') return undefined as T;
    let bytes: Uint8Array;
    try { bytes = await this.readBounded(response, options.maxBytes ?? (options.response === 'bytes' ? 16 * 1024 * 1024 : 8 * 1024 * 1024)); }
    catch (cause) {
      if (cause instanceof CellboxError) throw cause;
      throw new CellboxError(method === 'GET' ? 'TRANSPORT' : 'UNKNOWN_OUTCOME',
        method === 'GET' ? 'Cellbox response could not be read' : 'Cellbox mutation response was interrupted; inspect its operation before retry',
        response.status, options.key, { cause });
    }
    if (options.response === 'bytes') return bytes as T;
    try { return JSON.parse(Buffer.from(bytes).toString()) as T; }
    catch (cause) { throw new CellboxError(method === 'GET' ? 'PROTOCOL' : 'UNKNOWN_OUTCOME',
      method === 'GET' ? 'Cellbox returned invalid JSON' : 'Cellbox mutation response was invalid; inspect its operation before retry',
      response.status, options.key, { cause }); }
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
  importImage(input: CellboxImportImageInput, key: string) {
    return this.request<CellboxOperation>('POST', '/v1/images:import', { body: input, key });
  }
  listImages() { return this.request<CellboxImportedImage[]>('GET', '/v1/images'); }
  getImage(id: string) { return this.request<CellboxImportedImage>('GET', `/v1/images/${this.id(id)}`); }
  imageUsage(id: string) { return this.request<{ deletable: boolean; blockers: string[]; manifestShared: boolean }>('GET', `/v1/images/${this.id(id)}/usage`); }
  deleteImage(id: string, key: string) { return this.request<CellboxOperation>('DELETE', `/v1/images/${this.id(id)}`, { key }); }
  listProfiles(signal?: AbortSignal) { return this.request<CellboxProfile[]>('GET', '/v1/profiles', { signal }); }
  listBoxes(signal?: AbortSignal) { return this.request<CellboxBox[]>('GET', '/v1/boxes', { signal }); }
  listCheckpoints(signal?: AbortSignal) { return this.request<CellboxBox[]>('GET', '/v1/checkpoints', { signal }); }
  getBox(id: string, signal?: AbortSignal) { return this.request<CellboxBox>('GET', `/v1/boxes/${this.id(id)}`, { signal }); }
  createBox(input: { profileId: string; ownerKey: string; importedImageId?: string }, key: string) {
    return this.request<CellboxOperation>('POST', '/v1/boxes', { body: input, key });
  }
  restoreBox(input: { profileId: string; ownerKey: string; archiveId: string; importedImageId?: string; acceptImageChange?: boolean }, key: string) {
    return this.request<CellboxOperation>('POST', '/v1/boxes:restore', { body: input, key });
  }
  actBox(id: string, action: 'suspend' | 'resume' | 'destroy' | 'activate' | 'reconcile', key: string) {
    return this.request<CellboxOperation>('POST', `/v1/boxes/${this.id(id)}:${action}`, { key });
  }
  exec(id: string, input: { argv: string[]; expectedGeneration: number; cwd?: string; env?: Record<string, string>; timeoutMs?: number }, key: string, signal?: AbortSignal) {
    return this.request<CellboxOperation>('POST', `/v1/boxes/${this.id(id)}/execs`, { body: input, key, signal });
  }
  getOperation(id: string, signal?: AbortSignal) { return this.request<CellboxOperation>('GET', `/v1/operations/${this.id(id)}`, { signal }); }
  getExec(id: string, signal?: AbortSignal) { return this.request<CellboxExecution>('GET', `/v1/execs/${this.id(id)}`, { signal }); }
  async fileResponse(id: string, path: string, options: { method?: 'GET' | 'HEAD'; headers?: Headers; signal?: AbortSignal } = {}): Promise<Response> {
    const headers = new Headers({ Authorization: `Bearer ${this.token}`, 'Accept-Encoding': 'identity' });
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
    } catch (cause) { throw new CellboxError('TRANSPORT', 'Cellbox file request failed', undefined, undefined, { cause }); }
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
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(slot) || bytes.byteLength < 1 || bytes.byteLength > 65_536)
      throw new CellboxError('INVALID_REQUEST', 'Credential slot and 1..65536 bytes are required');
    return this.request<void>('PUT', `/v1/boxes/${this.id(boxId)}/credentials/${this.id(slot)}`,
      { bytes, signal, response: 'empty' });
  }
  runTool(boxId: string, tool: string, args: string[] = [], timeoutMs = 30_000) {
    return this.request<{ stdout: string; stderr: string; exitCode: number; truncated?: boolean }>('POST',
      `/v1/boxes/${this.id(boxId)}/tools/${this.id(tool)}`, { body: { args, timeoutMs }, timeoutMs: timeoutMs + 30_000 });
  }
  createRoute(boxId: string, port: number) { return this.request<CellboxRoute>('POST', '/v1/routes', { body: { boxId, port } }); }
  createGrant(routeId: string, subject: string, ttlSeconds = 900) {
    return this.request<{ grant: CellboxGrant; token: string }>('POST', `/v1/routes/${this.id(routeId)}/grants`, { body: { subject, ttlSeconds } });
  }
  renewGrant(id: string, ttlSeconds = 900) {
    return this.request<CellboxGrant>('PATCH', `/v1/grants/${this.id(id)}`, { body: { ttlSeconds } });
  }
  revokeGrant(id: string) { return this.request<void>('DELETE', `/v1/grants/${this.id(id)}`, { response: 'empty' }); }
  getAccessRequest(id: string) { return this.request<CellboxAccessRequest>('GET', `/v1/access-requests/${this.id(id)}`); }
  approveAccessRequest(id: string, subject: string, ttlSeconds = 900) {
    return this.request<{ redirectUrl: string }>('POST', `/v1/access-requests/${this.id(id)}:approve`, { body: { subject, ttlSeconds } });
  }
  createLease(boxId: string, purpose: string, ttlSeconds = 60) {
    return this.request<CellboxLease>('POST', `/v1/boxes/${this.id(boxId)}/leases`, { body: { purpose, ttlSeconds } });
  }
  renewLease(id: string, purpose: string, ttlSeconds = 60) {
    return this.request<CellboxLease>('PATCH', `/v1/leases/${this.id(id)}`, { body: { purpose, ttlSeconds } });
  }
  releaseLease(id: string) { return this.request<void>('DELETE', `/v1/leases/${this.id(id)}`, { response: 'empty' }); }
  captureArchive(boxId: string, key: string) {
    return this.request<CellboxOperation>('POST', `/v1/boxes/${this.id(boxId)}/archives`, { key });
  }
  listArchives() { return this.request<CellboxArchive[]>('GET', '/v1/archives'); }
  getArchive(id: string) { return this.request<CellboxArchive>('GET', `/v1/archives/${this.id(id)}`); }
  downloadArchive(id: string, maxBytes = 256 * 1024 * 1024) {
    return this.request<Uint8Array>('GET', `/v1/archives/${this.id(id)}/content`, { response: 'bytes', maxBytes });
  }
  deleteArchive(id: string) { return this.request<void>('DELETE', `/v1/archives/${this.id(id)}`, { response: 'empty' }); }
}
