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
}

export type PersistSandboxRecord = (record: SandboxRecord) => Promise<void>;

export interface SandboxLogger {
  write(event: { event: string; [key: string]: unknown }): void | Promise<void>;
}

export interface SandboxPolicy {
  timeoutMs: number;
  renewalIntervalMs: number;
  scanIntervalMs: number;
}

export interface SandboxProvider {
  create(template: string, options: {
    timeoutMs: number;
    lifecycle: { onTimeout: 'pause'; autoResume: false };
    metadata?: Record<string, string>;
  }): Promise<SandboxHandle>;
  connect(sandboxId: string, options: { timeoutMs: number }): Promise<SandboxHandle>;
  getInfo(sandboxId: string): Promise<SandboxInfo>;
  pause(sandboxId: string): Promise<boolean>;
  kill(sandboxId: string): Promise<boolean>;
}

export interface SandboxManagerOptions {
  provider: SandboxProvider;
  logger?: SandboxLogger;
  policy?: Partial<SandboxPolicy>;
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
