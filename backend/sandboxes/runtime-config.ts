import { createHash } from 'node:crypto';
import type { SandboxExtension, SandboxLifecycleContext } from '@co-cell/sandbox';
import type { CellboxSandboxProvider } from '../../packages/sandbox/src/providers/cellbox/index.js';
import { CellboxError } from '../../packages/sandbox/src/providers/cellbox/index.js';
import type { ConnectionStore } from '../connections/store.js';
import type { SecretService } from '../secrets/service.js';
import type { ToolRuntimeConfig } from '../../protocol/secret-types.js';
import type { RuntimeLog } from '../infra/diagnostics/runtime-log.js';
import { mountedRuntime } from './mounted-runtime.js';

export interface SandboxRuntimeConfigOptions {
  provider: CellboxSandboxProvider;
  connections?: ConnectionStore;
  credentialSlots?: Record<string, string>;
  secrets?: SecretService;
  toolBrokerUrl?: string;
  logger?: RuntimeLog;
  /** CoCell's writable view of the same directory mounted read-only by the Box. */
  sharedDataRoot?: string;
}

/** Distributes protected configuration only at lifecycle boundaries. */
export class SandboxRuntimeConfig {
  private readonly pending = new Map<string, Promise<void>>();
  private readonly legacyDigests = new Map<string, Record<string, string>>();
  private readonly legacyGuests = new Set<string>();
  readonly extension: SandboxExtension = {
    name: 'runtime-config',
    pre: async context => { if (context.action === 'activate') await this.sync(context); },
    post: async context => {
      if (['create', 'connect', 'restore', 'reconcile'].includes(context.action)) await this.sync(context);
      if (context.action === 'destroy' && context.sandboxId) {
        await this.options.secrets?.repository.forgetRuntime(context.sandboxId);
        if (this.options.sharedDataRoot) await mountedRuntime(this.options.sharedDataRoot, context.sandboxId).remove();
        this.legacyGuests.delete(context.sandboxId);
        for (const key of this.legacyDigests.keys()) if (key.startsWith(`${context.sandboxId}:`)) this.legacyDigests.delete(key);
      }
    },
  };
  constructor(private readonly options: SandboxRuntimeConfigOptions) {}

  /** OSS credentials are only needed at archive boundaries, never at startup. */
  ensureArchiveCredentials(boxId: string) {
    return this.sync({ action: 'connect', resourceKey: `sandbox:${boxId}`, sandboxId: boxId }, true);
  }

  private async sync(context: Readonly<SandboxLifecycleContext>, archive = false) {
    const boxId = context.sandboxId;
    if (!boxId) throw new Error('Sandbox identity is required for runtime configuration');
    const previous = this.pending.get(boxId) ?? Promise.resolve();
    const startedAt = new Date().toISOString(), started = performance.now();
    const current = previous.catch(() => {}).then(() => this.apply(boxId, context, archive));
    this.pending.set(boxId, current);
    let status = 'succeeded';
    try { await current; } catch (error) { status = 'failed'; throw error; }
    finally {
      if (this.pending.get(boxId) === current) this.pending.delete(boxId);
      void this.options.logger?.write({ event: 'sandbox.runtime_stage', phase: archive ? 'archive.credentials' : 'runtime.credentials', sandboxId: boxId,
        status, startedAt, finishedAt: new Date().toISOString(), durationMs: Math.round(performance.now() - started) });
    }
  }

  private async apply(boxId: string, context: Readonly<SandboxLifecycleContext>, archive: boolean) {
    const box = await this.options.provider.client.getBox(boxId);
    if (!box.capabilities.protectedTools) return;
    if (box.phase !== 'running' && box.phase !== 'staged') throw new Error(`Cannot configure Cellbox in phase ${box.phase}`);
    const generation = box.generation;
    const repository = this.options.secrets?.repository;
    const previous = await repository?.runtime(boxId);
    // The provisioning revision survives execution changes. The legacy SQL
    // generation column stores it; Cellbox's live generation still fences writes.
    const revision = previous?.generation ?? generation;
    const mount = !archive && this.options.secrets && this.options.sharedDataRoot && box.capabilities.mountedToolRuntime
      ? mountedRuntime(this.options.sharedDataRoot, boxId) : undefined;
    let previousPointer: string | undefined;
    let slots: Record<string, Uint8Array>;
    let applied: Record<string, string>;
    if (this.options.secrets) {
      applied = await repository!.runtimeConfig(boxId, revision);
      slots = {};
      if (archive) {
        slots = {
          cocell_oss_access_key: Buffer.from(process.env.OSS_ACCESS_KEY || '\n'),
          cocell_oss_secret_key: Buffer.from(process.env.OSS_SECRET_KEY || '\n'),
        };
      } else {
        if (mount) previousPointer = applied.cocell_tool_runtime_mount;
        const projectId = context.metadata?.projectId
          ?? (context.resourceKey.startsWith('project:') ? context.resourceKey.slice('project:'.length) : previous?.projectId);
        if (!projectId) throw new Error('Project identity is required for tool credentials');
        if (!this.options.toolBrokerUrl) throw new Error('COCELL_TOOL_BROKER_URL is required');
        if (!previous || previous.projectId !== projectId) await this.options.secrets.registerRuntime(boxId, projectId, revision);
        // Connecting or restarting the service must not replace an existing
        // file snapshot after a resource was removed centrally.
        if (!['connect', 'reconcile'].includes(context.action) || !applied.cocell_tool_runtime) {
          const config: ToolRuntimeConfig = { mode: 'files', boxId, revision, url: this.options.toolBrokerUrl, files: await this.options.secrets.provision(projectId),
            // Compatibility with checkpointed older runners; no authentication.
            generation: revision, token: boxId };
          const bytes = Buffer.from(JSON.stringify(config));
          if (bytes.length > 1024 * 1024) throw new Error('Selected credential files exceed the 1 MiB Sandbox configuration limit');
          slots = { cocell_tool_runtime: bytes };
        } else if (mount) {
          // A service restart must retain the mounted snapshot even after a
          // centrally selected resource was deleted.
          const bytes = await mount.read();
          if (createHash('sha256').update(bytes).digest('hex') !== applied.cocell_tool_runtime)
            throw new Error('Mounted runtime configuration differs from its acknowledged snapshot');
        }
      }
    } else {
      slots = await this.legacySlots(archive);
      const key = `${boxId}:${generation}`;
      applied = this.legacyDigests.get(key) ?? {};
      this.legacyDigests.set(key, applied);
    }
    const digests = Object.fromEntries(Object.entries(slots).map(([slot, bytes]) => [slot, createHash('sha256').update(bytes).digest('hex')]));
    const changed = Object.fromEntries(Object.entries(slots).filter(([slot]) => applied[slot] !== digests[slot]));
    let pointerDigest: string | undefined;
    if (mount && slots.cocell_tool_runtime) {
      await mount.publish(slots.cocell_tool_runtime);
      const pointer = Buffer.from(JSON.stringify(mount.descriptor));
      pointerDigest = createHash('sha256').update(pointer).digest('hex');
      // The descriptor is unchanged by checkpoint/resume and survives in the
      // restored filesystem. Ordinary resume does not touch either file.
      if (previousPointer === pointerDigest) delete changed.cocell_tool_runtime;
      else changed.cocell_tool_runtime = pointer;
      if ((await this.options.provider.client.getBox(boxId)).generation !== generation)
        throw new Error('Cellbox generation changed during runtime configuration');
    }
    if (!Object.keys(changed).length && !pointerDigest) return;
    const acknowledge = async () => {
      const acknowledged = { ...digests, ...(pointerDigest ? { cocell_tool_runtime_mount: pointerDigest } : {}) };
      if (repository) await repository.markRuntimeConfigs(boxId, revision, acknowledged);
      Object.assign(applied, acknowledged);
    };
    if (!Object.keys(changed).length) { await acknowledge(); return; }
    if (box.capabilities.credentialBatch && !this.legacyGuests.has(boxId)) {
      try {
        await this.options.provider.client.writeCredentials(boxId, generation, changed);
      } catch (error) {
        // An older Guest image can coexist briefly with the new API during rollout.
        if (!(error instanceof CellboxError && error.code === 'NOT_FOUND')) throw error;
        this.legacyGuests.add(boxId);
      }
      if (!this.legacyGuests.has(boxId)) {
        await acknowledge();
        return;
      }
    }
    for (const [slot, bytes] of Object.entries(changed)) {
      const digest = digests[slot];
      await this.options.provider.client.writeCredential(boxId, slot, bytes);
      // Do not acknowledge a write against a generation that changed mid-sync.
      if ((await this.options.provider.client.getBox(boxId)).generation !== generation)
        throw new Error('Cellbox generation changed during runtime configuration');
      if (!mount) {
        if (repository) await repository.markRuntimeConfig(boxId, revision, slot, digest);
        applied[slot] = digest;
      }
    }
    if (mount) await acknowledge();
  }

  private async legacySlots(archive: boolean): Promise<Record<string, Uint8Array>> {
    const oss = new Set(['__ossAccessKey', '__ossSecretKey']);
    const mapping = Object.fromEntries(Object.entries(this.options.credentialSlots ?? {}).filter(([source]) => oss.has(source) === archive));
    if (!Object.keys(mapping).length || !this.options.connections) return {};
    const bundle = await this.options.connections.readRuntimeBundle();
    const files: Record<string, Uint8Array> = {
      'glab/config.yml': Buffer.from(bundle?.glabConfig ?? ''), 'gitconfig': Buffer.from(bundle?.gitConfig ?? ''),
      'git-credentials': Buffer.from(bundle?.gitCredentials ?? ''), '.mylogin.cnf': Buffer.from(bundle?.mysqlLogin ?? '', 'base64'),
      ...Object.fromEntries(Object.entries(bundle?.cliFiles ?? {}).map(([name, value]) => [name, Buffer.from(value, 'base64')])),
      __ossAccessKey: Buffer.from(process.env.OSS_ACCESS_KEY ?? ''),
      __ossSecretKey: Buffer.from(process.env.OSS_SECRET_KEY ?? ''),
      __mysqlLogin: Buffer.from(bundle?.mysqlLogin ?? '', 'base64'),
    };
    for (const [name, value] of Object.entries(bundle?.cliFiles ?? {})) {
      if (/^(kubernetes|meegle|lark-config|lark-data)\//.test(name)) files[`__${name.replaceAll('/', '_')}`] = Buffer.from(value, 'base64');
    }
    return Object.fromEntries(Object.entries(mapping).map(([source, slot]) => {
      if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(slot)) throw new Error('Invalid Cellbox credential slot mapping');
      const value = files[source];
      return [slot, value?.byteLength ? value : Buffer.from('\n')];
    }));
  }
}
