import { randomUUID } from 'node:crypto';
import type { SandboxManager, SandboxLease, SandboxRecord } from '@co-cell/sandbox';
import type { SandboxState } from '../../protocol/sandbox-types.js';
import type { WorkspaceTarget } from './types.js';

export type SaveSandbox = (state: SandboxState) => Promise<void>;
type Binding = {
  workingDirectory: string;
  save?: SaveSandbox;
  persist: (record: SandboxRecord) => Promise<void>;
};

const resourceKey = (target: WorkspaceTarget) => target.projectId ? `project:${target.projectId}` : `session:${target.id}`;

/** Adapts project-owned records without exposing projects to the sandbox package. */
export class ProjectSandboxes {
  private bindings = new Map<string, Binding>();

  constructor(readonly manager: SandboxManager, private template: string) {}

  get templateReference() { return this.template; }

  async replace(target: WorkspaceTarget, replacement: SandboxState) {
    const binding = this.track(target);
    const { workingDirectory: _directory, image, ...record } = replacement;
    const managerRecord = { ...record, ...(image ? { templateIdentity: structuredClone(image) } : {}) };
    if (target.sandbox) {
      await this.manager.replace(resourceKey(target), target.sandbox.id, managerRecord);
    } else {
      if (!binding.save) throw new Error('项目沙箱的持久化入口尚未配置');
      await this.manager.bind(resourceKey(target), managerRecord, binding.persist);
    }
    target.sandbox = structuredClone(replacement);
  }

  /** Detach the project binding while leaving its remote sandbox running. */
  async detach(target: WorkspaceTarget) {
    if (!target.sandbox) return;
    this.track(target);
    await this.manager.untrack(resourceKey(target), target.sandbox.id);
  }

  private project(record: SandboxRecord, workingDirectory: string): SandboxState {
    return {
      id: record.id, template: record.template, workingDirectory,
      ...(record.templateIdentity ? { image: structuredClone(record.templateIdentity) } : {}),
      status: record.status === 'deleted' ? 'unavailable' : record.status,
      ...(record.lastActiveAt ? { lastActiveAt: record.lastActiveAt } : {}),
      ...(record.pausedAt ? { pausedAt: record.pausedAt } : {}),
    };
  }

  track(target: WorkspaceTarget, save?: SaveSandbox) {
    const key = resourceKey(target);
    const tracked = this.manager.peek(key);
    if (!target.sandbox && tracked) {
      throw new Error('项目已无沙箱引用，但运行时仍跟踪旧沙箱，请先完成解绑');
    }
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
      const { image, ...persisted } = record;
      const activeAt = Date.parse(record.lastActiveAt ?? target.updatedAt);
      this.manager.track(key, {
        ...persisted,
        ...(image ? { templateIdentity: structuredClone(image) } : {}),
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
        metadata: {
          app: 'codex-web', sessionId: target.id, workingDirectory: target.settings.workingDirectory,
          ...(target.projectId ? { projectId: target.projectId } : {}),
        },
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
    const record = this.manager.peek(resourceKey(target));
    if (!record) return;
    await this.manager.destroy(resourceKey(target));
    await this.manager.untrack(resourceKey(target), record.id);
    this.bindings.delete(resourceKey(target));
  }

  async close() { await this.manager.close(); }
}
