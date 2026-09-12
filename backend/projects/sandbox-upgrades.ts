import { randomUUID } from 'node:crypto';
import type { SandboxCleanupRecord, SandboxDataArchive } from '../../protocol/sandbox-types.js';
import type { Project } from '../../protocol/types.js';
import type { E2BRuntime } from '../execution/e2b-runtime.js';
import type { WorkspaceTarget } from '../sandboxes/types.js';
import type { ProjectService } from './service.js';
import { HttpError } from '../../util/errors.js';

export type SandboxDataOperation = 'archive' | 'restore' | 'upgrade' | 'reclaim';

export interface SandboxCleanupScheduler {
  schedule(sandboxId: string, reason: SandboxCleanupRecord['reason'], archive?: SandboxDataArchive): Promise<SandboxCleanupRecord>;
  list(): Promise<SandboxCleanupRecord[]>;
  sweep?(): Promise<void>;
}

export interface ProjectSandboxUpgradeOptions {
  cleanup?: SandboxCleanupScheduler;
  onReclaimed?: (projectId: string) => void | Promise<void>;
}

/** Archiving and restoring are independent operations. Upgrade composes both. */
export class ProjectSandboxUpgrades {
  private tasks = new Map<string, Promise<void>>();
  private closing = false;

  constructor(private projects: ProjectService, private runtime?: E2BRuntime,
    private options: ProjectSandboxUpgradeOptions = {}) {}

  private async deleteSupersededArchive(previous: SandboxDataArchive | undefined, replacement: SandboxDataArchive) {
    if (!previous || previous.key === replacement.key) return;
    let retained = false;
    if (this.options.cleanup) {
      try { retained = (await this.options.cleanup.list()).some(record => record.archive?.key === previous.key); }
      catch (error) {
        // An unavailable cleanup journal means ownership is unknown. Keep the
        // object; a later maintenance pass can safely collect it.
        console.error('Sandbox cleanup journal read failed:', error instanceof Error ? error.message : 'unknown error');
        return;
      }
    }
    if (retained) return;
    await this.runtime!.deleteDataArchive?.(previous).catch(() => {
      console.error('Superseded sandbox data archive cleanup failed:', previous.key);
    });
  }

  async start(id: string, kind: SandboxDataOperation, threadIds: string[], checkpoint: string,
    onSandbox: (value: NonNullable<Project['sandbox']>) => Promise<void>): Promise<void> {
    if (this.closing) throw new HttpError(503, '服务正在关闭');
    const project = this.projects.get(id);
    if (!this.runtime || project.executionMode !== 'e2b'
      || (kind !== 'restore' && !this.runtime.archiveSandbox)
      || ((kind === 'restore' || kind === 'upgrade') && !this.runtime.restoreSandbox)
      || (kind === 'reclaim' && (!this.runtime.detachSandbox || !this.options.cleanup))) {
      throw new HttpError(400, '此项目不支持数据归档、复原或环境回收');
    }
    if (kind !== 'restore' && !project.sandbox) throw new HttpError(409, '项目还没有沙箱');
    if (kind === 'restore') {
      if (!project.sandboxDataArchive) throw new HttpError(409, '项目尚无可用的数据归档，请先归档');
      if (project.sandboxDataArchive.sessionCheckpoint !== checkpoint && (project.sandbox || !project.sandboxReclaimedAt)) {
        throw new HttpError(409, '归档后会话已变化，请重新归档再复原，避免对话记录与上下文不一致');
      }
    }
    const release = this.projects.beginMaintenance(id);
    const operationState: NonNullable<Project['sandboxUpgrade']> = {
      id: randomUUID(), kind, ...(project.sandbox ? { source: project.sandbox } : {}),
      phase: kind === 'restore' ? 'preparing' : 'archiving', startedAt: new Date().toISOString(),
    };
    const setup = this.projects.saveUpgrade(id, operationState);
    this.tasks.set(id, setup);
    try { await setup; }
    catch (error) { this.tasks.delete(id); release(); throw error; }
    const target: WorkspaceTarget = { id, projectId: id, settings: { workingDirectory: project.workingDirectory }, sandbox: project.sandbox, updatedAt: project.updatedAt };
    const operation = (async () => {
      try {
        let archive = project.sandboxDataArchive;
        if (kind !== 'restore') {
          const previous = archive;
          const created = await this.runtime!.archiveSandbox!(target, threadIds, onSandbox);
          archive = { ...created, sessionCheckpoint: checkpoint };
          try { await this.projects.saveDataArchive(id, archive); }
          catch (error) {
            await this.runtime!.deleteDataArchive?.(created).catch(() => {});
            throw error;
          }
          // Only discard a superseded object after its replacement is durable,
          // and never while it is the deletion credential for an old sandbox.
          await this.deleteSupersededArchive(previous, archive);
        }
        if (kind === 'archive') {
          await this.projects.saveUpgrade(id, undefined);
          return;
        }
        if (kind === 'reclaim') {
          const retired = operationState.source!;
          await this.options.cleanup!.schedule(retired.id, 'idle', archive);
          await this.runtime!.detachSandbox!(target);
          await this.projects.reclaimSandbox(id, retired.id);
          await this.options.onReclaimed?.(id);
          return;
        }
        operationState.phase = 'preparing';
        await this.projects.saveUpgrade(id, operationState);
        await this.runtime!.restoreSandbox!(target, archive!, {
          id: operationState.id, onSandbox,
          beforeReplace: async () => {
            const retired = operationState.source;
            // A restore archive from another environment cannot prove this
            // source is recoverable, so leave that source as an unknown dangling
            // sandbox instead of enrolling it in automatic deletion.
            if (retired && archive!.sourceSandboxId === retired.id) {
              await this.options.cleanup?.schedule(retired.id, 'upgrade', archive);
            }
          },
          onProgress: async (phase, candidate) => {
            operationState.phase = phase;
            if (candidate) operationState.target = candidate;
            await this.projects.saveUpgrade(id, operationState);
          },
        });
      } catch (error) {
        if (this.projects.get(id).sandbox?.id === operationState.source?.id) {
          operationState.phase = 'failed';
          operationState.error = error instanceof Error ? error.message : '数据归档或复原失败';
          await this.projects.saveUpgrade(id, operationState);
          const failedCandidate = operationState.target;
          if (failedCandidate && failedCandidate.id !== operationState.source?.id) {
            await this.options.cleanup?.schedule(failedCandidate.id, 'failed_restore');
          }
        }
      } finally {
        release();
        // isReferenced must observe the committed cutover without the
        // maintenance reservation before it pauses or deletes anything.
        void this.options.cleanup?.sweep?.().catch(error => {
          console.error('Scheduled sandbox cleanup sweep failed:', error instanceof Error ? error.message : 'unknown error');
        });
      }
    })();
    this.tasks.set(id, operation);
    void operation.catch(error => console.error('Sandbox data journal persistence failed:', error instanceof Error ? error.message : 'unknown error'))
      .finally(() => { if (this.tasks.get(id) === operation) this.tasks.delete(id); });
  }

  async wait(id: string): Promise<void> {
    while (this.tasks.has(id)) {
      const current = this.tasks.get(id)!;
      await current;
      // start() replaces its initial journal write with the full task. Let that
      // continuation and the task-removal callback publish the next map value.
      await new Promise<void>(resolve => setImmediate(resolve));
    }
  }

  async close() {
    this.closing = true;
    // A start may still be saving its initial journal when shutdown begins.
    // Wait for the full task that replaces that initial write in the map.
    while (this.tasks.size) await Promise.allSettled(this.tasks.values());
  }
}
