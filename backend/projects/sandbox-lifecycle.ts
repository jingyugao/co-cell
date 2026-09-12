import type { Project } from '../../protocol/types.js';

const DAY = 24 * 60 * 60 * 1000;
const MINUTE = 60 * 1000;

export interface SandboxLifecycleOptions {
  listProjects: () => Project[];
  /** Resolves only after the reclaim operation has reached a terminal state. */
  reclaim: (projectId: string) => Promise<void>;
  idleReclaimAfterMs?: number;
  scanIntervalMs?: number;
  now?: () => number;
}

/** Periodically asks the project coordinator to reclaim idle E2B environments. */
export class SandboxLifecycleService {
  private readonly idleReclaimAfterMs: number;
  private readonly scanIntervalMs: number;
  private readonly now: () => number;
  private timer?: ReturnType<typeof setInterval>;
  private sweeping?: Promise<void>;
  private closed = false;

  constructor(private readonly options: SandboxLifecycleOptions) {
    this.idleReclaimAfterMs = options.idleReclaimAfterMs ?? 7 * DAY;
    this.scanIntervalMs = options.scanIntervalMs ?? MINUTE;
    this.now = options.now ?? Date.now;
    if (!Number.isFinite(this.idleReclaimAfterMs) || this.idleReclaimAfterMs < 0) throw new Error('idleReclaimAfterMs must be a non-negative finite number');
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
    const cutoff = this.now() - this.idleReclaimAfterMs;
    const eligible = this.options.listProjects().filter(project => {
      if (project.executionMode !== 'e2b' || !project.sandbox) return false;
      const lastActiveAt = project.sandbox.lastActiveAt ?? project.updatedAt;
      const timestamp = Date.parse(lastActiveAt);
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
