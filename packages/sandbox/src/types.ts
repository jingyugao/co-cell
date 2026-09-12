import type { ConnectionOpts, Sandbox, SandboxInfo } from 'e2b';

export type SandboxStatus =
  | 'starting'
  | 'ready'
  | 'paused'
  | 'unavailable'
  | 'archiving'
  | 'archived'
  | 'restoring'
  | 'deleted';

export type SandboxOperation =
  | 'creating'
  | 'connecting'
  | 'resuming'
  | 'pausing'
  | 'archiving'
  | 'restoring'
  | 'deleting';

export interface SandboxArchive {
  key: string;
  sizeBytes: number;
  sha256: string;
  createdAt: string;
}

/** Persisted provider state. Application workspace and execution state stay outside this package. */
export interface SandboxRecord {
  id: string;
  status: SandboxStatus;
  template: string;
  lastActiveAt?: string;
  pausedAt?: string;
  archive?: SandboxArchive;
  operation?: SandboxOperation;
  error?: { code: string; message: string; at: string };
  version?: number;
}

export type PersistSandboxRecord = (record: SandboxRecord) => Promise<void>;

export interface SandboxSnapshotArchive {
  archive(sandboxId: string): Promise<SandboxArchive>;
  restore(sandboxId: string, archive: SandboxArchive): Promise<void>;
}

export interface SandboxLogger {
  write(event: { event: string; [key: string]: unknown }): void | Promise<void>;
}

export interface SandboxPolicy {
  timeoutMs: number;
  renewalIntervalMs: number;
  scanIntervalMs: number;
  archiveAfterMs: number;
}

export interface SandboxProvider {
  create(template: string, options: ConnectionOpts & {
    timeoutMs: number;
    lifecycle: { onTimeout: 'pause'; autoResume: false };
    metadata?: Record<string, string>;
  }): Promise<Sandbox>;
  connect(sandboxId: string, options: ConnectionOpts & { timeoutMs: number }): Promise<Sandbox>;
  getInfo(sandboxId: string, options: ConnectionOpts): Promise<SandboxInfo>;
  pause(sandboxId: string, options: ConnectionOpts): Promise<boolean>;
  kill(sandboxId: string, options: ConnectionOpts): Promise<boolean>;
}

export interface E2BSandboxManagerOptions {
  connection: ConnectionOpts;
  archives?: SandboxSnapshotArchive;
  logger?: SandboxLogger;
  policy?: Partial<SandboxPolicy>;
  /** Test seam; production uses the E2B 2.46.1 Sandbox static API. */
  provider?: SandboxProvider;
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
  readonly sandbox: Sandbox;
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
