import type { Project } from '../../protocol/types.js';

const DAY = 24 * 60 * 60 * 1000;
const MINUTE = 60 * 1000;
const BUSY_RETRY_DELAY = 5 * MINUTE;
const MAX_AUTOMATIC_ARCHIVE_ATTEMPTS = 3;

export interface SandboxLifecycleOptions {
  listProjects: () => Project[] | Promise<Project[]>;
  /** Resolves only after the reclaim operation has reached a terminal state. */
  reclaim: (projectId: string, options?: { useExistingBackup: boolean }) => Promise<void>;
  archivedReclaimAfterMs?: number;
  scanIntervalMs?: number;
  now?: () => number;
}

/** After the grace period, backs up completed projects before reclaiming their sandboxes. */
export class SandboxLifecycleService {
  private readonly archivedReclaimAfterMs: number;
  private readonly scanIntervalMs: number;
  private readonly now: () => number;
  private timer?: ReturnType<typeof setInterval>;
  private sweeping?: Promise<void>;
  private closed = false;

  constructor(private readonly options: SandboxLifecycleOptions) {
    this.archivedReclaimAfterMs = options.archivedReclaimAfterMs ?? DAY;
    this.scanIntervalMs = options.scanIntervalMs ?? MINUTE;
    this.now = options.now ?? Date.now;
    if (!Number.isFinite(this.archivedReclaimAfterMs) || this.archivedReclaimAfterMs < 0) throw new Error('archivedReclaimAfterMs must be a non-negative finite number');
    if (!Number.isFinite(this.scanIntervalMs) || this.scanIntervalMs <= 0) throw new Error('scanIntervalMs must be a positive finite number');
  }

  start(): void {
    if (this.closed || this.timer) return;
    void this.sweep().catch(() => {});
    this.timer = setInterval(() => { void this.sweep().catch(() => {}); }, this.scanIntervalMs);
    this.timer.unref?.();
  }

  sweep(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.sweeping) return this.sweeping;
    const current = this.runSweep().finally(() => {
      if (this.sweeping === current) this.sweeping = undefined;
    });
    this.sweeping = current;
    return current;
  }

  /** Rechecked under the project operation lock before any automatic mutation. */
  isEligible(project: Project): boolean {
    if (project.removedAt || project.executionMode !== 'sandbox' || project.status !== 'completed') return false;
    const now = this.now();
    const timestamp = Date.parse(project.completedAt ?? '');
    if (!Number.isFinite(timestamp) || timestamp > now - this.archivedReclaimAfterMs) return false;
    const operation = project.sandboxOperation;
    const retryable = operation?.status === 'failed' && operation.errorCode === 'BUSY'
      && ['checkpoint', 'release', 'archive'].includes(operation.kind);
    if (operation && operation.status !== 'succeeded') {
      // Only an explicit BUSY failure authorizes a new submission. Unknown
      // outcomes and other failures still require an operator decision.
      if (!retryable || (operation.automaticArchiveAttempt ?? 0) >= MAX_AUTOMATIC_ARCHIVE_ATTEMPTS) return false;
      const failedAt = Date.parse(operation.updatedAt);
      if (!Number.isFinite(failedAt) || now - failedAt < BUSY_RETRY_DELAY) return false;
    }
    const backup = project.sandboxBackup;
    if (backup && backup.status !== 'succeeded') {
      const busyBackup = backup.errorCode === 'BUSY'
        || (retryable && operation?.kind === 'archive' && backup.id === operation.id);
      if (backup.status !== 'failed' || !busyBackup) return false;
    }
    if (project.sandbox) {
      if (project.sandbox.creation) return false;
      // Running environments are released with their disks intact before capture.
      return ['ready', 'paused'].includes(project.sandbox.status) || project.sandbox.phase === 'failed';
    }
    return Boolean(project.sandboxMounts?.length || project.archiveCleanupSourceId);
  }

  private async runSweep(): Promise<void> {
    const eligible = (await this.options.listProjects()).filter(project => this.isEligible(project));
    for (const project of eligible) {
      if (this.closed) break;
      try { await this.options.reclaim(project.id, { useExistingBackup: false }); }
      catch { /* Persisted outcomes bound retries and prevent replay after an unknown result. */ }
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.sweeping?.catch(() => {});
  }
}
