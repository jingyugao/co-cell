import { E2BSandboxManager, type SandboxLease } from '@swarm-hive/sandbox';
import { Sandbox, SandboxNotFoundError, type ConnectionOpts } from 'e2b';
import type { SandboxDataArchive, SandboxState } from '../../protocol/sandbox-types.js';
import type { ProjectSandboxes } from '../sandboxes/project-sandboxes.js';
import type { WorkspaceTarget } from '../sandboxes/types.js';
import type { SandboxArchiveStorage } from '../sandboxes/archive-storage.js';
import { archiveSandboxFiles, restoreSandboxFiles } from '../sandboxes/migrate-files.js';
import { HttpError } from '../../util/errors.js';

export interface SandboxRestoreOptions {
  id: string;
  onSandbox: (sandbox: SandboxState) => Promise<void>;
  onProgress: (phase: 'preparing' | 'restoring' | 'verifying', target?: SandboxState) => Promise<void>;
  beforeReplace?: (candidate: SandboxState) => Promise<void>;
}

/** Produces a durable, portable archive without replacing or deleting the source. */
export async function archiveSandbox(
  target: WorkspaceTarget, threadIds: string[], onSandbox: SandboxRestoreOptions['onSandbox'],
  sandboxes: ProjectSandboxes, storage: SandboxArchiveStorage,
): Promise<SandboxDataArchive> {
  if (!target.sandbox) throw new HttpError(409, '项目还没有沙箱');
  sandboxes.track(target, onSandbox);
  if ((await sandboxes.inspect(target)).usageIds.length) throw new HttpError(409, '沙箱仍有活动操作或未确认结束的任务，请稍后重试');
  const signal = AbortSignal.timeout(45 * 60_000);
  const lease = await sandboxes.acquire(target, { signal });
  let archive!: SandboxDataArchive;
  try {
    archive = {
      ...await archiveSandboxFiles(lease.sandbox, target.settings.workingDirectory, threadIds, storage, signal),
      sourceProjectId: target.projectId ?? target.id,
      sourceTemplate: lease.record.template,
    };
  } catch (error) {
    await lease.release().catch(() => {});
    throw error;
  }
  try {
    await lease.release();
  } catch (error) {
    // The caller cannot persist an archive it did not receive. Remove it so a
    // release persistence failure does not leave an unreachable stored object.
    await storage.delete(archive).catch(() => {});
    throw error;
  }
  return archive;
}

/** Creates from the current template and restores only the stored archive.
 * No connection to the previous sandbox is needed, even if it no longer exists.
 */
export async function restoreSandbox(
  target: WorkspaceTarget, archive: SandboxDataArchive, options: SandboxRestoreOptions, sandboxes: ProjectSandboxes,
  connection: ConnectionOpts, storage: SandboxArchiveStorage,
  prepareAndVerify: (lease: SandboxLease, signal: AbortSignal) => Promise<void>,
) {
  if (archive.workingDirectory !== target.settings.workingDirectory) throw new HttpError(409, '归档工作目录与项目不一致');
  sandboxes.track(target, options.onSandbox);
  const candidateManager = new E2BSandboxManager({ connection });
  const signal = AbortSignal.timeout(45 * 60_000);
  let candidate: SandboxLease | undefined;
  let phase: 'restoring' | 'verifying' = 'restoring';
  const state = (lease: SandboxLease): SandboxState => ({
    id: lease.record.id, template: lease.record.template, status: 'ready',
    workingDirectory: archive.workingDirectory, lastActiveAt: lease.record.lastActiveAt,
  });
  try {
    candidate = await candidateManager.acquire(`restore:${options.id}`, {
      usageId: options.id, purpose: 'restore', signal,
      create: { template: sandboxes.getDefaultTemplate(), metadata: { app: 'codex-web', operationId: options.id } },
      persist: async record => options.onProgress(phase, {
        id: record.id, template: record.template, status: 'ready', workingDirectory: archive.workingDirectory, lastActiveAt: record.lastActiveAt,
      }),
    });
    await restoreSandboxFiles(candidate.sandbox, archive, storage, signal);
    phase = 'verifying';
    await options.onProgress(phase, state(candidate));
    await prepareAndVerify(candidate, signal);
    await candidate.release();
    // No candidate callbacks may run after the authoritative project cutover.
    await candidateManager.close();
    const replacement = state(candidate);
    await options.beforeReplace?.(replacement);
    await sandboxes.replace(target, replacement);
  } finally {
    try { await candidate?.release(); }
    finally { await candidateManager.close(); }
  }
}

const missingSandbox = (error: unknown) => error instanceof SandboxNotFoundError;

function applicationOwned(
  sandboxId: string,
  metadata: Record<string, string> | undefined,
  provenance?: SandboxDataArchive,
) {
  if (metadata?.app === 'codex-web') return true;
  if (metadata?.app !== undefined) return false;
  return provenance?.format === 'codex-workspace-v1'
    && provenance.sourceSandboxId === sandboxId
    && typeof provenance.sourceProjectId === 'string'
    && provenance.sourceProjectId.length > 0
    && metadata?.projectId === provenance.sourceProjectId;
}

/** Pause an application-owned dangling sandbox without attaching it to a project. */
export async function pauseDanglingSandbox(
  sandboxId: string, connection: ConnectionOpts, provenance?: SandboxDataArchive,
) {
  let info;
  try { info = await Sandbox.getInfo(sandboxId, connection); }
  catch (error) { if (missingSandbox(error)) return; throw error; }
  if (!applicationOwned(sandboxId, info.metadata, provenance)) throw new HttpError(403, '只能管理本平台创建的悬挂沙箱');
  if (info.state === 'paused') return;
  try { await Sandbox.pause(sandboxId, connection); }
  catch (error) { if (!missingSandbox(error)) throw error; }
}

/** The application checks live references before invoking this fresh provider check. */
export async function deleteDanglingSandbox(
  sandboxId: string, connection: ConnectionOpts, provenance?: SandboxDataArchive,
) {
  let info;
  try { info = await Sandbox.getInfo(sandboxId, connection); }
  catch (error) { if (missingSandbox(error)) return; throw error; }
  if (!applicationOwned(sandboxId, info.metadata, provenance)) throw new HttpError(403, '只能清理本平台创建的悬挂沙箱');
  try { await Sandbox.kill(sandboxId, connection); }
  catch (error) { if (!missingSandbox(error)) throw error; }
}
