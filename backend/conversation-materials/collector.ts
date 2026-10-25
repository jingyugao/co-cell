import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join, posix } from 'node:path';
import type { CellboxClient } from '../../packages/sandbox/src/providers/cellbox/client.js';
import type { ConversationMaterials } from '../../protocol/conversation-materials-types.js';
import type { Project, Session } from '../../protocol/types.js';
import { HttpError, redactCredentials } from '../../util/errors.js';
import { sandboxMounts } from '../../util/sandbox-mounts.js';
import type { WebStateStore } from '../infra/storage/web-state.js';
import type { MaterialSource } from './service.js';
import type { ConversationMaterialsService } from './service.js';
import type { MaterialThread } from './materials.js';

const HOME = '/home/agent/workspace/.cocell/codex';
const MAX_ARCHIVE_BYTES = 18 * 1024 ** 3;
const EXPORT_DEADLINE_MS = 10 * 60_000;
const EXPORT_POLL_MS = 1_000;
type Client = Pick<CellboxClient, 'getBox' | 'createVolumeExport' | 'getOperation' | 'getVolumeExport' | 'downloadVolumeExport' | 'deleteVolumeExport'>;

export interface ConversationMaterialCollectorOptions {
  state: Pick<WebStateStore, 'getProject' | 'getSession'>;
  client: Client;
  materials: ConversationMaterialsService;
  live: (session: Session, signal?: AbortSignal) => Promise<{ threads: MaterialThread[]; complete: boolean }>;
  directory: string;
  logger?: { write(event: Record<string, unknown>): void };
}

function unavailable(message: string): HttpError { return new HttpError(409, message); }

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    const abort = () => { clearTimeout(timer); reject(signal?.reason ?? new DOMException('操作已取消', 'AbortError')); };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

/** Reads a running App Server or exports an already-suspended disk without resuming its Box. */
export class ConversationMaterialCollector {
  constructor(private readonly options: ConversationMaterialCollectorOptions) {}

  async collect(session: Session, signal?: AbortSignal): Promise<ConversationMaterials> {
    if (!session.projectId || !session.threadId) throw unavailable('对话缺少项目或原生线程');
    const initial = await this.source(session);
    const source: MaterialSource = { sessionId: session.id, threadId: session.threadId,
      sourceUpdatedAt: session.updatedAt, boxId: initial.project.sandbox!.id };

    if (session.status !== 'running') {
      const cached = await this.options.materials.cached(source);
      if (cached) { await this.source(session, source); return cached; }
    }

    signal?.throwIfAborted();
    const box = await this.options.client.getBox(source.boxId, signal);
    if (box.id !== source.boxId) throw unavailable('Sandbox 与项目记录不匹配');
    if (box.phase === 'running') {
      const current = await this.source(session, source);
      const result = await this.options.live(current.session, signal);
      signal?.throwIfAborted();
      await this.source(session, source);
      return this.options.materials.live(source, result.threads, result.complete, signal,
        async () => { await this.source(session, source); });
    }
    if (box.phase !== 'suspended' || box.operationId)
      throw unavailable(`Sandbox 当前状态不可离线读取（${box.phase}）`);

    const mount = (sandboxMounts(box) ?? []).filter(value => HOME === value.mountPath
      || HOME.startsWith(value.mountPath.replace(/\/$/, '') + '/'))
      .sort((left, right) => right.mountPath.length - left.mountPath.length)[0];
    if (!mount) throw unavailable('对话目录没有独立持久卷');
    const relativePath = posix.relative(mount.mountPath, HOME) || '.';
    let exportId: string | undefined;
    let workDirectory: string | undefined;
    try {
      // A submission with an unknown outcome is propagated. Never blindly submit a second export.
      const submitted = await this.options.client.createVolumeExport(mount.volumeId, relativePath, signal);
      const operation = await this.waitForExport(submitted.id, mount.volumeId, signal);
      exportId = operation.result?.exportId;
      if (!exportId) throw new Error('对话导出成功但没有返回导出 ID');
      await this.source(session, source);
      const info = await this.options.client.getVolumeExport(mount.volumeId, exportId, signal);
      if (info.id !== exportId || info.volumeId !== mount.volumeId) throw unavailable('导出文件与源卷不匹配');
      if (!Number.isSafeInteger(info.sizeBytes) || info.sizeBytes < 0 || info.sizeBytes > MAX_ARCHIVE_BYTES)
        throw new Error('对话导出超过 18 GiB 限制或大小无效');
      await mkdir(this.options.directory, { recursive: true, mode: 0o700 });
      workDirectory = await mkdtemp(join(this.options.directory, '.collect-'));
      const archive = join(workDirectory, 'export.tar.gz');
      await this.options.client.downloadVolumeExport(mount.volumeId, exportId, archive, info, signal);
      signal?.throwIfAborted();
      await this.source(session, source);
      return await this.options.materials.archive(source, archive, signal,
        async () => { await this.source(session, source); });
    } finally {
      if (exportId) {
        try {
          await this.options.client.deleteVolumeExport(mount.volumeId, exportId, AbortSignal.timeout(5_000));
        } catch (error) {
          this.log('conversation_material.export_cleanup_failed', error, session.id);
        }
      }
      if (workDirectory) {
        try { await rm(workDirectory, { recursive: true, force: true }); }
        catch (error) { this.log('conversation_material.local_cleanup_failed', error, session.id); }
      }
    }
  }

  private async waitForExport(operationId: string, volumeId: string, signal?: AbortSignal) {
    const deadline = Date.now() + EXPORT_DEADLINE_MS;
    for (;;) {
      signal?.throwIfAborted();
      if (Date.now() >= deadline) throw new Error('对话导出等待超过 10 分钟');
      const operation = await this.options.client.getOperation(operationId, signal);
      if (operation.id !== operationId || operation.kind !== 'volume-export' || operation.targetId !== volumeId)
        throw unavailable('Cellbox 导出操作与源卷不匹配');
      if (operation.status === 'succeeded') return operation;
      if (operation.status === 'failed') throw new Error(redactCredentials(operation.error?.message ?? 'Cellbox 对话导出失败'));
      if (!['running', 'queued'].includes(operation.status)) throw new Error('对话导出结果无法确认，未重复提交');
      await delay(Math.min(EXPORT_POLL_MS, deadline - Date.now()), signal);
    }
  }

  private async source(session: Session, expected?: MaterialSource): Promise<{ session: Session; project: Project }> {
    const [currentSession, project] = await Promise.all([
      this.options.state.getSession(session.id), this.options.state.getProject(session.projectId!),
    ]);
    if (!currentSession || !project || project.removedAt || project.name.trim().toLowerCase() === 'system'
      || !['active', 'completed'].includes(project.status ?? 'active') || !project.sandbox?.id
      || currentSession.projectId !== project.id || currentSession.threadId !== session.threadId
      || currentSession.updatedAt !== session.updatedAt
      || currentSession.sandbox?.id && currentSession.sandbox.id !== project.sandbox.id
      || expected && (expected.threadId !== currentSession.threadId || expected.sourceUpdatedAt !== currentSession.updatedAt
        || expected.boxId !== project.sandbox.id))
      throw unavailable('项目或对话已变化，不能使用旧版本生成材料');
    return { session: currentSession, project };
  }

  private log(event: string, error: unknown, sessionId: string) {
    try {
      this.options.logger?.write({ event, sessionId,
        error: redactCredentials(error instanceof Error ? error.message : String(error)).slice(0, 1000) });
    } catch { /* Cleanup reporting must not mask the collection result. */ }
  }
}
