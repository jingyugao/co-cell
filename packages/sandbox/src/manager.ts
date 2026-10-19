import { SandboxBusyError, SandboxManagerError, SandboxPersistenceError } from './errors.js';
import { SandboxLifecycle, SandboxExtensionError } from './lifecycle.js';
import { traced } from './tracing.js';
import type {
  AcquireSandboxOptions,
  SandboxManagerOptions,
  PersistSandboxRecord,
  SandboxLease,
  SandboxObservation,
  SandboxOperation,
  SandboxPolicy,
  SandboxProvider,
  SandboxRecord,
  SandboxStatus,
  SandboxInfo,
  SandboxHandle,
  SandboxLifecycleContext,
  CheckpointableSandboxProvider,
} from './types.js';

export const DEFAULT_SANDBOX_POLICY: Readonly<SandboxPolicy> = Object.freeze({
  timeoutMs: 3 * 60 * 60 * 1000,
  renewalIntervalMs: 60 * 1000,
  scanIntervalMs: 60 * 1000,
  autoCheckpointAfterMs: 60 * 60 * 1000,
});

type Usage = { references: number; detached: boolean; purpose?: string };
type AcquiredLease = { lease: SandboxLease; restoreDetachedOnAbort: boolean };
type ProviderConnection = { handle: SandboxHandle; info: SandboxInfo };
type ConnectFlight = { promise: Promise<ProviderConnection>; controller: AbortController; waiters: number };
type Entry = {
  record: SandboxRecord;
  persist: PersistSandboxRecord;
  persistencePending: boolean;
  sandbox?: SandboxHandle;
  info?: SandboxInfo;
  generation?: string;
  /** Acquires reserve the binding before connecting so destructive actions fail fast. */
  pendingAcquires: number;
  pendingEnsureKey?: string;
  /** One provider connect/restore per local binding, shared by concurrent acquires. */
  connecting?: ConnectFlight;
  /** Invalidates observations that began before a newer lifecycle transition. */
  observationVersion: number;
  /** A failed automatic checkpoint is reported but is not retried each sweep. */
  autoCheckpointAttempted?: boolean;
  usages: Map<string, Usage>;
  invalidation: AbortController;
  lastRenewedAt: number;
  renewing?: Promise<void>;
  leaseLimitReported: boolean;
};

const cloneRecord = (record: SandboxRecord): SandboxRecord => ({
  ...record,
  ...(record.error ? { error: { ...record.error } } : {}),
  ...(record.templateIdentity ? { templateIdentity: {
    ...record.templateIdentity,
    repoDigests: [...record.templateIdentity.repoDigests],
  } } : {}),
  ...(record.checkpoint ? { checkpoint: { ...record.checkpoint } } : {}),
  ...(record.mounts ? { mounts: structuredClone(record.mounts) } : {}),
});

const assertResourceKey = (resourceKey: string) => {
  if (!resourceKey.trim()) throw new SandboxManagerError('invalid', 'Sandbox resource key is required');
};

const assertUsageId = (usageId: string) => {
  if (!usageId.trim()) throw new SandboxManagerError('invalid', 'Sandbox usage ID is required');
};
const parseGeneration = (value?: string): number | undefined => {
  if (!value || !/^[1-9]\d*$/.test(value)) return undefined;
  const generation = Number(value);
  return Number.isSafeInteger(generation) ? generation : undefined;
};
/**
 * Process-local lifecycle coordinator for provider-backed sandboxes.
 *
 * The caller owns resource identity and persistence. A single manager must be
 * the writer for a resource; cross-process fencing is intentionally outside
 * this package.
 */
export class SandboxManager {
  readonly lifecycle: SandboxLifecycle;
  private readonly entries = new Map<string, Entry>();
  private readonly locks = new Map<string, Promise<void>>();
  private readonly inFlight = new Set<Promise<unknown>>();
  private readonly policy: SandboxPolicy;
  private readonly provider: SandboxProvider;
  private readonly checkpointProvider?: CheckpointableSandboxProvider;
  private readonly timer: ReturnType<typeof setInterval>;
  private sweeping?: Promise<void>;
  private closed = false;
  private ensureLeaseSequence = 0;

  constructor(private readonly options: SandboxManagerOptions) {
    if (options.lifecycle && options.extensions) throw new Error('Use either lifecycle or extensions for Sandbox hooks');
    this.lifecycle = options.lifecycle ?? new SandboxLifecycle(options.extensions);
    this.policy = { ...DEFAULT_SANDBOX_POLICY, ...options.policy };
    for (const [name, value] of Object.entries(this.policy)) {
      if (!Number.isFinite(value) || value <= 0) {
        throw new SandboxManagerError('invalid', `Sandbox policy ${name} must be positive`);
      }
    }
    this.provider = options.provider;
    if (typeof (options.provider as Partial<CheckpointableSandboxProvider>).checkpoint === 'function'
      && typeof (options.provider as Partial<CheckpointableSandboxProvider>).restore === 'function') {
      this.checkpointProvider = options.provider as CheckpointableSandboxProvider;
    }
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
    if (entry.record.operation && ['pausing', 'deleting'].includes(entry.record.operation)) {
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

  /**
   * Bind a previously untracked resource to an already-created sandbox.
   *
   * Persistence succeeds before the local binding becomes visible. This method
   * never creates, connects, pauses, or kills the remote sandbox.
   */
  async bind(resourceKey: string, record: SandboxRecord, persist: PersistSandboxRecord): Promise<void> {
    this.assertOpen();
    assertResourceKey(resourceKey);
    this.validateRecord(record);
    await this.lock(resourceKey, async () => {
      this.assertOpen();
      const current = this.entries.get(resourceKey);
      if (current) {
        throw new SandboxManagerError(
          'conflict',
          `Sandbox resource ${resourceKey} is already bound to ${current.record.id}`,
        );
      }
      try {
        await persist(cloneRecord(record));
      } catch (error) {
        throw new SandboxPersistenceError(resourceKey, error);
      }
      this.entries.set(resourceKey, this.entry(record, persist));
      this.log({ event: 'sandbox.bound', resourceKey, sandboxId: record.id });
    });
  }

  /**
   * Remove an idle local binding without changing the remote sandbox.
   *
   * A missing binding is already detached and therefore succeeds. Pending state
   * for a present binding is flushed before its handles are invalidated.
   */
  async untrack(resourceKey: string, expectedSandboxId: string): Promise<void> {
    this.assertOpen();
    assertResourceKey(resourceKey);
    if (!expectedSandboxId.trim()) {
      throw new SandboxManagerError('invalid', 'Expected sandbox ID is required');
    }
    await this.lock(resourceKey, async () => {
      this.assertOpen();
      const current = this.entries.get(resourceKey);
      if (!current) return;
      if (current.record.id !== expectedSandboxId) {
        throw new SandboxManagerError(
          'conflict',
          `Sandbox resource ${resourceKey} is bound to ${current.record.id}, not ${expectedSandboxId}`,
        );
      }
      this.assertIdle(resourceKey, current);
      if (current.persistencePending) await this.persist(resourceKey, current);

      this.entries.delete(resourceKey);
      current.sandbox = undefined;
      current.invalidation.abort(new SandboxManagerError(
        'not_accessible',
        `Sandbox resource ${resourceKey} was untracked`,
      ));
      this.log({ event: 'sandbox.untracked', resourceKey, sandboxId: current.record.id });
    });
  }

  /** Invalidate only our cached handles after the provider confirms release. */
  async forgetReleased(resourceKey: string, sandboxId: string): Promise<void> {
    await this.lock(resourceKey, async () => {
      const current = this.entries.get(resourceKey);
      if (!current || current.record.id !== sandboxId) return;
      this.entries.delete(resourceKey);
      current.sandbox = undefined;
      current.invalidation.abort(new SandboxManagerError('not_accessible', `Sandbox ${sandboxId} was released`));
    });
  }

  /**
   * Replace an idle resource binding after the caller has prepared a new sandbox.
   *
   * The existing persistence callback remains authoritative. Any pending write for
   * the old record is retried first, then the replacement is persisted before the
   * in-memory binding changes. A failed write therefore leaves the old binding and
   * its handles valid, and the caller may retry this operation. This never pauses
   * or kills either sandbox.
   */
  async replace(resourceKey: string, expectedSandboxId: string, replacement: SandboxRecord): Promise<void> {
    this.assertOpen();
    assertResourceKey(resourceKey);
    if (!expectedSandboxId.trim()) {
      throw new SandboxManagerError('invalid', 'Expected sandbox ID is required');
    }
    this.validateRecord(replacement);
    await this.lock(resourceKey, async () => {
      this.assertOpen();
      const current = this.required(resourceKey);
      if (current.record.id !== expectedSandboxId) {
        throw new SandboxManagerError(
          'conflict',
          `Sandbox resource ${resourceKey} is bound to ${current.record.id}, not ${expectedSandboxId}`,
        );
      }
      if (replacement.id === current.record.id) {
        throw new SandboxManagerError(
          'conflict',
          `Replacement sandbox for resource ${resourceKey} must have a different ID`,
        );
      }
      this.assertIdle(resourceKey, current);

      // Do not supersede state which the application has not persisted yet.
      if (current.persistencePending) await this.persist(resourceKey, current);

      const next = this.entry(replacement, current.persist);
      try {
        await current.persist(cloneRecord(next.record));
      } catch (error) {
        throw new SandboxPersistenceError(resourceKey, error);
      }

      current.invalidation.abort(new SandboxManagerError(
        'not_accessible',
        `Sandbox resource ${resourceKey} was replaced by ${replacement.id}`,
      ));
      this.entries.set(resourceKey, next);
      this.log({
        event: 'sandbox.replaced', resourceKey,
        previousSandboxId: current.record.id, sandboxId: replacement.id,
      });
    });
  }

  async acquire(resourceKey: string, options: AcquireSandboxOptions): Promise<SandboxLease> {
    this.assertOpen();
    assertResourceKey(resourceKey);
    assertUsageId(options.usageId);
    this.assertNotAborted(options.signal);
    const operation = this.trackInFlight((async () => {
      if (!this.entries.has(resourceKey) && options.create && options.persist)
        await this.create(resourceKey, options.create, options.persist);
      const entry = await this.lock(resourceKey, async () => {
        this.assertOpen();
        this.assertNotAborted(options.signal);
        let current = this.entries.get(resourceKey);
        if (!current) {
          const persist = options.persist;
          if (!persist) {
            throw new SandboxManagerError('invalid', `A persistence callback is required for untracked resource ${resourceKey}`);
          }
          if (options.record) {
            this.validateRecord(options.record);
            current = this.entry(options.record, persist);
            this.entries.set(resourceKey, current);
          } else {
            throw new SandboxManagerError('not_tracked', `Sandbox resource ${resourceKey} is not tracked`);
          }
        } else {
          this.assertPersist(current, options.persist, resourceKey);
          if (options.record && options.record.id !== current.record.id) {
            throw new SandboxManagerError('conflict', `Sandbox resource ${resourceKey} is already bound to ${current.record.id}`);
          }
        }
        if (current.record.status === 'deleted') {
          throw new SandboxManagerError('not_accessible', `Sandbox resource ${resourceKey} was deleted`);
        }
        current.pendingAcquires += 1;
        return current;
      });

      let reserved = true;
      try {
        if (entry.persistencePending) {
          await this.lock(resourceKey, async () => {
            this.assertCurrent(resourceKey, entry);
            if (entry.persistencePending) await this.persist(resourceKey, entry);
          });
        }
        const connection = await this.connectSingleFlight(resourceKey, entry, options.signal);
        this.assertNotAborted(options.signal);

        return await this.lock(resourceKey, async () => {
          this.assertCurrent(resourceKey, entry);
          this.assertNotAborted(options.signal);
          if (entry.record.status === 'deleted') {
            throw new SandboxManagerError('not_accessible', `Sandbox resource ${resourceKey} was deleted`);
          }
          const now = new Date().toISOString();
          await this.change(resourceKey, entry, { lastActiveAt: now, operation: undefined, error: undefined });
          entry.autoCheckpointAttempted = false;
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
          entry.pendingAcquires -= 1;
          reserved = false;

          let released = false;
          const leaseSignal = options.signal
            ? AbortSignal.any([options.signal, entry.invalidation.signal])
            : entry.invalidation.signal;
          const lease: SandboxLease = {
            resourceKey,
            usageId: options.usageId,
            sandbox: connection.handle,
            info: connection.info,
            get record() { return cloneRecord(entry.record); },
            signal: leaseSignal,
            release: async (releaseOptions?: { detached?: boolean }) => {
              if (released) return;
              released = true;
              await this.release(resourceKey, options.usageId, Boolean(releaseOptions?.detached));
            },
          };
          return { lease, restoreDetachedOnAbort: restoreDetachedOnAbort };
        });
      } finally {
        if (reserved) await this.lock(resourceKey, async () => {
          if (this.entries.get(resourceKey) === entry) entry.pendingAcquires = Math.max(0, entry.pendingAcquires - 1);
        });
      }
    })());
    return this.abortableLease(operation, options.signal);
  }

  /** Explicit resume command used by project operations; updates only this process' observed state. */
  async ensureRunning(resourceKey: string, operationKey: string, signal?: AbortSignal): Promise<SandboxLease> {
    return this.trackInFlight(this.ensureRunningUnblocked(resourceKey, operationKey, signal));
  }

  private async ensureRunningUnblocked(resourceKey: string, requestId: string, signal?: AbortSignal): Promise<SandboxLease> {
    this.assertOpen(); this.assertNotAborted(signal);
    const entry = this.required(resourceKey);
    if (!this.provider.ensureRunning) throw new SandboxManagerError('invalid', 'Provider does not support explicit resume');
    const context = this.context('resume', resourceKey, entry);
    context.signal = signal;
    const connection = await this.lifecycle.run(context, async () => {
      const result = await this.provider.ensureRunning!(entry.record.id, { operationKey: requestId, signal });
      context.sandbox = result.handle; context.observation = result.info; context.metadata = result.info.metadata;
      return result;
    });
    this.assertNotAborted(signal);
    const usageId = `request:${requestId}:${++this.ensureLeaseSequence}`;
    await this.lock(resourceKey, async () => {
      this.assertCurrent(resourceKey, entry);
      if (entry.record.status === 'deleted') {
        throw new SandboxManagerError('not_accessible', `Sandbox resource ${resourceKey} was deleted`);
      }
      entry.sandbox = connection.handle; entry.info = connection.info; entry.generation = connection.info.metadata?.generation;
      entry.observationVersion++;
      entry.autoCheckpointAttempted = false;
      entry.usages.set(usageId, { references: 1, detached: false, purpose: 'resume' });
      await this.change(resourceKey, entry, { status: 'ready', operation: undefined, checkpoint: undefined, error: undefined }, false);
    });
    let released = false;
    return { resourceKey, usageId, sandbox: connection.handle, info: connection.info,
      get record() { return cloneRecord(entry.record); }, signal: entry.invalidation.signal,
      release: async options => { if (!released) { released = true; await this.release(resourceKey, usageId, Boolean(options?.detached), false); } },
    };
  }

  /** Query the management API only. This never connects, resumes, or renews a sandbox. */
  inspect(resourceKey: string): Promise<SandboxObservation> {
    this.assertOpen();
    assertResourceKey(resourceKey);
    return this.trackInFlight(this.inspectUnblocked(resourceKey));
  }

  private async inspectUnblocked(resourceKey: string): Promise<SandboxObservation> {
    const { entry, deleted, observationVersion } = await this.lock(resourceKey, async () => {
      const entry = this.required(resourceKey);
      return { entry, deleted: entry.record.status === 'deleted', observationVersion: ++entry.observationVersion };
    });
    if (deleted) return this.lock(resourceKey, async () => {
      if (this.entries.get(resourceKey) !== entry) return this.currentObservation(resourceKey);
      return this.observation(entry);
    });

    let info: SandboxInfo;
    try {
      info = await this.provider.getInfo(entry.record.id);
    } catch (error) {
      const applicable = await this.lock(resourceKey, async () =>
        this.entries.get(resourceKey) === entry && entry.observationVersion === observationVersion && !entry.connecting);
      if (!applicable) return this.currentObservation(resourceKey);
      if (this.notFound(error)) {
        const applied = await this.lock(resourceKey, async () => {
          if (this.entries.get(resourceKey) !== entry || entry.observationVersion !== observationVersion || entry.connecting) return false;
          await this.change(resourceKey, entry, {
            status: 'unavailable', operation: undefined,
            error: this.errorRecord('not_accessible', error),
          });
          return true;
        });
        if (!applied) return this.currentObservation(resourceKey);
        const detail = this.safeMessage(error);
        throw new SandboxManagerError('not_accessible', `Sandbox ${entry.record.id} is not accessible: ${detail}`, { cause: error });
      }
      this.log({ event: 'sandbox.inspect_failed', sandboxId: entry.record.id, message: this.safeMessage(error) });
      const detail = this.safeMessage(error);
      throw new SandboxManagerError('unavailable', `Sandbox ${entry.record.id} inspection failed: ${detail}`, { cause: error });
    }
    return this.lock(resourceKey, async () => {
      if (this.entries.get(resourceKey) !== entry || entry.observationVersion !== observationVersion) {
        return this.currentObservation(resourceKey);
      }
      if (entry.connecting) return this.observation(entry, info);
      await this.applyObservation(resourceKey, entry, info);
      return this.observation(entry, info);
    });
  }

  async pause(resourceKey: string): Promise<SandboxRecord> {
    this.assertOpen();
    assertResourceKey(resourceKey);
    return this.trackInFlight((async () => {
      const entry = await this.lock(resourceKey, async () => {
        const current = this.required(resourceKey);
        if (current.record.status === 'deleted') {
          throw new SandboxManagerError('not_accessible', `Sandbox resource ${resourceKey} was deleted`);
        }
        await this.change(resourceKey, current, { operation: 'pausing' });
        current.observationVersion++;
        return current;
      });
      try {
        const context = this.context('pause', resourceKey, entry);
        await this.lifecycle.run(context, async () => {
          await this.provider.pause(entry.record.id);
          await this.lock(resourceKey, async () => {
            if (this.entries.get(resourceKey) !== entry || entry.record.status === 'deleted') return;
            entry.sandbox = undefined;
            entry.observationVersion++;
            await this.change(resourceKey, entry, {
              status: 'paused', operation: undefined, pausedAt: new Date().toISOString(), error: undefined,
            });
          });
          context.record = cloneRecord(entry.record);
        });
        return cloneRecord(entry.record);
      } catch (error) {
        await this.lock(resourceKey, async () => {
          if (this.entries.get(resourceKey) !== entry) return;
          if (entry.record.status === 'deleted') return;
          if (entry.record.status === 'paused') await this.change(resourceKey, entry, { error: this.errorRecord('extension_failed', error) });
          else await this.recordFailure(resourceKey, entry, 'unavailable', error);
        });
        const detail = this.safeMessage(error);
        throw new SandboxManagerError('unavailable', `Sandbox ${entry.record.id} pause failed: ${detail}`, { cause: error });
      }
    })());
  }

  async destroy(resourceKey: string): Promise<void> {
    this.assertOpen();
    assertResourceKey(resourceKey);
    await this.trackInFlight((async () => {
      const entry = await this.lock(resourceKey, async () => {
        const entry = this.required(resourceKey);
        if (entry.record.status === 'deleted' && entry.record.error?.code !== 'extension_failed') return undefined;
        await this.change(resourceKey, entry, { operation: 'deleting' });
        entry.observationVersion++;
        return entry;
      });
      if (!entry) return;
      try {
        const context = this.context('destroy', resourceKey, entry);
        await this.lifecycle.run(context, async () => {
          try { await this.provider.kill(entry.record.id); }
          catch (error) { if (!this.notFound(error)) throw error; }
          await this.lock(resourceKey, async () => {
            if (this.entries.get(resourceKey) !== entry) return;
            entry.sandbox = undefined;
            entry.observationVersion++;
            entry.invalidation.abort(new SandboxManagerError('not_accessible', `Sandbox resource ${resourceKey} was deleted`));
            await this.change(resourceKey, entry, { status: 'deleted', operation: undefined, error: undefined });
          });
          context.record = cloneRecord(entry.record);
        });
      } catch (error) {
        await this.lock(resourceKey, async () => {
          if (this.entries.get(resourceKey) !== entry) return;
          if (entry.record.status === 'deleted') await this.change(resourceKey, entry, { error: this.errorRecord('extension_failed', error) });
          else await this.recordFailure(resourceKey, entry, 'unavailable', error);
        });
        const detail = this.safeMessage(error);
        throw new SandboxManagerError('unavailable', `Sandbox ${entry.record.id} deletion failed: ${detail}`, { cause: error });
      }
    })());
  }

  /** Stops local scheduling. It never pauses, kills, or disconnects a remote worker. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    await this.sweeping;
    while (this.inFlight.size || this.locks.size) {
      await Promise.allSettled([...this.inFlight, ...this.locks.values()]);
    }
  }

  private entry(record: SandboxRecord, persist: PersistSandboxRecord): Entry {
    return {
      record: cloneRecord(record), persist, persistencePending: false,
      pendingAcquires: 0, observationVersion: 0,
      usages: new Map(), invalidation: new AbortController(),
      lastRenewedAt: 0, leaseLimitReported: false,
    };
  }

  private async create(
    resourceKey: string,
    create: NonNullable<AcquireSandboxOptions['create']>,
    persist: PersistSandboxRecord,
  ): Promise<Entry> {
    if (!create.template.trim()) throw new SandboxManagerError('invalid', 'Sandbox image is required');
    let entry: Entry | undefined;
    const context: SandboxLifecycleContext = { action: 'create', resourceKey, metadata: create.metadata };
    try {
      await this.lifecycle.run(context, async () => {
        const sandbox = await this.provider.create(create.template, {
          timeoutMs: this.policy.timeoutMs,
          lifecycle: { onTimeout: 'pause', autoResume: false },
          metadata: create.metadata,
        });
        let templateIdentity: SandboxRecord['templateIdentity'];
        let storage: Pick<SandboxRecord, 'mounts' | 'homeVolumeId' | 'ownerKey'> = {};
        try {
          const info = await this.provider.getInfo(sandbox.sandboxId);
          templateIdentity = info.templateIdentity;
          storage = { ...(info.mounts ? { mounts: structuredClone(info.mounts) } : {}),
            ...(info.metadata?.ownerKey ? { ownerKey: info.metadata.ownerKey } : {}),
            ...(info.homeVolumeId ? { homeVolumeId: info.homeVolumeId } : {}) };
          context.metadata = { ...create.metadata, ...info.metadata };
        } catch (error) {
          // Identity enrichment must not turn a successfully-created remote
          // resource into an orphan when an inspect call is temporarily flaky.
          this.log({ event: 'sandbox.identity_inspect_failed', sandboxId: sandbox.sandboxId, message: this.safeMessage(error) });
        }
        const now = new Date().toISOString();
        entry = this.entry({
          id: sandbox.sandboxId, template: create.template, status: 'starting',
          lastActiveAt: now, version: 0,
          ...(templateIdentity ? { templateIdentity } : {}),
          ...storage,
        }, persist);
        entry.persistencePending = true;
        // Persist and publish the local binding atomically with respect to
        // competing local creates. Remote creation and lifecycle hooks stay
        // outside this short critical section.
        await this.lock(resourceKey, async () => {
          await this.persist(resourceKey, entry!);
          this.entries.set(resourceKey, entry!);
        });
        context.sandboxId = sandbox.sandboxId;
        context.sandbox = sandbox;
        context.record = cloneRecord(entry.record);
      });
      entry!.sandbox = context.sandbox;
      entry!.generation = context.metadata?.generation;
      entry!.lastRenewedAt = Date.now();
      await this.change(resourceKey, entry!, { status: 'ready', error: undefined });
    } catch (error) {
      if (entry && !(error instanceof SandboxPersistenceError)) await this.recordFailure(resourceKey, entry, 'unavailable', error);
      if (error instanceof SandboxPersistenceError) {
        const sandboxId = context.sandbox?.sandboxId ?? entry?.record.id;
        if (sandboxId) {
          error.message += `; remote sandbox ${sandboxId} was created but its binding was not published locally`;
          Object.assign(error, { sandboxId });
        }
        throw error;
      }
      const detail = this.safeMessage(error);
      throw new SandboxManagerError('unavailable', `Sandbox creation failed: ${detail}`, { cause: error });
    }
    const sandbox = context.sandbox!;
    this.log({ event: 'sandbox.created', resourceKey, sandboxId: sandbox.sandboxId, template: create.template });
    return entry!;
  }

  private async connect(resourceKey: string, entry: Entry, signal: AbortSignal): Promise<ProviderConnection> {
    this.assertNotAborted(signal);
    let info: SandboxInfo;
    let infoVersion: number;
    for (;;) {
      this.assertNotAborted(signal);
      const version = entry.observationVersion;
      try {
        info = await this.provider.getInfo(entry.record.id);
        this.assertNotAborted(signal);
      } catch (error) {
        this.assertNotAborted(signal);
        let current = false;
        if (this.notFound(error)) {
          current = await this.lock(resourceKey, async () => {
            if (this.entries.get(resourceKey) !== entry || entry.observationVersion !== version) return false;
            await this.recordFailure(resourceKey, entry, 'not_accessible', error);
            return true;
          });
        } else {
          current = await this.lock(resourceKey, async () =>
            this.entries.get(resourceKey) === entry && entry.observationVersion === version);
        }
        if (!current) continue;
        const detail = this.safeMessage(error);
        const code = this.notFound(error) ? 'not_accessible' : 'unavailable';
        const message = code === 'not_accessible'
          ? `Sandbox ${entry.record.id} is not accessible: ${detail}`
          : `Sandbox ${entry.record.id} inspection failed: ${detail}`;
        throw new SandboxManagerError(code, message, { cause: error });
      }
      const current = await this.lock(resourceKey, async () =>
        this.entries.get(resourceKey) === entry && entry.observationVersion === version);
      if (current) { infoVersion = version; break; }
    }

    if (info.state === 'running' && entry.sandbox && entry.generation === info.metadata?.generation) {
      const reused = await this.lock(resourceKey, async () => {
        this.assertCurrent(resourceKey, entry);
        this.assertNotAborted(signal);
        if (entry.observationVersion !== infoVersion) return false;
        await this.applyObservation(resourceKey, entry, info);
        return true;
      });
      if (!reused) return this.connect(resourceKey, entry, signal);
      if (Date.now() - entry.lastRenewedAt >= this.policy.renewalIntervalMs) await this.renew(resourceKey, entry);
      return { handle: entry.sandbox!, info };
    }

    // Ordinary acquisition only observes and connects to a running sandbox.
    // Lifecycle recovery is an explicit ensureRunning() operation.
    if (this.provider.ensureRunning && info.state !== 'running') {
      throw new SandboxManagerError('unavailable',
        `Sandbox ${entry.record.id} is not running; explicit ensure-running is required`);
    }

    const operation: SandboxOperation = info.state === 'paused' ? 'resuming' : 'connecting';
    if (info.state === 'paused') {
      const blockers = [...entry.usages].filter(([, usage]) => usage.references > 0);
      if (blockers.length > 0) throw new SandboxBusyError(resourceKey, blockers.map(([id]) => id));
    }
    const operationStarted = await this.lock(resourceKey, async () => {
      this.assertCurrent(resourceKey, entry);
      this.assertNotAborted(signal);
      if (entry.observationVersion !== infoVersion) return false;
      await this.change(resourceKey, entry, { operation });
      return true;
    });
    if (!operationStarted) return this.connect(resourceKey, entry, signal);
    try {
      const context = this.context(operation === 'resuming' ? 'resume' : 'connect', resourceKey, entry);
      context.signal = signal;
      const connection = await this.lifecycle.run(context, async () => {
        this.assertNotAborted(signal);
        if (entry.record.checkpoint && this.checkpointProvider) {
          if (info.state !== 'running') {
            await traced('sandbox.checkpoint.restore', { 'sandbox.id': entry.record.id },
              () => this.checkpointProvider!.restore(entry.record.id, entry.record.checkpoint!.id, { signal }));
            this.assertNotAborted(signal);
          }
          await this.lock(resourceKey, async () => {
            this.assertCurrent(resourceKey, entry);
            this.assertNotAborted(signal);
            await this.change(resourceKey, entry, { checkpoint: undefined });
          });
        }
        const handle = await traced('sandbox.provider.connect', { 'sandbox.id': entry.record.id }, () => this.provider.connect(entry.record.id, {
          timeoutMs: this.policy.timeoutMs, signal,
        }));
        const observed = await this.provider.getInfo(entry.record.id);
        this.assertNotAborted(signal);
        context.sandbox = handle;
        context.record = cloneRecord(entry.record);
        context.observation = observed;
        context.metadata = observed.metadata;
        return { handle, info: observed };
      });
      this.assertNotAborted(signal);
      await this.lock(resourceKey, async () => {
        this.assertCurrent(resourceKey, entry);
        this.assertNotAborted(signal);
        if (entry.record.status === 'deleted') throw new SandboxManagerError('not_accessible', `Sandbox resource ${resourceKey} was deleted`);
        await this.change(resourceKey, entry, { status: 'ready', operation: undefined, pausedAt: undefined, error: undefined });
        this.assertNotAborted(signal);
        entry.sandbox = connection.handle;
        entry.info = connection.info;
        entry.generation = connection.info.metadata?.generation;
        entry.lastRenewedAt = Date.now();
        entry.observationVersion += 1;
      });
      return connection;
    } catch (error) {
      await this.lock(resourceKey, async () => {
        if (this.entries.get(resourceKey) !== entry || entry.record.status === 'deleted') return;
        entry.sandbox = undefined;
        entry.observationVersion += 1;
        if (signal.aborted) await this.change(resourceKey, entry, { status: 'unavailable', operation: undefined });
        else await this.recordFailure(resourceKey, entry, this.notFound(error) ? 'not_accessible' : 'unavailable', error);
      });
      if (error instanceof SandboxManagerError && error.code === 'not_accessible') throw error;
      if (signal.aborted) throw signal.reason ?? error;
      const code = this.notFound(error) ? 'not_accessible' : 'unavailable';
      const detail = this.safeMessage(error);
      throw new SandboxManagerError(code, `Sandbox ${entry.record.id} connection failed: ${detail}`, { cause: error });
    }
  }

  private async connectSingleFlight(resourceKey: string, entry: Entry, signal?: AbortSignal): Promise<ProviderConnection> {
    this.assertNotAborted(signal);
    let flight!: ConnectFlight;
    let waitForCancelledFlight: Promise<ProviderConnection> | undefined;
    await this.lock(resourceKey, async () => {
      this.assertCurrent(resourceKey, entry);
      this.assertNotAborted(signal);
      if (entry.connecting?.controller.signal.aborted) {
        waitForCancelledFlight = entry.connecting.promise;
        return;
      }
      if (!entry.connecting) {
        entry.observationVersion += 1;
        const controller = new AbortController();
        const created: ConnectFlight = { promise: Promise.resolve(undefined as never), controller, waiters: 0 };
        created.promise = Promise.resolve().then(() => this.connect(resourceKey, entry, controller.signal)).finally(async () => {
          await this.lock(resourceKey, async () => {
            if (this.entries.get(resourceKey) === entry && entry.connecting === created) {
              entry.connecting = undefined;
              entry.observationVersion += 1;
            }
          });
        });
        entry.connecting = created;
      }
      flight = entry.connecting;
      flight.waiters += 1;
    });

    if (waitForCancelledFlight) {
      if (!signal) await waitForCancelledFlight.catch(() => {});
      else {
        if (signal.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
        await new Promise<void>((resolve, reject) => {
          const onAbort = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
          signal.addEventListener('abort', onAbort, { once: true });
          waitForCancelledFlight!.then(() => resolve(), () => resolve())
            .finally(() => signal.removeEventListener('abort', onAbort));
        });
      }
      this.assertNotAborted(signal);
      return this.connectSingleFlight(resourceKey, entry, signal);
    }

    let waiterReleased = false;
    const releaseWaiter = async () => {
      if (waiterReleased) return;
      waiterReleased = true;
      await this.lock(resourceKey, async () => {
        flight.waiters = Math.max(0, flight.waiters - 1);
        if (flight.waiters === 0 && !flight.controller.signal.aborted && entry.connecting === flight) {
          flight.controller.abort(new SandboxManagerError('unavailable', 'Sandbox connection has no active acquire waiters'));
        }
      });
    };
    try {
      if (!signal) return await flight.promise;
      if (signal.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
      return await new Promise<ProviderConnection>((resolve, reject) => {
        const onAbort = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
        signal.addEventListener('abort', onAbort, { once: true });
        flight.promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
      });
    } finally {
      await releaseWaiter();
    }
  }

  private async release(resourceKey: string, usageId: string, detached: boolean, persist = true): Promise<void> {
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
      await this.change(resourceKey, entry, { lastActiveAt: now }, persist);
    });
  }

  private async renew(resourceKey: string, entry: Entry): Promise<void> {
    if (!entry.sandbox || entry.record.status !== 'ready' || !this.provider.renew) return;
    if (entry.renewing) return entry.renewing;
    const recordVersion = entry.record.version ?? 0;
    const observationVersion = entry.observationVersion;
    entry.renewing = (async () => {
      const info = await this.provider.renew!(entry.record.id, this.policy.timeoutMs);
      await this.lock(resourceKey, async () => {
        if (this.entries.get(resourceKey) !== entry || (entry.record.version ?? 0) !== recordVersion
          || entry.observationVersion !== observationVersion
          || entry.record.status !== 'ready' || entry.record.operation) return;
        entry.info = info;
        if (info.state === 'paused') {
          await this.applyObservation(resourceKey, entry, info);
          throw new SandboxManagerError('unavailable', `Sandbox ${entry.record.id} paused during renewal`);
        }
        entry.lastRenewedAt = Date.now();
        const capped = info.endAt !== undefined
          && info.endAt.getTime() < entry.lastRenewedAt + this.policy.timeoutMs - 5_000;
        if (capped && !entry.leaseLimitReported) {
          this.log({
            event: 'sandbox.lease_capped', sandboxId: entry.record.id,
            startedAt: info.startedAt.toISOString(), expiresAt: info.endAt!.toISOString(),
            requestedTimeoutMs: this.policy.timeoutMs,
          });
        }
        entry.leaseLimitReported = capped;
      });
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
          const snapshot = await this.lock(resourceKey, async () => {
            const entry = this.entries.get(resourceKey);
            if (!entry || entry.record.status === 'deleted') return undefined;
            const recordVersion = entry.record.version ?? 0;
            const observationVersion = entry.observationVersion;
            const checkpointDue = Boolean(this.checkpointProvider?.checkpoint
              && entry.record.status === 'ready'
              && Number.isFinite(Date.parse(entry.record.lastActiveAt ?? ''))
              && Date.now() - Date.parse(entry.record.lastActiveAt ?? '') >= this.policy.autoCheckpointAfterMs
              && !entry.record.checkpoint && !entry.autoCheckpointAttempted
              && entry.usages.size === 0 && entry.pendingAcquires === 0 && !entry.record.operation);
            if (checkpointDue) entry.autoCheckpointAttempted = true;
            return {
              entry, recordVersion, observationVersion, record: cloneRecord(entry.record),
              shouldRenew: entry.usages.size > 0 && Boolean(this.provider.renew && entry.sandbox
                && entry.record.status === 'ready' && Date.now() - entry.lastRenewedAt >= this.policy.renewalIntervalMs),
              checkpointDue,
            };
          });
          if (!snapshot) continue;
          const { entry, recordVersion, observationVersion } = snapshot;
          if (snapshot.shouldRenew) {
            await this.renew(resourceKey, entry);
            continue;
          }
          if (snapshot.checkpointDue) {
            const checkpoint = this.checkpointProvider!.checkpoint!;
            try {
              const context = this.context('checkpoint', resourceKey, entry);
              context.record = snapshot.record;
              const saved = await this.lifecycle.run(context, async () => {
                const result = await checkpoint.call(this.checkpointProvider, snapshot.record.id);
                await this.lock(resourceKey, async () => {
                  if (this.entries.get(resourceKey) !== entry || (entry.record.version ?? 0) !== recordVersion
                    || entry.observationVersion !== observationVersion
                    || entry.record.status !== 'ready' || entry.record.operation
                    || entry.usages.size > 0 || entry.pendingAcquires > 0) return;
                  await this.change(resourceKey, entry, { checkpoint: result, status: 'paused', pausedAt: new Date().toISOString() });
                  entry.sandbox = undefined;
                  entry.observationVersion++;
                  context.record = cloneRecord(entry.record);
                });
                return result;
              });
              this.log({ event: 'sandbox.checkpointed', resourceKey, sandboxId: snapshot.record.id, checkpointId: saved.id });
            } catch (error) {
              this.log({ event: 'sandbox.checkpoint_failed', resourceKey, sandboxId: snapshot.record.id, message: this.safeMessage(error) });
            }
            continue;
          }
          let info: SandboxInfo;
          try {
            info = await this.provider.getInfo(snapshot.record.id);
          } catch (error) {
            if (this.notFound(error)) {
              await this.lock(resourceKey, async () => {
                if (this.entries.get(resourceKey) !== entry || (entry.record.version ?? 0) !== recordVersion
                  || entry.observationVersion !== observationVersion
                  || entry.record.operation) return;
                await this.change(resourceKey, entry, {
                  status: 'unavailable', operation: undefined,
                  error: this.errorRecord('not_accessible', error),
                });
                entry.sandbox = undefined;
                entry.observationVersion++;
              });
            }
            throw error;
          }
          await this.lock(resourceKey, async () => {
            if (this.entries.get(resourceKey) !== entry || (entry.record.version ?? 0) !== recordVersion
              || entry.observationVersion !== observationVersion
              || entry.record.operation) return;
            await this.applyObservation(resourceKey, entry, info);
          });
        } catch (error) {
          this.log({ event: 'sandbox.lifecycle_error', resourceKey, message: this.safeMessage(error) });
        }
      }
    })().finally(() => { this.sweeping = undefined; });
    return this.sweeping;
  }

  private async applyObservation(resourceKey: string, entry: Entry, info: SandboxInfo): Promise<void> {
    entry.info = info;
    entry.generation = info.metadata?.generation;
    // A running container is not proof that its required post hooks completed.
    if (info.state === 'running' && (entry.record.status === 'starting' || entry.record.error?.code === 'extension_failed')) return;
    const status: SandboxStatus = info.state === 'paused' ? 'paused' : info.state === 'running' ? 'ready' : 'unavailable';
    const pausedAt = status === 'paused' ? entry.record.pausedAt ?? new Date().toISOString() : undefined;
    const identityChanged = info.templateIdentity
      && JSON.stringify(entry.record.templateIdentity) !== JSON.stringify(info.templateIdentity);
    const storageChanged = info.mounts && JSON.stringify(entry.record.mounts) !== JSON.stringify(info.mounts)
      || info.homeVolumeId && entry.record.homeVolumeId !== info.homeVolumeId;
    if (entry.record.status !== status || entry.record.pausedAt !== pausedAt || entry.record.operation || identityChanged || storageChanged) {
      if (status !== 'ready') entry.sandbox = undefined;
      await this.change(resourceKey, entry, {
        status, pausedAt, operation: undefined, error: undefined,
        ...(info.templateIdentity ? { templateIdentity: info.templateIdentity } : {}),
        ...(info.mounts ? { mounts: structuredClone(info.mounts) } : {}),
        ...(info.homeVolumeId ? { homeVolumeId: info.homeVolumeId } : {}),
        ...(info.metadata?.ownerKey ? { ownerKey: info.metadata.ownerKey } : {}),
      });
    }
  }

  private async change(resourceKey: string, entry: Entry, patch: Partial<SandboxRecord>, persist = true): Promise<void> {
    const previous = cloneRecord(entry.record);
    entry.record = { ...entry.record, ...patch, version: (entry.record.version ?? 0) + 1 };
    if (persist) {
      entry.persistencePending = true;
      await this.persist(resourceKey, entry);
    }
    if (previous.status !== entry.record.status || previous.operation !== entry.record.operation) {
      this.log({
        event: 'sandbox.state_changed', resourceKey, sandboxId: entry.record.id,
        previousStatus: previous.status, status: entry.record.status,
        previousOperation: previous.operation, operation: entry.record.operation,
      });
    }
  }

  private context(action: SandboxLifecycleContext['action'], resourceKey: string, entry: Entry): SandboxLifecycleContext {
    return { action, resourceKey, sandboxId: entry.record.id, sandbox: entry.sandbox, record: cloneRecord(entry.record), observation: entry.info };
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
      status: 'unavailable', operation: undefined, error: this.errorRecord(error instanceof SandboxExtensionError ? 'extension_failed' : code, error),
    });
  }

  private errorRecord(code: string, error: unknown): NonNullable<SandboxRecord['error']> {
    return { code, message: this.safeMessage(error), at: new Date().toISOString() };
  }

  private observation(entry: Entry, info?: SandboxInfo): SandboxObservation {
    return { record: cloneRecord(entry.record), info, usageIds: [...entry.usages.keys()] };
  }

  private currentObservation(resourceKey: string): SandboxObservation {
    const entry = this.entries.get(resourceKey);
    if (!entry) throw new SandboxManagerError('conflict', `Sandbox resource ${resourceKey} changed while it was being observed`);
    return this.observation(entry);
  }

  private assertCurrent(resourceKey: string, entry: Entry): void {
    if (this.entries.get(resourceKey) !== entry) {
      throw new SandboxManagerError('conflict', `Sandbox resource ${resourceKey} changed while it was being acquired`);
    }
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
    if (entry.pendingAcquires > 0 || entry.connecting) {
      throw new SandboxBusyError(resourceKey, [...entry.usages.keys(), 'acquire-pending']);
    }
    if (entry.usages.size > 0) throw new SandboxBusyError(resourceKey, [...entry.usages.keys()]);
  }

  private trackInFlight<T>(operation: Promise<T>): Promise<T> {
    this.inFlight.add(operation);
    void operation.finally(() => this.inFlight.delete(operation)).catch(() => {});
    return operation;
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
      throw new SandboxManagerError('invalid', 'Sandbox record ID and image are required');
    }
  }

  private notFound(error: unknown): boolean {
    return (error as { code?: string })?.code === 'NOT_FOUND'
      || /not found|no such (?:container|object)|404/i.test(String(error));
  }

  private safeMessage(error: unknown): string {
    let message = error instanceof Error ? error.message : String(error);
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
