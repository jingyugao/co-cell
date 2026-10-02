export interface SandboxCommandResult { stdout: string; stderr: string; exitCode: number }
export interface SandboxCommandHandle {
  pid?: number;
  wait(): Promise<SandboxCommandResult>;
  kill(): Promise<boolean>;
  disconnect(): Promise<void>;
}
export interface SandboxHandle {
  sandboxId: string;
  getHost(port: number): string;
  /** Provider-specific externally reachable URL for a service bound to sandbox localhost. */
  getServiceUrl?(port: number): Promise<string>;
  setTimeout(timeoutMs: number): Promise<void>;
  commands: {
    run(command: string, options: {
      user?: string; signal?: AbortSignal; timeoutMs?: number; background: true;
      cwd?: string; envs?: Record<string, string>;
      onStdout?: (value: string) => void; onStderr?: (value: string) => void;
    }): Promise<SandboxCommandHandle>;
    run(command: string, options?: {
      user?: string; signal?: AbortSignal; timeoutMs?: number; background?: boolean;
      cwd?: string; envs?: Record<string, string>;
      onStdout?: (value: string) => void; onStderr?: (value: string) => void;
    }): Promise<SandboxCommandResult>;
  };
  files: {
    /** Stream a workspace file with standard HTTP range and conditional semantics. */
    readResponse?(path: string, options?: { user?: string; signal?: AbortSignal; method?: 'GET' | 'HEAD'; headers?: Headers }): Promise<Response>;
    /** Native workspace file read; rejects paths outside the workspace. */
    readBytes(path: string, options?: { user?: string; signal?: AbortSignal }): Promise<Uint8Array>;
    read(path: string, options?: { user?: string; signal?: AbortSignal }): Promise<string>;
    write(path: string, value: Uint8Array | ArrayBuffer | string, options?: { user?: string; signal?: AbortSignal }): Promise<void>;
    exists(path: string, options?: { user?: string }): Promise<boolean>;
    remove(path: string, options?: { user?: string; signal?: AbortSignal }): Promise<void>;
    rename(from: string, to: string, options?: { user?: string; signal?: AbortSignal }): Promise<void>;
  };
}
export interface SandboxInfo {
  sandboxId: string; state: 'running' | 'paused' | 'unknown';
  startedAt: Date; endAt: Date; metadata?: Record<string, string>;
  templateIdentity?: {
    reference: string;
    id: string;
    repoDigests: string[];
    version?: string;
    createdAt?: string;
  };
}

export type SandboxStatus =
  | 'starting'
  | 'ready'
  | 'paused'
  | 'unavailable'
  | 'deleted';

export type SandboxOperation =
  | 'creating'
  | 'connecting'
  | 'resuming'
  | 'pausing'
  | 'deleting';

/** Persisted provider state. Application workspace and execution state stay outside this package. */
export interface SandboxRecord {
  id: string;
  status: SandboxStatus;
  template: string;
  templateIdentity?: SandboxInfo['templateIdentity'];
  lastActiveAt?: string;
  pausedAt?: string;
  operation?: SandboxOperation;
  error?: { code: string; message: string; at: string };
  version?: number;
  checkpoint?: SandboxCheckpoint;
}

export interface SandboxCheckpoint {
  id: string;
  createdAt: string;
}

export type PersistSandboxRecord = (record: SandboxRecord) => Promise<void>;

export interface SandboxLogger {
  write(event: { event: string; [key: string]: unknown }): void | Promise<void>;
}

export interface SandboxPolicy {
  timeoutMs: number;
  renewalIntervalMs: number;
  scanIntervalMs: number;
  autoCheckpointAfterMs: number;
}

export interface SandboxCheckpointProvider {
  checkpoint(sandboxId: string): Promise<SandboxCheckpoint>;
  restore(sandboxId: string, checkpointId: string): Promise<void>;
}

export interface SandboxProvider {
  create(template: string, options: {
    timeoutMs: number;
    lifecycle: { onTimeout: 'pause'; autoResume: false };
    metadata?: Record<string, string>;
  }): Promise<SandboxHandle>;
  connect(sandboxId: string, options: { timeoutMs: number }): Promise<SandboxHandle>;
  /** Connect to an already running/staged instance without resuming it. */
  connectForSetup?(sandboxId: string): Promise<SandboxHandle>;
  getInfo(sandboxId: string): Promise<SandboxInfo>;
  /** Display-only batch observation; missing IDs are omitted and state may be eventually consistent. */
  getInfos?(sandboxIds: string[]): Promise<SandboxInfo[]>;
  pause(sandboxId: string): Promise<boolean>;
  kill(sandboxId: string): Promise<boolean>;
}

export interface CheckpointableSandboxProvider extends SandboxProvider, SandboxCheckpointProvider {}

export interface SandboxManagerOptions {
  provider: SandboxProvider;
  logger?: SandboxLogger;
  policy?: Partial<SandboxPolicy>;
  lifecycle?: import('./lifecycle.js').SandboxLifecycle;
  /** Use lifecycle when sharing the same hook host with provider-specific workflows. */
  extensions?: readonly SandboxExtension[];
}

export type SandboxLifecycleAction = 'create' | 'connect' | 'resume' | 'pause' | 'checkpoint' | 'destroy' | 'restore' | 'activate' | 'reconcile';
export interface SandboxLifecycleContext {
  action: SandboxLifecycleAction;
  resourceKey: string;
  sandboxId?: string;
  sandbox?: SandboxHandle;
  record?: SandboxRecord;
  metadata?: Record<string, string>;
}
/** Hooks are awaited in registration order. A failed pre hook prevents the operation. */
export interface SandboxExtension {
  name: string;
  pre?(context: Readonly<SandboxLifecycleContext>): Promise<void>;
  /** Runs only after a successful operation, before the manager reports readiness. */
  post?(context: Readonly<SandboxLifecycleContext>): Promise<void>;
  /** Best-effort notification; it never replaces the original failure. */
  error?(context: Readonly<SandboxLifecycleContext>, error: unknown): Promise<void>;
}

export interface AcquireSandboxOptions {
  usageId: string;
  purpose?: string;
  signal?: AbortSignal;
  /** Registers an existing record when track() was not called first. */
  record?: SandboxRecord;
  /** Required with record/create when the resource has not already been tracked. */
  persist?: PersistSandboxRecord;
  /** Creates the resource only when no record exists for resourceKey. */
  create?: { template: string; metadata?: Record<string, string> };
}

export interface SandboxLease {
  readonly resourceKey: string;
  readonly usageId: string;
  readonly sandbox: SandboxHandle;
  /** Returns a defensive snapshot of the current record. */
  readonly record: SandboxRecord;
  /** Aborted if the manager invalidates this resource handle. */
  readonly signal: AbortSignal;
  release(options?: { detached?: boolean }): Promise<void>;
}

export interface SandboxObservation {
  record: SandboxRecord;
  info?: SandboxInfo;
  usageIds: string[];
}
