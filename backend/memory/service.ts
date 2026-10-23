import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, mkdtemp, open, readdir, realpath, rename, rm } from 'node:fs/promises';
import { join, posix, sep } from 'node:path';
import type { MemoryDetail, MemoryFileContent } from '../../protocol/memory-types.js';
import type { CellboxClient } from '../../packages/sandbox/src/providers/cellbox/client.js';
import { HttpError, redactCredentials } from '../../util/errors.js';
import { sandboxMounts } from '../../util/sandbox-mounts.js';
import type { SharedCoordinator, SharedLease } from '../infra/storage/coordination.js';
import type { WebStateStore } from '../infra/storage/web-state.js';
import { prepareMaterials } from './materials.js';
import { memoryRecord, type MemoryRepository, type StoredMemory } from './repository.js';

const DAY = 24 * 60 * 60 * 1000;
const terminal = new Set(['ready', 'failed', 'skipped']);
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
const notFound = (error: unknown) => (error as { status?: number }).status === 404 || (error as { code?: string }).code === 'NOT_FOUND';
type Client = Pick<CellboxClient, 'getBox' | 'getOperation' | 'createVolumeExport' | 'getVolumeExport' | 'downloadVolumeExport' | 'deleteVolumeExport'>;

interface Dependencies {
  repository: MemoryRepository;
  state: Pick<WebStateStore, 'listProjects' | 'listSessions' | 'getProject' | 'getSession'>;
  client: Client;
  directory: string;
  coordinator?: SharedCoordinator;
  logger?: { write(event: Record<string, unknown>): void };
  prepare?: typeof prepareMaterials;
}

/** The worker only exports suspended disks. It never starts an agent or resumes a Box. */
export class MemoryService {
  private controller = new AbortController();
  private timer?: ReturnType<typeof setTimeout>;
  private running?: Promise<void>;
  private lastScan = 0;

  constructor(private deps: Dependencies) {}

  list(offset: number, limit: number) { return this.deps.repository.list(offset, limit); }

  async detail(id: string): Promise<MemoryDetail> {
    const record = await this.requireRecord(id);
    return { record: memoryRecord(record), files: record.status === 'ready' ? record.files : [] };
  }

  async content(id: string, fileId: string, offset: number): Promise<MemoryFileContent> {
    const record = await this.requireRecord(id);
    const file = record.status === 'ready' && record.files.find(file => file.id === fileId);
    if (!file) throw new HttpError(404, '材料文件不存在');
    if (!/^(?:main|agent-[1-9]\d*)\/\d{3,}\.md$/.test(file.path)) throw new Error('Invalid memory file metadata');
    if (!record.artifactId || !/^[a-f\d-]{36}$/i.test(record.artifactId)) throw new Error('Invalid memory artifact metadata');
    const root = await realpath(join(this.directory(record), 'artifacts', record.artifactId)).catch(error => {
      if (missing(error)) throw new HttpError(404, '材料文件已不存在');
      throw error;
    });
    const path = await realpath(join(root, file.path)).catch(error => {
      if (missing(error)) throw new HttpError(404, '材料文件已不存在');
      throw error;
    });
    if (!path.startsWith(root + sep)) throw new HttpError(404, '材料文件不存在');
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size !== file.byteLength) throw new HttpError(409, '材料文件已变化');
      if (offset > info.size) throw new HttpError(400, '文件读取位置超出范围');
      const limit = 256 * 1024;
      const buffer = Buffer.alloc(Math.min(limit + 3, info.size - offset));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      if (bytesRead && (buffer[0] & 0xc0) === 0x80) throw new HttpError(400, '文件读取位置不在字符边界');
      let end = Math.min(limit, bytesRead);
      while (end < bytesRead && (buffer[end] & 0xc0) === 0x80) end++;
      const content = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, end));
      return { content, nextOffset: offset + end < info.size ? offset + end : null, totalBytes: info.size };
    } finally { await handle.close(); }
  }

  async retry(id: string, updatedAt: string) {
    const record = await this.requireRecord(id);
    if (record.status !== 'failed' || record.updatedAt !== updatedAt) throw new HttpError(409, '任务已变化，请刷新后重试');
    record.status = 'queued';
    delete record.error;
    // A known export is observed and removed before another attempt starts.
    if (!record.exportOperationId && !record.exportId) delete record.exportRequestedAt;
    await this.deps.repository.save(record);
  }

  start() {
    if (this.timer || this.running || this.controller.signal.aborted) return;
    const tick = () => {
      this.timer = undefined;
      void this.runOnce().catch(error => this.log('memory.worker_failed', error)).finally(() => {
        if (!this.controller.signal.aborted) {
          this.timer = setTimeout(tick, 5_000);
          this.timer.unref();
        }
      });
    };
    tick();
  }

  /** Shared lock prevents two API replicas from parsing or publishing the same source. */
  runOnce(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.work().finally(() => { this.running = undefined; });
    return this.running;
  }

  private async work() {
    const lease = await this.deps.coordinator?.tryAcquire('memory:worker');
    if (this.deps.coordinator && !lease) return;
    const signal = lease ? AbortSignal.any([this.controller.signal, lease.signal]) : this.controller.signal;
    const assertActive = () => { signal.throwIfAborted(); lease?.assertHeld(); };
    try {
      assertActive();
      if (Date.now() - this.lastScan >= 60_000) {
        await this.enqueue(signal);
        this.lastScan = Date.now();
      }
      for (const record of await this.deps.repository.pending()) {
        assertActive();
        try {
          if (terminal.has(record.status) || record.status === 'queued' && (record.exportOperationId || record.exportId)) {
            await this.cleanup(record, signal, lease ?? undefined);
            continue;
          }
          if (record.status === 'queued') await this.begin(record, signal, assertActive);
          else await this.finish(record, signal, assertActive);
        } catch (error) {
          assertActive();
          // A simultaneous manual retry or another owner must not be overwritten.
          if (error instanceof HttpError && error.status === 409) continue;
          if (terminal.has(record.status)) { this.log('memory.cleanup_failed', error, record.id); continue; }
          record.status = 'failed';
          record.error = redactCredentials(error instanceof Error ? error.message : String(error)).slice(0, 2000);
          await this.deps.repository.save(record);
          this.log('memory.cleaning_failed', error, record.id);
        }
      }
    } finally { await lease?.release(); }
  }

  private async enqueue(signal: AbortSignal) {
    const projects = new Map((await this.deps.state.listProjects()).map(project => [project.id, project]));
    const suspended = new Map<string, boolean>();
    for (const session of await this.deps.state.listSessions()) {
      signal.throwIfAborted();
      const project = session.projectId ? projects.get(session.projectId) : undefined;
      if (!project || project.removedAt || project.name.trim().toLowerCase() === 'system'
        || !['active', 'completed'].includes(project.status ?? 'active') || !project.sandbox
        || project.sandboxOperation && project.sandboxOperation.status !== 'succeeded'
        || project.sandboxBackup && project.sandboxBackup.status !== 'succeeded'
        || session.settings.executionMode !== 'sandbox' || !session.threadId || !(session.turnCount || session.turns.length)
        || session.status === 'running' || session.turns.some(turn => turn.status === 'running')
        || !Number.isFinite(Date.parse(session.updatedAt)) || Date.now() - Date.parse(session.updatedAt) < DAY) continue;
      const boxId = project.sandbox.id;
      if (!suspended.has(boxId)) {
        try {
          const box = await this.deps.client.getBox(boxId, signal);
          suspended.set(boxId, box.phase === 'suspended' && !box.operationId);
        } catch (error) { signal.throwIfAborted(); this.log('memory.source_unavailable', error); suspended.set(boxId, false); }
      }
      if (suspended.get(boxId)) await this.deps.repository.enqueue({ projectId: project.id, projectName: project.name,
        sessionId: session.id, sessionTitle: session.title, sourceUpdatedAt: session.updatedAt,
        sourceThreadId: session.threadId, sourceBoxId: boxId });
    }
  }

  private async source(record: StoredMemory) {
    const [session, project] = await Promise.all([this.deps.state.getSession(record.sessionId), this.deps.state.getProject(record.projectId)]);
    if (!session || !project || project.removedAt || project.name.trim().toLowerCase() === 'system'
      || !['active', 'completed'].includes(project.status ?? 'active') || project.sandbox?.id !== record.sourceBoxId
      || session.projectId !== project.id || session.threadId !== record.sourceThreadId || session.updatedAt !== record.sourceUpdatedAt
      || session.status === 'running') return undefined;
    return { session, project };
  }

  private async begin(record: StoredMemory, signal: AbortSignal, assertActive: () => void) {
    if (!await this.source(record)) { record.status = 'skipped'; await this.deps.repository.save(record); return; }
    const box = await this.deps.client.getBox(record.sourceBoxId, signal);
    if (box.phase !== 'suspended' || box.operationId) return;
    const home = '/home/agent/workspace/.cocell/codex';
    const mount = (sandboxMounts(box) ?? []).filter(m => home === m.mountPath || home.startsWith(m.mountPath.replace(/\/$/, '') + '/'))
      .sort((a, b) => b.mountPath.length - a.mountPath.length)[0];
    if (!mount) throw new Error('对话目录没有独立持久卷');
    record.volumeId = mount.volumeId;
    record.volumePath = posix.relative(mount.mountPath, home) || '.';
    record.status = 'exporting';
    record.exportRequestedAt = new Date().toISOString();
    assertActive();
    await this.deps.repository.save(record);
    const operation = await this.deps.client.createVolumeExport(record.volumeId, record.volumePath, signal);
    record.exportOperationId = operation.id;
    assertActive();
    await this.deps.repository.save(record);
  }

  private async finish(record: StoredMemory, signal: AbortSignal, assertActive: () => void) {
    if (!record.exportOperationId || !record.volumeId) throw new Error('导出提交结果未确认，请重试；未确认的临时导出会自动过期');
    const operation = await this.deps.client.getOperation(record.exportOperationId, signal);
    if (operation.kind !== 'volume-export' || operation.targetId !== record.volumeId) throw new Error('导出操作与源卷不匹配');
    if (operation.status === 'running' || operation.status === 'queued') return;
    if (operation.status === 'failed') throw new Error(operation.error?.message ?? '导出失败');
    if (!operation.result?.exportId) throw new Error('导出成功但缺少结果');
    record.exportId = operation.result.exportId;
    record.status = 'cleaning';
    assertActive();
    await this.deps.repository.save(record);
    if (!await this.source(record)) { record.status = 'skipped'; await this.deps.repository.save(record); return; }
    const directory = this.directory(record);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await this.removeWork(record, assertActive);
    assertActive();
    const work = await mkdtemp(join(directory, 'work-'));
    try {
      const archive = join(work, 'export.tar.gz');
      const info = await this.deps.client.getVolumeExport(record.volumeId, record.exportId, signal);
      if (info.sizeBytes > 18 * 1024 ** 3) throw new Error('对话导出超过 18 GiB 限制');
      await this.deps.client.downloadVolumeExport(record.volumeId, record.exportId, archive, info, signal);
      const prepared = await (this.deps.prepare ?? prepareMaterials)(archive, join(work, 'files'), record.sourceThreadId, signal);
      assertActive();
      if (!await this.source(record)) { record.status = 'skipped'; await this.deps.repository.save(record); return; }
      // Each attempt publishes immutable files. Only the winning DB update makes its directory visible.
      const artifactId = randomUUID();
      await mkdir(join(directory, 'artifacts'), { recursive: true, mode: 0o700 });
      assertActive();
      await rename(join(work, 'files'), join(directory, 'artifacts', artifactId));
      record.artifactId = artifactId;
      record.files = prepared.files.map(file => ({ ...file, id: randomUUID() }));
      record.firstMessage = Array.from(prepared.firstMessage).slice(0, 1000).join('');
      record.fileCount = record.files.length;
      record.encryptedCount = prepared.encryptedCount;
      record.cleanedAt = new Date().toISOString();
      record.status = 'ready';
      delete record.error;
      assertActive();
      await this.deps.repository.save(record);
    } finally { await rm(work, { recursive: true, force: true }).catch(error => this.log('memory.local_cleanup_failed', error, record.id)); }
  }

  private async cleanup(record: StoredMemory, signal: AbortSignal, lease?: SharedLease) {
    try {
      if (!record.exportId && record.exportOperationId) {
        const operation = await this.deps.client.getOperation(record.exportOperationId, signal);
        if (operation.kind !== 'volume-export' || operation.targetId !== record.volumeId) throw new Error('导出清理操作与源卷不匹配');
        if (operation.status === 'running' || operation.status === 'queued') return;
        record.exportId = operation.result?.exportId;
      }
      if (record.exportId && record.volumeId) await this.deps.client.deleteVolumeExport(record.volumeId, record.exportId, signal);
    } catch (error) {
      if (!notFound(error)) { signal.throwIfAborted(); this.log('memory.export_cleanup_failed', error, record.id); return; }
    }
    signal.throwIfAborted(); lease?.assertHeld();
    await this.removeWork(record, () => { signal.throwIfAborted(); lease?.assertHeld(); });
    signal.throwIfAborted(); lease?.assertHeld();
    delete record.exportOperationId; delete record.exportId; delete record.exportRequestedAt;
    await this.deps.repository.save(record);
  }

  private async removeWork(record: StoredMemory, assertActive: () => void) {
    const directory = this.directory(record);
    const entries = await readdir(directory).catch(error => { if (missing(error)) return []; throw error; });
    for (const entry of entries.filter(name => /^work-[a-zA-Z0-9]+$/.test(name))) {
      assertActive();
      await rm(join(directory, entry), { recursive: true, force: true });
    }
  }

  private directory(record: StoredMemory) { return join(this.deps.directory, record.id); }
  private async requireRecord(id: string) {
    const record = await this.deps.repository.get(id);
    if (!record) throw new HttpError(404, '记忆材料不存在');
    return record;
  }
  private log(event: string, error: unknown, recordId?: string) {
    this.deps.logger?.write({ event, recordId, error: redactCredentials(error instanceof Error ? error.message : String(error)) });
  }
  async close() {
    this.controller.abort();
    if (this.timer) clearTimeout(this.timer);
    await this.running?.catch(() => undefined);
  }
}
