import { Sandbox, type SandboxInfo } from 'e2b';
import { SandboxBusyError, SandboxManagerError, SandboxPersistenceError } from './errors.js';
import type {
  AcquireSandboxOptions,
  E2BSandboxManagerOptions,
  PersistSandboxRecord,
  SandboxLease,
  SandboxObservation,
  SandboxOperation,
  SandboxPolicy,
  SandboxProvider,
  SandboxRecord,
  SandboxStatus,
} from './types.js';

export const DEFAULT_SANDBOX_POLICY: Readonly<SandboxPolicy> = Object.freeze({
  timeoutMs: 3 * 60 * 60 * 1000,
  renewalIntervalMs: 60 * 1000,
  scanIntervalMs: 60 * 1000,
  archiveAfterMs: 7 * 24 * 60 * 60 * 1000,
});

type Usage = { references: number; detached: boolean; purpose?: string };
type AcquiredLease = { lease: SandboxLease; restoreDetachedOnAbort: boolean };
type Entry = {
  record: SandboxRecord;
  persist: PersistSandboxRecord;
  persistencePending: boolean;
  sandbox?: Sandbox;
  usages: Map<string, Usage>;
  invalidation: AbortController;
  lastRenewedAt: number;
  renewing?: Promise<void>;
  leaseLimitReported: boolean;
};

const provider: SandboxProvider = {
  create: (template, options) => Sandbox.create(template, options),
  connect: (sandboxId, options) => Sandbox.connect(sandboxId, options),
  getInfo: (sandboxId, options) => Sandbox.getInfo(sandboxId, options),
  pause: (sandboxId, options) => Sandbox.pause(sandboxId, options),
  kill: (sandboxId, options) => Sandbox.kill(sandboxId, options),
};

const cloneRecord = (record: SandboxRecord): SandboxRecord => ({
  ...record,
  ...(record.archive ? { archive: { ...record.archive } } : {}),
  ...(record.error ? { error: { ...record.error } } : {}),
});

const assertResourceKey = (resourceKey: string) => {
  if (!resourceKey.trim()) throw new SandboxManagerError('invalid', 'Sandbox resource key is required');
};

const assertUsageId = (usageId: string) => {
  if (!usageId.trim()) throw new SandboxManagerError('invalid', 'Sandbox usage ID is required');
};

/**
 * Process-local lifecycle coordinator for E2B sandboxes.
 *
 * The caller owns resource identity and persistence. A single manager must be
 * the writer for a resource; cross-process fencing is intentionally outside
 * this package.
 */
export class E2BSandboxManager {
  private readonly entries = new Map<string, Entry>();
  private readonly locks = new Map<string, Promise<void>>();
  private readonly policy: SandboxPolicy;
  private readonly provider: SandboxProvider;
  private readonly timer: ReturnType<typeof setInterval>;
  private sweeping?: Promise<void>;
  private closed = false;

  constructor(private readonly options: E2BSandboxManagerOptions) {
    this.policy = { ...DEFAULT_SANDBOX_POLICY, ...options.policy };
    for (const [name, value] of Object.entries(this.policy)) {
      if (!Number.isFinite(value) || value <= 0) {
        throw new SandboxManagerError('invalid', `Sandbox policy ${name} must be positive`);
      }
    }
    this.provider = options.provider ?? provider;
    this.timer = setInterval(() => { void this.sweep(); }, this.policy.scanIntervalMs);
    this.timer.unref();
  }

  /** Register persisted state without inspecting, connecting, or renewing it. */
  track(resourceKey: string, record: SandboxRecord, persist: PersistSandboxRecord): void {
    this.assertOpen();
    assertResourceKey(resourceKey);
    this.validateRecord(record);
    const current = this.entries.get(resourceKey);
    if (current) {
      if (current.record.id !== record.id) {
        throw new SandboxManagerError('conflict', `Sandbox resource ${resourceKey} is already bound to ${current.record.id}`);
      }
      if (current.persist !== persist) {
        throw new SandboxManagerError('conflict', `Sandbox resource ${resourceKey} already has a persistence callback`);
      }
      return;
    }
    if (this.locks.has(resourceKey)) {
      throw new SandboxManagerError('conflict', `Sandbox resource ${resourceKey} is being registered`);
    }
    this.entries.set(resourceKey, this.entry(record, persist));
  }

  /** Conservatively mark a recovered remote operation busy without waking its sandbox. */
  holdUsage(resourceKey: string, usageId: string, purpose = 'recovery'): void {
    this.assertOpen();
    assertResourceKey(resourceKey);
    assertUsageId(usageId);
    const entry = this.required(resourceKey);
    if (entry.record.status === 'deleted') {
      throw new SandboxManagerError('not_accessible', `Sandbox resource ${resourceKey} was deleted`);
    }
    if (entry.record.operation && ['pausing', 'archiving', 'deleting'].includes(entry.record.operation)) {
      throw new SandboxManagerError('busy', `Sandbox resource ${resourceKey} is being ${entry.record.operation}`);
    }
    const usage = entry.usages.get(usageId);
    if (!usage) entry.usages.set(usageId, { references: 0, detached: true, purpose });
  }

  /** Purely local snapshot. */
  peek(resourceKey: string): SandboxRecord | undefined {
    const entry = this.entries.get(resourceKey);
    return entry ? cloneRecord(entry.record) : undefined;
  }

  async acquire(resourceKey: string, options: AcquireSandboxOptions): Promise<SandboxLease> {
    this.assertOpen();
    assertResourceKey(resourceKey);
    assertUsageId(options.usageId);
    this.assertNotAborted(options.signal);
    const operation = this.lock(resourceKey, async () => {
      this.assertOpen();
      this.assertNotAborted(options.signal);
      let entry = this.entries.get(resourceKey);
      if (!entry) {
        const persist = options.persist;
        if (!persist) {
          throw new SandboxManagerError('invalid', `A persistence callback is required for untracked resource ${resourceKey}`);
        }
        if (options.record) {
          this.validateRecord(options.record);
          entry = this.entry(options.record, persist);
          this.entries.set(resourceKey, entry);
        } else if (options.create) {
          entry = await this.create(resourceKey, options.create, persist);
        } else {
          throw new SandboxManagerError('not_tracked', `Sandbox resource ${resourceKey} is not tracked`);
        }
      } else {
        this.assertPersist(entry, options.persist, resourceKey);
        if (options.record && options.record.id !== entry.record.id) {
          throw new SandboxManagerError('conflict', `Sandbox resource ${resourceKey} is already bound to ${entry.record.id}`);
        }
      }
      if (entry.record.status === 'deleted') {
        throw new SandboxManagerError('not_accessible', `Sandbox resource ${resourceKey} was deleted`);
      }
      if (entry.persistencePending) await this.persist(resourceKey, entry);

      const sandbox = await this.connect(resourceKey, entry);
      this.assertNotAborted(options.signal);

      const now = new Date().toISOString();
      await this.change(resourceKey, entry, { lastActiveAt: now, operation: undefined, error: undefined });
      this.assertNotAborted(options.signal);
      const usage = entry.usages.get(options.usageId);
      const restoreDetachedOnAbort = usage?.detached === true;
      if (usage) {
        usage.references += 1;
        usage.detached = false;
        usage.purpose = options.purpose ?? usage.purpose;
      } else {
        entry.usages.set(options.usageId, { references: 1, detached: false, purpose: options.purpose });
      }

      let released = false;
      const leaseSignal = options.signal
        ? AbortSignal.any([options.signal, entry.invalidation.signal])
        : entry.invalidation.signal;
      const lease: SandboxLease = {
        resourceKey,
        usageId: options.usageId,
        sandbox,
        get record() { return cloneRecord(entry!.record); },
        signal: leaseSignal,
        release: async (releaseOptions?: { detached?: boolean }) => {
          if (released) return;
          released = true;
          await this.release(resourceKey, options.usageId, Boolean(releaseOptions?.detached));
        },
      };
      return { lease, restoreDetachedOnAbort };
    });
    return this.abortableLease(operation, options.signal);
  }

  /** Query the management API only. This never connects, resumes, or renews a sandbox. */
  async inspect(resourceKey: string): Promise<SandboxObservation> {
    this.assertOpen();
    assertResourceKey(resourceKey);
    return this.lock(resourceKey, async () => {
      const entry = this.required(resourceKey);
      if (entry.record.status === 'deleted') return this.observation(entry);
      let info: SandboxInfo;
      try {
        info = await this.provider.getInfo(entry.record.id, this.options.connection);
      } catch (error) {
        if (this.notFound(error)) {
          if (entry.record.status === 'archived' && entry.record.archive) {
            this.log({ event: 'sandbox.archived_inspect_unavailable', sandboxId: entry.record.id, message: this.safeMessage(error) });
            return this.observation(entry);
          }
          await this.change(resourceKey, entry, {
            status: 'unavailable', operation: undefined,
            error: this.errorRecord('not_accessible', error),
          });
          const detail = this.safeMessage(error);
          throw new SandboxManagerError('not_accessible', `Sandbox ${entry.record.id} is not accessible: ${detail}`, { cause: new Error(detail) });
        }
        this.log({ event: 'sandbox.inspect_failed', sandboxId: entry.record.id, message: this.safeMessage(error) });
        const detail = this.safeMessage(error);
        throw new SandboxManagerError('unavailable', `Sandbox ${entry.record.id} inspection failed: ${detail}`, { cause: new Error(detail) });
      }
      await this.applyObservation(resourceKey, entry, info);
      return this.observation(entry, info);
    });
  }

  async pause(resourceKey: string): Promise<SandboxRecord> {
    this.assertOpen();
    assertResourceKey(resourceKey);
    return this.lock(resourceKey, async () => {
      const entry = this.required(resourceKey);
      this.assertIdle(resourceKey, entry);
      if (entry.record.status === 'deleted') {
        throw new SandboxManagerError('not_accessible', `Sandbox resource ${resourceKey} was deleted`);
      }
      if (entry.record.status === 'archived' || entry.record.status === 'paused') return cloneRecord(entry.record);
      await this.change(resourceKey, entry, { operation: 'pausing' });
      try {
        await this.provider.pause(entry.record.id, this.options.connection);
        entry.sandbox = undefined;
        await this.change(resourceKey, entry, {
          status: 'paused', operation: undefined, pausedAt: new Date().toISOString(), error: undefined,
        });
        return cloneRecord(entry.record);
      } catch (error) {
        await this.recordFailure(resourceKey, entry, 'unavailable', error);
        const detail = this.safeMessage(error);
        throw new SandboxManagerError('unavailable', `Sandbox ${entry.record.id} pause failed: ${detail}`, { cause: new Error(detail) });
      }
    });
  }

  async destroy(resourceKey: string): Promise<void> {
    this.assertOpen();
    assertResourceKey(resourceKey);
    await this.lock(resourceKey, async () => {
      const entry = this.required(resourceKey);
      this.assertIdle(resourceKey, entry);
      if (entry.record.status === 'deleted') return;
      await this.change(resourceKey, entry, { operation: 'deleting' });
      try {
        await this.provider.kill(entry.record.id, this.options.connection);
      } catch (error) {
        if (!this.notFound(error)) {
          await this.recordFailure(resourceKey, entry, 'unavailable', error);
          const detail = this.safeMessage(error);
          throw new SandboxManagerError('unavailable', `Sandbox ${entry.record.id} deletion failed: ${detail}`, { cause: new Error(detail) });
        }
      }
      entry.sandbox = undefined;
      entry.invalidation.abort(new SandboxManagerError('not_accessible', `Sandbox resource ${resourceKey} was deleted`));
      await this.change(resourceKey, entry, { status: 'deleted', operation: undefined, error: undefined });
    });
  }

  /** Stops local scheduling. It never pauses, kills, or disconnects a remote worker. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    await this.sweeping;
    await Promise.all([...this.locks.values()]);
  }

  private entry(record: SandboxRecord, persist: PersistSandboxRecord): Entry {
    return {
      record: cloneRecord(record), persist, persistencePending: false,
      usages: new Map(), invalidation: new AbortController(),
      lastRenewedAt: 0, leaseLimitReported: false,
    };
  }

  private async create(
    resourceKey: string,
    create: NonNullable<AcquireSandboxOptions['create']>,
    persist: PersistSandboxRecord,
  ): Promise<Entry> {
    if (!create.template.trim()) throw new SandboxManagerError('invalid', 'Sandbox template is required');
    let sandbox: Sandbox;
    try {
      sandbox = await this.provider.create(create.template, {
        ...this.options.connection,
        timeoutMs: this.policy.timeoutMs,
        lifecycle: { onTimeout: 'pause', autoResume: false },
        metadata: create.metadata,
      });
    } catch (error) {
      const detail = this.safeMessage(error);
      throw new SandboxManagerError('unavailable', `Sandbox creation failed: ${detail}`, { cause: new Error(detail) });
    }
    const now = new Date().toISOString();
    const entry = this.entry({
      id: sandbox.sandboxId, template: create.template, status: 'ready',
      lastActiveAt: now, version: 0,
    }, persist);
    entry.sandbox = sandbox;
    entry.lastRenewedAt = Date.now();
    entry.persistencePending = true;
    this.entries.set(resourceKey, entry);
    await this.persist(resourceKey, entry);
    this.log({ event: 'sandbox.created', resourceKey, sandboxId: sandbox.sandboxId, template: create.template });
    return entry;
  }

  private async connect(resourceKey: string, entry: Entry): Promise<Sandbox> {
    if (entry.record.status === 'archived' || entry.record.status === 'restoring') {
      await this.restore(resourceKey, entry);
    }
    let info: SandboxInfo;
    try {
      info = await this.provider.getInfo(entry.record.id, this.options.connection);
    } catch (error) {
      if (this.notFound(error)) {
        await this.recordFailure(resourceKey, entry, 'not_accessible', error);
        const detail = this.safeMessage(error);
        throw new SandboxManagerError('not_accessible', `Sandbox ${entry.record.id} is not accessible: ${detail}`, { cause: new Error(detail) });
      }
      const detail = this.safeMessage(error);
      throw new SandboxManagerError('unavailable', `Sandbox ${entry.record.id} inspection failed: ${detail}`, { cause: new Error(detail) });
    }

    if (info.state === 'running' && entry.sandbox) {
      await this.applyObservation(resourceKey, entry, info);
      if (Date.now() - entry.lastRenewedAt >= this.policy.renewalIntervalMs) await this.renew(resourceKey, entry);
      return entry.sandbox;
    }

    const operation: SandboxOperation = info.state === 'paused' ? 'resuming' : 'connecting';
    if (info.state === 'paused') {
      const blockers = [...entry.usages].filter(([, usage]) => usage.references > 0);
      if (blockers.length > 0) {
        throw new SandboxBusyError(resourceKey, blockers.map(([id]) => id));
      }
    }
    await this.change(resourceKey, entry, { operation });
    try {
      const sandbox = await this.provider.connect(entry.record.id, {
        ...this.options.connection,
        timeoutMs: this.policy.timeoutMs,
      });
      entry.sandbox = sandbox;
      entry.lastRenewedAt = Date.now();
      await this.change(resourceKey, entry, {
        status: 'ready', operation: undefined, pausedAt: undefined, error: undefined,
      });
      return sandbox;
    } catch (error) {
      await this.recordFailure(resourceKey, entry, this.notFound(error) ? 'not_accessible' : 'unavailable', error);
      const code = this.notFound(error) ? 'not_accessible' : 'unavailable';
      const detail = this.safeMessage(error);
      throw new SandboxManagerError(code, `Sandbox ${entry.record.id} connection failed: ${detail}`, { cause: new Error(detail) });
    }
  }

  private async restore(resourceKey: string, entry: Entry): Promise<void> {
    const archive = entry.record.archive;
    if (!archive || !this.options.archives) {
      throw new SandboxManagerError('archive_restore_failed', `Sandbox ${entry.record.id} archive cannot be restored`);
    }
    await this.change(resourceKey, entry, { status: 'restoring', operation: 'restoring' });
    try {
      await this.options.archives.restore(entry.record.id, archive);
      await this.change(resourceKey, entry, {
        status: 'paused', operation: undefined,
        pausedAt: entry.record.pausedAt ?? new Date().toISOString(), error: undefined,
      });
      this.log({ event: 'sandbox.archive_restored', sandboxId: entry.record.id, archiveKey: archive.key });
    } catch (error) {
      await this.change(resourceKey, entry, {
        status: 'archived', operation: undefined,
        error: this.errorRecord('archive_restore_failed', error),
      });
      const detail = this.safeMessage(error);
      throw new SandboxManagerError('archive_restore_failed', `Sandbox ${entry.record.id} archive restoration failed: ${detail}`, { cause: new Error(detail) });
    }
  }

  private async release(resourceKey: string, usageId: string, detached: boolean): Promise<void> {
    if (this.closed) return;
    await this.lock(resourceKey, async () => {
      const entry = this.entries.get(resourceKey);
      if (!entry) return;
      const usage = entry.usages.get(usageId);
      if (!usage) return;
      usage.references = Math.max(0, usage.references - 1);
      if (detached) usage.detached = true;
      if (usage.references === 0 && !usage.detached) entry.usages.delete(usageId);

      const now = new Date().toISOString();
      await this.change(resourceKey, entry, { lastActiveAt: now });
      if (entry.usages.size === 0 && entry.sandbox && entry.record.status === 'ready') {
        await this.renew(resourceKey, entry).catch(error => {
          this.log({ event: 'sandbox.renew_failed', sandboxId: entry.record.id, message: this.safeMessage(error) });
        });
      }
    });
  }

  private async renew(resourceKey: string, entry: Entry): Promise<void> {
    if (!entry.sandbox || entry.record.status !== 'ready') return;
    if (entry.renewing) return entry.renewing;
    entry.renewing = (async () => {
      await entry.sandbox!.setTimeout(this.policy.timeoutMs);
      const info = await this.provider.getInfo(entry.record.id, this.options.connection);
      if (info.state === 'paused') {
        await this.applyObservation(resourceKey, entry, info);
        throw new SandboxManagerError('unavailable', `Sandbox ${entry.record.id} paused during renewal`);
      }
      entry.lastRenewedAt = Date.now();
      const capped = info.endAt.getTime() < entry.lastRenewedAt + this.policy.timeoutMs - 5_000;
      if (capped && !entry.leaseLimitReported) {
        this.log({
          event: 'sandbox.lease_capped', sandboxId: entry.record.id,
          startedAt: info.startedAt.toISOString(), expiresAt: info.endAt.toISOString(),
          requestedTimeoutMs: this.policy.timeoutMs,
        });
      }
      entry.leaseLimitReported = capped;
    })().finally(() => { entry.renewing = undefined; });
    return entry.renewing;
  }

  private sweep(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.sweeping) return this.sweeping;
    this.sweeping = (async () => {
      for (const resourceKey of this.entries.keys()) {
        if (this.closed) break;
        try {
          await this.lock(resourceKey, async () => {
            const entry = this.entries.get(resourceKey);
            if (!entry || entry.record.status === 'deleted') return;
            if (entry.usages.size > 0) {
              if (entry.sandbox && Date.now() - entry.lastRenewedAt >= this.policy.renewalIntervalMs) {
                await this.renew(resourceKey, entry);
              }
              return;
            }
            if (entry.record.status === 'restoring' && entry.record.archive) {
              await this.change(resourceKey, entry, { status: 'archived', operation: undefined });
              return;
            }
            if (entry.record.status === 'archived') return;
            let info: SandboxInfo;
            try {
              info = await this.provider.getInfo(entry.record.id, this.options.connection);
            } catch (error) {
              if (this.notFound(error)) {
                await this.change(resourceKey, entry, {
                  status: 'unavailable', operation: undefined,
                  error: this.errorRecord('not_accessible', error),
                });
              }
              throw error;
            }
            await this.applyObservation(resourceKey, entry, info);
            if (info.state !== 'paused' || !this.options.archives) return;
            const pausedAt = Date.parse(entry.record.pausedAt ?? '');
            if (!Number.isFinite(pausedAt) || Date.now() - pausedAt <= this.policy.archiveAfterMs) return;
            await this.archive(resourceKey, entry);
          });
        } catch (error) {
          this.log({ event: 'sandbox.lifecycle_error', resourceKey, message: this.safeMessage(error) });
        }
      }
    })().finally(() => { this.sweeping = undefined; });
    return this.sweeping;
  }

  private async archive(resourceKey: string, entry: Entry): Promise<void> {
    this.assertIdle(resourceKey, entry);
    const previous = cloneRecord(entry.record);
    await this.change(resourceKey, entry, { status: 'archiving', operation: 'archiving' });
    try {
      const archive = await this.options.archives!.archive(entry.record.id);
      const info = await this.provider.getInfo(entry.record.id, this.options.connection);
      if (info.state !== 'paused') throw new Error('Sandbox resumed while it was being archived');
      await this.change(resourceKey, entry, {
        status: 'archived', operation: undefined, archive, error: undefined,
      });
      this.log({ event: 'sandbox.archived', sandboxId: entry.record.id, archiveKey: archive.key, sizeBytes: archive.sizeBytes });
    } catch (error) {
      entry.record = {
        ...previous, status: 'paused', operation: undefined,
        error: this.errorRecord('unavailable', error),
      };
      entry.persistencePending = true;
      await this.persist(resourceKey, entry);
      throw error;
    }
  }

  private async applyObservation(resourceKey: string, entry: Entry, info: SandboxInfo): Promise<void> {
    if (entry.record.status === 'archived' || entry.record.status === 'restoring') return;
    const status: SandboxStatus = info.state === 'paused' ? 'paused' : 'ready';
    const pausedAt = status === 'paused' ? entry.record.pausedAt ?? new Date().toISOString() : undefined;
    if (entry.record.status !== status || entry.record.pausedAt !== pausedAt || entry.record.operation) {
      if (status === 'paused') entry.sandbox = undefined;
      await this.change(resourceKey, entry, { status, pausedAt, operation: undefined, error: undefined });
    }
  }

  private async change(resourceKey: string, entry: Entry, patch: Partial<SandboxRecord>): Promise<void> {
    const previous = cloneRecord(entry.record);
    entry.record = { ...entry.record, ...patch, version: (entry.record.version ?? 0) + 1 };
    entry.persistencePending = true;
    await this.persist(resourceKey, entry);
    if (previous.status !== entry.record.status || previous.operation !== entry.record.operation) {
      this.log({
        event: 'sandbox.state_changed', resourceKey, sandboxId: entry.record.id,
        previousStatus: previous.status, status: entry.record.status,
        previousOperation: previous.operation, operation: entry.record.operation,
      });
    }
  }

  private async persist(resourceKey: string, entry: Entry): Promise<void> {
    try {
      await entry.persist(cloneRecord(entry.record));
      entry.persistencePending = false;
    } catch (error) {
      entry.persistencePending = true;
      throw new SandboxPersistenceError(resourceKey, error);
    }
  }

  private async recordFailure(resourceKey: string, entry: Entry, code: 'not_accessible' | 'unavailable', error: unknown): Promise<void> {
    await this.change(resourceKey, entry, {
      status: 'unavailable', operation: undefined, error: this.errorRecord(code, error),
    });
  }

  private errorRecord(code: string, error: unknown): NonNullable<SandboxRecord['error']> {
    return { code, message: this.safeMessage(error), at: new Date().toISOString() };
  }

  private observation(entry: Entry, info?: SandboxInfo): SandboxObservation {
    return { record: cloneRecord(entry.record), info, usageIds: [...entry.usages.keys()] };
  }

  private required(resourceKey: string): Entry {
    const entry = this.entries.get(resourceKey);
    if (!entry) throw new SandboxManagerError('not_tracked', `Sandbox resource ${resourceKey} is not tracked`);
    return entry;
  }

  private assertPersist(entry: Entry, persist: PersistSandboxRecord | undefined, resourceKey: string): void {
    if (persist && persist !== entry.persist) {
      throw new SandboxManagerError('conflict', `Sandbox resource ${resourceKey} already has a persistence callback`);
    }
  }

  private assertIdle(resourceKey: string, entry: Entry): void {
    if (entry.usages.size > 0) throw new SandboxBusyError(resourceKey, [...entry.usages.keys()]);
  }

  private assertOpen(): void {
    if (this.closed) throw new SandboxManagerError('closed', 'Sandbox manager is closed');
  }

  private assertNotAborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
  }

  private abortableLease(operation: Promise<AcquiredLease>, signal?: AbortSignal): Promise<SandboxLease> {
    if (!signal) return operation.then(result => result.lease);
    if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    return new Promise<SandboxLease>((resolve, reject) => {
      let cancelled = false;
      const aborted = () => {
        cancelled = true;
        reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      };
      signal.addEventListener('abort', aborted, { once: true });
      void operation.then(result => {
        signal.removeEventListener('abort', aborted);
        if (cancelled) {
          void result.lease.release({ detached: result.restoreDetachedOnAbort }).catch(error => {
            this.log({ event: 'sandbox.cancelled_lease_release_failed', resourceKey: result.lease.resourceKey, message: this.safeMessage(error) });
          });
          return;
        }
        resolve(result.lease);
      }, error => {
        signal.removeEventListener('abort', aborted);
        if (!cancelled) reject(error);
      });
    });
  }

  private validateRecord(record: SandboxRecord): void {
    if (!record.id?.trim() || !record.template?.trim()) {
      throw new SandboxManagerError('invalid', 'Sandbox record ID and template are required');
    }
  }

  private notFound(error: unknown): boolean {
    return /not found|404/i.test(String(error));
  }

  private safeMessage(error: unknown): string {
    let message = error instanceof Error ? error.message : String(error);
    const secret = this.options.connection.apiKey;
    if (secret) message = message.replaceAll(secret, '[REDACTED]');
    return message;
  }

  private log(event: { event: string; [key: string]: unknown }): void {
    try {
      void Promise.resolve(this.options.logger?.write(event)).catch(() => {});
    } catch { /* Logging must not change lifecycle outcomes. */ }
  }

  private async lock<T>(resourceKey: string, action: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(resourceKey) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const tail = previous.then(() => gate);
    this.locks.set(resourceKey, tail);
    await previous;
    try {
      return await action();
    } finally {
      release();
      if (this.locks.get(resourceKey) === tail) this.locks.delete(resourceKey);
    }
  }
}
