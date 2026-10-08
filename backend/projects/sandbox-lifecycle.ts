import type { Project } from '../../protocol/types.js';

const DAY = 24 * 60 * 60 * 1000;
const MINUTE = 60 * 1000;

export interface SandboxLifecycleOptions {
  listProjects: () => Project[] | Promise<Project[]>;
  /** Resolves only after the reclaim operation has reached a terminal state. */
  reclaim: (projectId: string) => Promise<void>;
  completedPauseAfterMs?: number;
  /** Legacy configuration alias; completed projects now retain their disks. */
  archivedReclaimAfterMs?: number;
  scanIntervalMs?: number;
  now?: () => number;
}

/** Releases compute for completed projects while retaining their existing disks. */
export class SandboxLifecycleService {
  private readonly completedPauseAfterMs: number;
  private readonly scanIntervalMs: number;
  private readonly now: () => number;
  private timer?: ReturnType<typeof setInterval>;
  private sweeping?: Promise<void>;
  private closed = false;

  constructor(private readonly options: SandboxLifecycleOptions) {
    this.completedPauseAfterMs = options.completedPauseAfterMs ?? options.archivedReclaimAfterMs ?? DAY;
    this.scanIntervalMs = options.scanIntervalMs ?? MINUTE;
    this.now = options.now ?? Date.now;
    if (!Number.isFinite(this.completedPauseAfterMs) || this.completedPauseAfterMs < 0) throw new Error('completedPauseAfterMs must be a non-negative finite number');
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
    const cutoff = this.now() - this.completedPauseAfterMs;
    const eligible = (await this.options.listProjects()).filter(project => {
      if (project.executionMode !== 'sandbox') return false;
      if (project.status !== 'completed') return false;
      // Already paused projects retain both their disk and checkpoint. Never
      // retire a disk automatically, including when an older backup exists.
      if (project.sandbox?.status !== 'ready' || project.archiveCleanupSourceId) return false;
      if (project.sandboxOperation?.status === 'running') return false;
      const timestamp = Date.parse(project.completedAt ?? '');
      return Number.isFinite(timestamp) && timestamp <= cutoff;
    });
    for (const project of eligible) {
      if (this.closed) break;
      try { await this.options.reclaim(project.id); }
      catch { /* A busy project or transient failure is retried by a later sweep. */ }
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.sweeping?.catch(() => {});
  }
}
