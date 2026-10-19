import type { Project } from '../../protocol/types.js';

const DAY = 24 * 60 * 60 * 1000;
const MINUTE = 60 * 1000;

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

  private async runSweep(): Promise<void> {
    const cutoff = this.now() - this.archivedReclaimAfterMs;
    const eligible = (await this.options.listProjects()).filter(project => {
      if (project.executionMode !== 'sandbox') return false;
      if (project.status !== 'completed') return false;
      // A failed, unknown, or still-running operation needs an explicit user
      // decision; a later sweep must not submit that mutation again.
      if (project.sandboxOperation && project.sandboxOperation.status !== 'succeeded') return false;
      if (project.sandboxBackup && project.sandboxBackup.status !== 'succeeded') return false;
      // Automatic capture is disk-only: it can read a paused box or a box whose
      // failed phase confirms execution has stopped. It never checkpoints a
      // running box implicitly. A committed archive may still need cleanup.
      if (project.sandbox) {
        if (project.sandbox.status !== 'paused' && project.sandbox.phase !== 'failed') return false;
      } else if (!project.archiveCleanupSourceId) return false;
      const timestamp = Date.parse(project.completedAt ?? '');
      return Number.isFinite(timestamp) && timestamp <= cutoff;
    });
    for (const project of eligible) {
      if (this.closed) break;
      try { await this.options.reclaim(project.id, { useExistingBackup: false }); }
      catch { /* The next sweep consults persisted operation/backup state before any new submission. */ }
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.sweeping?.catch(() => {});
  }
}
