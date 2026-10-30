import { SandboxLifecycle, type SandboxHandle, type SandboxInfo, type SandboxLifecycleContext, type SandboxProvider, type SandboxRecord } from '@co-cell/sandbox';
import { randomUUID } from 'node:crypto';
import type { SandboxState } from '../../protocol/sandbox-types.js';
import type { ProjectImageSelection } from '../../protocol/image-types.js';
import type { WorkspaceTarget } from './types.js';
import { HttpError } from '../../util/errors.js';

export type SaveSandbox = (state: SandboxState) => Promise<void>;
type ProjectReference = Pick<WorkspaceTarget, 'sandbox' | 'imageSelection' | 'sandboxMounts' | 'sandboxOwnerKey'>;
export interface ProjectSandboxAccess {
  sandbox: SandboxHandle;
  info: SandboxInfo;
  record: SandboxRecord;
}
const resourceKey = (target: WorkspaceTarget) => target.projectId ? `project:${target.projectId}` : `session:${target.id}`;

/** Reads the durable project reference for each operation; never retains bindings or handles. */
export class ProjectSandboxes {
  constructor(private provider: SandboxProvider, private template: string, private defaultTemplateId?: string,
    readonly lifecycle = new SandboxLifecycle(), private readProject?: (id: string) => Promise<ProjectReference | undefined>,
    private latestImage?: (target: WorkspaceTarget) => Promise<ProjectImageSelection | undefined>) {}

  get templateReference() { return this.template; }

  async refresh(target: WorkspaceTarget) {
    if (!target.projectId || !this.readProject) return;
    const project = await this.readProject(target.projectId);
    if (!project) throw new HttpError(404, '项目不存在');
    for (const key of ['sandbox', 'imageSelection', 'sandboxMounts', 'sandboxOwnerKey'] as const)
      Object.assign(target, { [key]: structuredClone(project[key]) });
  }

  private project(target: WorkspaceTarget, info: SandboxInfo, lastActiveAt?: string): SandboxState {
    const phase = info.metadata?.phase;
    return {
      id: info.sandboxId, template: target.sandbox?.template ?? this.template,
      workingDirectory: target.sandbox?.workingDirectory ?? target.settings.workingDirectory,
      status: info.state === 'running' ? 'ready' : info.state === 'paused' ? 'paused' : 'unavailable',
      ...(info.metadata?.ownerKey ? { ownerKey: info.metadata.ownerKey } : {}),
      ...(info.mounts ? { mounts: structuredClone(info.mounts) } : {}),
      ...(info.homeVolumeId ? { homeVolumeId: info.homeVolumeId } : {}),
      ...(info.templateIdentity ? { image: structuredClone(info.templateIdentity) } : {}),
      ...(lastActiveAt ? { lastActiveAt } : {}),
      ...(phase ? { phase } : {}),
    };
  }
  private record(state: SandboxState): SandboxRecord {
    const { workingDirectory: _directory, image, ...record } = state;
    return { ...record, status: state.status === 'unknown' ? 'unavailable' : state.status,
      ...(image ? { templateIdentity: structuredClone(image) } : {}) };
  }

  async acquire(target: WorkspaceTarget, options: { create?: boolean; replaceMissing?: boolean; save?: SaveSandbox; signal?: AbortSignal } = {}): Promise<ProjectSandboxAccess> {
    options.signal?.throwIfAborted();
    await this.refresh(target);
    options.signal?.throwIfAborted();
    if (options.create && options.replaceMissing && target.sandbox && !target.sandbox.creation) {
      try {
        if ((await this.provider.getInfo(target.sandbox.id)).metadata?.phase === 'deleted') target.sandbox = undefined;
      } catch (error) {
        if ((error as { code?: string }).code !== 'NOT_FOUND') throw error;
        target.sandbox = undefined;
      }
    }
    if (!target.sandbox && !options.create) throw new HttpError(409, '项目没有 Sandbox，请先创建');
    if ((!target.sandbox || options.create && target.sandbox.creation) && !options.save) throw new Error('项目沙箱的持久化入口尚未配置');
    if (!target.sandbox && target.imageSelection && !target.imageSelection.templateId)
      throw new Error('项目仍引用旧导入镜像，请先迁移为 Cellbox template。');
    const creating = !target.sandbox || Boolean(options.create && target.sandbox.creation);
    const context: SandboxLifecycleContext = { action: creating ? 'create' : 'connect', resourceKey: resourceKey(target),
      sandboxId: target.sandbox?.id, signal: options.signal,
      metadata: { ...(target.projectId ? { projectId: target.projectId } : {}), sessionId: target.id } };
    return this.lifecycle.run(context, async () => {
      let sandbox: SandboxHandle;
      if (creating) {
        let metadata = target.sandbox?.creation?.metadata;
        if (!metadata) {
          // Resolve once per creation attempt, before persisting its immutable parameters.
          const selection = await this.latestImage?.(target)
            ?? (target.imageSelection?.revisionId ? target.imageSelection : undefined);
          if (selection && (!selection.templateId || !selection.revisionId)) throw new Error('最新镜像缺少 Cellbox revision');
          const templateId = target.imageSelection?.templateId ?? this.defaultTemplateId;
          metadata = { ...context.metadata, app: 'codex-web', workingDirectory: target.settings.workingDirectory,
            ...(target.sandboxOwnerKey ? { cellboxOwnerKey: target.sandboxOwnerKey } : {}),
            ...(target.sandboxMounts?.length ? { cellboxMounts: JSON.stringify(target.sandboxMounts) } : {}),
            ...(selection ? { cellboxRevisionId: selection.revisionId! }
              : templateId ? { cellboxTemplateId: templateId } : {}) };
          if (this.provider.prepareCreate) {
            metadata = await this.provider.prepareCreate(this.template, metadata);
            const initial: SandboxState = { id: `box-${randomUUID()}`, template: this.template, status: 'starting',
              workingDirectory: target.settings.workingDirectory, ownerKey: metadata.cellboxOwnerKey,
              ...(target.sandboxMounts?.length ? { mounts: structuredClone(target.sandboxMounts) } : {}),
              creation: { metadata: structuredClone(metadata) } };
            // The save callback must reject a lost binding race. No remote resource
            // is created until the ID and request have committed together.
            await options.save!(initial);
            target.sandbox = initial;
            context.sandboxId = initial.id;
          }
        }
        const pending = target.sandbox;
        options.signal?.throwIfAborted();
        sandbox = await this.provider.create(pending?.template ?? this.template, {
          ...(pending?.creation ? { sandboxId: pending.id,
            beforeCreate: async () => {
              const previous = target.sandbox!.creation!;
              const next: SandboxState = { ...target.sandbox!, creation: { metadata: previous.metadata,
                attempt: (previous.attempt ?? 0) + 1,
                uncertain: previous.uncertain || Boolean(previous.attempt && !previous.rejected) } };
              await options.save!(next);
              target.sandbox = next;
            },
            createRejected: async () => {
              if (target.sandbox!.creation!.uncertain) return;
              const next = { ...target.sandbox!, creation: { ...target.sandbox!.creation!, rejected: true } };
              await options.save!(next);
              target.sandbox = next;
            },
          } : {}),
          timeoutMs: 120_000, lifecycle: { onTimeout: 'pause', autoResume: false }, metadata,
        });
        if (pending?.creation && sandbox.sandboxId !== pending.id) throw new Error('Sandbox 返回的 ID 与已保存的创建请求不一致');
        context.sandboxId = sandbox.sandboxId;
        if (!pending?.creation) {
          // Compatibility for providers without caller-selected resource IDs.
          const initial: SandboxState = { id: sandbox.sandboxId, template: this.template, status: 'starting',
            workingDirectory: target.settings.workingDirectory };
          try { await options.save!(initial); }
          catch (error) {
            if (error instanceof Error) Object.assign(error, { sandboxId: sandbox.sandboxId });
            throw error;
          }
          target.sandbox = initial;
        }
      } else {
        sandbox = await this.provider.connect(target.sandbox!.id, { timeoutMs: 120_000, signal: options.signal });
      }
      const info = await this.provider.getInfo(sandbox.sandboxId);
      options.signal?.throwIfAborted();
      const state = this.project(target, info, new Date().toISOString());
      await options.save?.(state);
      target.sandbox = state;
      const record = this.record(state);
      Object.assign(context, { sandbox, sandboxId: sandbox.sandboxId, observation: info, record,
        metadata: { ...context.metadata, ...info.metadata } });
      return { sandbox, info, record };
    });
  }

  async inspect(target: WorkspaceTarget) {
    await this.refresh(target);
    if (!target.sandbox) throw new HttpError(409, '项目没有 Sandbox');
    const info = await this.provider.getInfo(target.sandbox.id);
    return { record: this.record(this.project(target, info)), info };
  }

  async delete(target: WorkspaceTarget) {
    await this.refresh(target);
    if (!target.sandbox) return;
    const sandboxId = target.sandbox.id;
    await this.lifecycle.run({ action: 'destroy', resourceKey: resourceKey(target), sandboxId }, async () => {
      try {
        if (this.provider.ensureDeleted) await this.provider.ensureDeleted(sandboxId);
        else await this.provider.kill(sandboxId);
      } catch (error) {
        if (!['NOT_FOUND', 'not_found'].includes((error as { code?: string }).code ?? '')) throw error;
        if (target.sandbox?.creation?.attempt && !target.sandbox.creation.rejected)
          throw Object.assign(new HttpError(409, '创建结果尚未确认，请重试创建后再释放此 Sandbox'), { code: 'UNKNOWN_OUTCOME' });
      }
    });
  }
}
