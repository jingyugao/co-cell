import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SandboxCleanupRecord, SandboxDataArchive } from '../../protocol/sandbox-types.js';

const DAY = 24 * 60 * 60_000;
const MINUTE = 60_000;
const STATE_FILE = 'cleanup.json';

interface PersistedState {
  version: 1;
  records: SandboxCleanupRecord[];
  /** Independent from sandbox deletion: releasing an archive may fail later. */
  archiveReleases?: SandboxDataArchive[];
}

export interface SandboxCleanupOptions {
  directory: string;
  retentionMs?: number;
  scanIntervalMs?: number;
  now?: () => number;
  isReferenced: (sandboxId: string) => boolean | Promise<boolean>;
  pause: (sandboxId: string, record: SandboxCleanupRecord) => Promise<void>;
  remove: (sandboxId: string, record: SandboxCleanupRecord) => Promise<void>;
  verifyArchive?: (archive: SandboxDataArchive) => Promise<void>;
  /** Must be idempotent and must not call back into this service. */
  releaseArchive?: (archive: SandboxDataArchive) => Promise<void>;
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return (message.trim() || '未知清理错误').slice(0, 2_000);
}

function validDate(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function validArchive(value: unknown): value is SandboxDataArchive {
  if (!value || typeof value !== 'object') return false;
  const archive = value as Partial<SandboxDataArchive>;
  return archive.format === 'codex-workspace-v1'
    && typeof archive.key === 'string' && archive.key.length > 0
    && Number.isSafeInteger(archive.sizeBytes) && Number(archive.sizeBytes) >= 0
    && typeof archive.sha256 === 'string' && /^[0-9a-f]{64}$/.test(archive.sha256)
    && validDate(archive.createdAt)
    && typeof archive.workingDirectory === 'string' && archive.workingDirectory.length > 0
    && Array.isArray(archive.threadIds) && archive.threadIds.every(id => typeof id === 'string')
    && typeof archive.manifestSha256 === 'string' && /^[0-9a-f]{64}$/.test(archive.manifestSha256)
    && typeof archive.sourceSandboxId === 'string' && archive.sourceSandboxId.length > 0
    && (archive.sourceProjectId === undefined || (typeof archive.sourceProjectId === 'string' && archive.sourceProjectId.length > 0));
}

function validRecord(value: unknown): value is SandboxCleanupRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<SandboxCleanupRecord>;
  return typeof record.sandboxId === 'string' && record.sandboxId.length > 0
    && (record.reason === 'upgrade' || record.reason === 'idle' || record.reason === 'failed_restore')
    && validDate(record.scheduledAt) && validDate(record.deleteAfter)
    && Number.isSafeInteger(record.attempts) && Number(record.attempts) >= 0
    && (record.archive === undefined || validArchive(record.archive))
    && (record.lastError === undefined || typeof record.lastError === 'string');
}

/**
 * Deletes only explicitly scheduled, unreferenced sandboxes. Archive verification is
 * intentionally independent from project ownership, which is checked by isReferenced.
 */
export class SandboxCleanupService {
  private readonly retentionMs: number;
  private readonly scanIntervalMs: number;
  private readonly clock: () => number;
  private records = new Map<string, SandboxCleanupRecord>();
  private archiveReleases = new Map<string, SandboxDataArchive>();
  private paused = new Set<string>();
  private tail: Promise<unknown> = Promise.resolve();
  private timer?: NodeJS.Timeout;
  private initialized = false;
  private closed = false;

  constructor(private readonly options: SandboxCleanupOptions) {
    this.retentionMs = options.retentionMs ?? DAY;
    this.scanIntervalMs = options.scanIntervalMs ?? MINUTE;
    this.clock = options.now ?? Date.now;
    if (!Number.isFinite(this.retentionMs) || this.retentionMs < 0) throw new Error('retentionMs 必须是非负有限数值');
    if (!Number.isFinite(this.scanIntervalMs) || this.scanIntervalMs <= 0) throw new Error('scanIntervalMs 必须是正有限数值');
  }

  private serial<T>(action: () => Promise<T>): Promise<T> {
    const next = this.tail.catch(() => {}).then(action);
    this.tail = next;
    return next;
  }

  private statePath() { return join(this.options.directory, STATE_FILE); }

  private async persist(records: Map<string, SandboxCleanupRecord>, archiveReleases = this.archiveReleases) {
    await mkdir(this.options.directory, { recursive: true, mode: 0o700 });
    const temporary = join(this.options.directory, `.cleanup-${randomUUID()}.tmp`);
    const state: PersistedState = { version: 1, records: [...records.values()], archiveReleases: [...archiveReleases.values()] };
    try {
      await writeFile(temporary, JSON.stringify(state, null, 2), { mode: 0o600, flag: 'wx' });
      await rename(temporary, this.statePath());
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async init(): Promise<void> {
    await this.serial(async () => {
      if (this.initialized) return;
      await mkdir(this.options.directory, { recursive: true, mode: 0o700 });
      try {
        const state = JSON.parse(await readFile(this.statePath(), 'utf8')) as Partial<PersistedState>;
        if (state.version !== 1 || !Array.isArray(state.records) || !state.records.every(validRecord)
          || (state.archiveReleases !== undefined && (!Array.isArray(state.archiveReleases) || !state.archiveReleases.every(validArchive)))) {
          throw new Error('沙箱清理记录格式无效');
        }
        if (new Set(state.records.map(record => record.sandboxId)).size !== state.records.length) {
          throw new Error('沙箱清理记录包含重复 ID');
        }
        this.records = new Map(state.records.map(record => [record.sandboxId, structuredClone(record)]));
        this.archiveReleases = new Map((state.archiveReleases ?? []).map(archive => [archive.key, structuredClone(archive)]));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      this.initialized = true;
    });
  }

  start(): void {
    if (!this.initialized) throw new Error('SandboxCleanupService 尚未初始化');
    if (this.closed) throw new Error('SandboxCleanupService 已关闭');
    if (this.timer) return;
    void this.sweep().catch(() => {});
    this.timer = setInterval(() => { void this.sweep().catch(() => {}); }, this.scanIntervalMs);
    this.timer.unref();
  }

  async schedule(sandboxId: string, reason: SandboxCleanupRecord['reason'], archive?: SandboxDataArchive): Promise<SandboxCleanupRecord> {
    if (!sandboxId) throw new Error('sandboxId 不能为空');
    return this.serial(async () => {
      if (!this.initialized) throw new Error('SandboxCleanupService 尚未初始化');
      if (this.closed) throw new Error('SandboxCleanupService 已关闭');
      const timestamp = this.clock();
      const record: SandboxCleanupRecord = {
        sandboxId,
        reason,
        scheduledAt: new Date(timestamp).toISOString(),
        deleteAfter: new Date(timestamp + (reason === 'upgrade' ? this.retentionMs : 0)).toISOString(),
        ...(archive ? { archive: structuredClone(archive) } : {}),
        attempts: 0,
      };
      const next = new Map(this.records);
      const previous = next.get(sandboxId);
      next.set(sandboxId, record);
      const releases = previous ? this.withReleasedArchive(previous, next) : this.archiveReleases;
      await this.persist(next, releases);
      this.records = next;
      this.archiveReleases = releases;
      this.paused.delete(sandboxId);
      await this.flushArchiveReleases();
      return structuredClone(record);
    });
  }

  /** Persist an archive-release intent independently from project deletion. */
  async queueArchiveRelease(archive: SandboxDataArchive): Promise<void> {
    if (!validArchive(archive)) throw new Error('归档元数据无效');
    await this.serial(async () => {
      if (!this.initialized) throw new Error('SandboxCleanupService 尚未初始化');
      if (this.closed) throw new Error('SandboxCleanupService 已关闭');
      if (!this.archiveReleases.has(archive.key)) {
        const releases = new Map(this.archiveReleases);
        releases.set(archive.key, structuredClone(archive));
        await this.persist(this.records, releases);
        this.archiveReleases = releases;
      }
      await this.flushArchiveReleases();
    });
  }

  async deleted(sandboxId: string): Promise<void> {
    await this.serial(async () => {
      if (!this.records.has(sandboxId)) return;
      const next = new Map(this.records);
      const removed = next.get(sandboxId)!;
      next.delete(sandboxId);
      const releases = this.withReleasedArchive(removed, next);
      await this.persist(next, releases);
      this.records = next;
      this.archiveReleases = releases;
      this.paused.delete(sandboxId);
      await this.flushArchiveReleases();
    });
  }

  async list(): Promise<SandboxCleanupRecord[]> {
    return this.serial(async () => structuredClone([...this.records.values()]));
  }

  async sweep(): Promise<void> {
    await this.serial(async () => {
      if (!this.initialized || this.closed) return;
      for (const current of [...this.records.values()]) {
        try {
          if (await this.options.isReferenced(current.sandboxId)) continue;
          const due = this.clock() >= Date.parse(current.deleteAfter);
          if (current.reason === 'upgrade' && !this.paused.has(current.sandboxId)) {
            await this.options.pause(current.sandboxId, structuredClone(current));
            this.paused.add(current.sandboxId);
          }
          if (!due) continue;
          if (current.reason !== 'failed_restore') {
            if (!current.archive || current.archive.sourceSandboxId !== current.sandboxId) {
              throw new Error('缺少与沙箱匹配的数据归档，拒绝删除沙箱');
            }
            if (!this.options.verifyArchive) throw new Error('未配置数据归档校验，拒绝删除沙箱');
            await this.options.verifyArchive(structuredClone(current.archive));
          }
          await this.options.remove(current.sandboxId, structuredClone(current));
          const next = new Map(this.records);
          next.delete(current.sandboxId);
          const releases = this.withReleasedArchive(current, next);
          await this.persist(next, releases);
          this.records = next;
          this.archiveReleases = releases;
          this.paused.delete(current.sandboxId);
        } catch (error) {
          // The record may only change inside this serialized section. Keep it for retry,
          // and publish the failure only after the new state is durable.
          const latest = this.records.get(current.sandboxId);
          if (!latest) continue;
          const failed: SandboxCleanupRecord = {
            ...latest,
            attempts: latest.attempts + 1,
            lastError: errorMessage(error),
          };
          const next = new Map(this.records);
          next.set(current.sandboxId, failed);
          await this.persist(next);
          this.records = next;
        }
      }
      await this.flushArchiveReleases();
    });
  }

  private withReleasedArchive(removed: SandboxCleanupRecord, records: Map<string, SandboxCleanupRecord>) {
    const releases = new Map(this.archiveReleases);
    const archive = removed.archive;
    if (archive && ![...records.values()].some(record => record.archive?.key === archive.key)) {
      releases.set(archive.key, structuredClone(archive));
    }
    return releases;
  }

  private async flushArchiveReleases() {
    if (!this.options.releaseArchive) return;
    for (const [key, archive] of [...this.archiveReleases]) {
      if ([...this.records.values()].some(record => record.archive?.key === key)) continue;
      try { await this.options.releaseArchive(structuredClone(archive)); }
      catch { continue; }
      const releases = new Map(this.archiveReleases);
      releases.delete(key);
      await this.persist(this.records, releases);
      this.archiveReleases = releases;
    }
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.closed = true;
    await this.tail.catch(() => {});
  }
}
