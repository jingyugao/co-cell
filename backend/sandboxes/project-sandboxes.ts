import { randomUUID } from 'node:crypto';
import type { E2BSandboxManager, SandboxLease, SandboxRecord } from '@swarm-hive/sandbox';
import type { SandboxState } from '../../protocol/sandbox-types.js';
import type { WorkspaceTarget } from './types.js';

export type SaveSandbox = (state: SandboxState) => Promise<void>;
type Binding = {
  workingDirectory: string;
  save?: SaveSandbox;
  persist: (record: SandboxRecord) => Promise<void>;
};

const resourceKey = (target: WorkspaceTarget) => target.projectId ? `project:${target.projectId}` : `session:${target.id}`;

/** Adapts legacy project-owned records without exposing projects to the sandbox package. */
export class ProjectSandboxes {
  private bindings = new Map<string, Binding>();

  constructor(readonly manager: E2BSandboxManager, private template: string) {}

  setDefaultTemplate(template: string) { this.template = template; }

  private project(record: SandboxRecord, workingDirectory: string): SandboxState {
    return {
      id: record.id, template: record.template, workingDirectory,
      status: record.status === 'deleted' ? 'unavailable' : record.status,
      ...(record.lastActiveAt ? { lastActiveAt: record.lastActiveAt } : {}),
      ...(record.pausedAt ? { pausedAt: record.pausedAt } : {}),
      ...(record.archive ? { archive: structuredClone(record.archive) } : {}),
    };
  }

  track(target: WorkspaceTarget, save?: SaveSandbox) {
    const key = resourceKey(target);
    const tracked = this.manager.peek(key);
    if (target.sandbox && tracked && target.sandbox.id !== tracked.id) {
      throw new Error('项目沙箱引用不一致，请重新加载项目后重试');
    }
    let binding = this.bindings.get(key);
    if (!binding) {
      binding = {
        workingDirectory: target.settings.workingDirectory, save,
        // The callback identity is stable for this resource, independent of the
        // session that happens to use it. Project/session fanout stays upstream.
        persist: async record => {
          const current = this.bindings.get(key)!;
          await current.save?.(this.project(record, current.workingDirectory));
        },
      };
      this.bindings.set(key, binding);
    } else {
      binding.save ??= save;
      binding.workingDirectory = target.settings.workingDirectory;
    }
    if (target.sandbox && !tracked) {
      const { workingDirectory: _directory, ...record } = target.sandbox;
      const activeAt = Date.parse(record.lastActiveAt ?? target.updatedAt);
      this.manager.track(key, {
        ...record,
        lastActiveAt: new Date(Number.isFinite(activeAt) ? activeAt : Date.now()).toISOString(),
      }, binding.persist);
    }
    return binding;
  }

  async acquire(target: WorkspaceTarget, options: {
    create?: boolean;
    save?: SaveSandbox;
    usageId?: string;
    signal?: AbortSignal;
  } = {}): Promise<SandboxLease> {
    const binding = this.track(target, options.save);
    if (options.create && !binding.save) throw new Error('项目沙箱的持久化入口尚未配置');
    const key = resourceKey(target);
    const lease = await this.manager.acquire(key, {
      usageId: options.usageId ?? randomUUID(),
      purpose: options.usageId ? 'execution' : 'workspace',
      signal: options.signal,
      persist: binding.persist,
      ...(options.create ? { create: {
        template: this.template,
        metadata: { app: 'codex-web', sessionId: target.id, ...(target.projectId ? { projectId: target.projectId } : {}) },
      } } : {}),
    });
    target.sandbox = this.project(lease.record, binding.workingDirectory);
    return lease;
  }

  async inspect(target: WorkspaceTarget) {
    this.track(target);
    return this.manager.inspect(resourceKey(target));
  }

  holdUsage(target: WorkspaceTarget, usageId: string) {
    this.track(target);
    this.manager.holdUsage(resourceKey(target), usageId);
  }

  async delete(target: WorkspaceTarget) {
    this.track(target);
    if (!this.manager.peek(resourceKey(target))) return;
    await this.manager.destroy(resourceKey(target));
  }

  async close() { await this.manager.close(); }
}
