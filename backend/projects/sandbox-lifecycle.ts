import type { Project } from '../../protocol/types.js';
import { sandboxMounts } from '../../util/sandbox-mounts.js';

const DAY = 24 * 60 * 60 * 1000;
const MINUTE = 60 * 1000;
const BUSY_RETRY_DELAY = 5 * MINUTE;
const FAST_ARCHIVE_ATTEMPTS = 3;

function completedAfterReleaseReadFailed(project: Project): boolean {
  const op = project.sandboxOperation;
  const box = project.sandbox;
  if (op?.kind !== 'release' || op.status !== 'unknown' || op.errorCode !== 'TRANSPORT'
    || !box || box.operationId || box.ownerKey !== `project:${project.id}`
    || !Number.isSafeInteger(box.generation) || (box.generation ?? 0) < 1
    || !['running', 'suspended'].includes(box.phase ?? '')) return false;
  const mounts = sandboxMounts(box);
  const saved = project.sandboxMounts;
  if (!mounts?.length || !saved?.length || saved.length !== mounts.length || !saved.every(mount =>
    mounts.some(live => live.volumeId === mount.volumeId && live.mountPath === mount.mountPath))) return false;
  // A later explicit completion creates a new archive intent for this same Box.
  // A lost mutation response (UNKNOWN_OUTCOME) cannot authorize this path.
  return Date.parse(project.completedAt ?? '') > Date.parse(op.updatedAt)
    && Boolean(project.lifecycleHistory?.some(event => event.action === 'completed'
      && event.at === project.completedAt && event.sandboxId === box.id));
}

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
    const retryable = operation?.status === 'failed' && ['BUSY', 'PREFLIGHT_UNAVAILABLE'].includes(operation.errorCode ?? '')
      && ['checkpoint', 'release', 'archive'].includes(operation.kind);
    if (operation && operation.status !== 'succeeded' && !completedAfterReleaseReadFailed(project)) {
      if (!retryable) return false;
      // A confirmed BUSY is temporary. Limit persistent contention to one
      // attempt per day after the initial burst, including across restarts.
      const delay = (operation.automaticArchiveAttempt ?? 0) >= FAST_ARCHIVE_ATTEMPTS ? DAY : BUSY_RETRY_DELAY;
      const failedAt = Date.parse(operation.updatedAt);
      if (!Number.isFinite(failedAt) || now - failedAt < delay) return false;
    }
    const backup = project.sandboxBackup;
    if (backup && backup.status !== 'succeeded') {
      const retryableBackup = ['BUSY', 'PREFLIGHT_UNAVAILABLE'].includes(backup.errorCode ?? '')
        || (!backup.errorCode && retryable && operation?.errorCode === 'BUSY' && operation.kind === 'archive' && backup.id === operation.id);
      if (backup.status !== 'failed' || !retryableBackup) return false;
    }
    if (project.sandbox) {
      if (project.sandbox.creation || project.sandbox.operationId) return false;
      if (project.sandbox.ownerKey && project.sandbox.ownerKey !== (project.sandboxOwnerKey ?? `project:${project.id}`)) return false;
      // Native capture supports a single volume. Check before stopping a Box.
      const volumes = [...(project.sandboxMounts ?? []), ...(sandboxMounts(project.sandbox) ?? [])];
      if (new Set(volumes.map(mount => mount.volumeId)).size > 1) return false;
      // Running environments are released with their disks intact before capture.
      return ['ready', 'paused'].includes(project.sandbox.status)
        || (project.sandbox.status === 'unavailable' && project.sandbox.phase === 'failed');
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
