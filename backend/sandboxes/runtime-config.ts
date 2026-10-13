import { createHash } from 'node:crypto';
import type { SandboxExtension, SandboxLifecycleContext } from '@co-cell/sandbox';
import type { CellboxSandboxProvider } from '../../packages/sandbox/src/providers/cellbox/index.js';
import { CellboxError } from '../../packages/sandbox/src/providers/cellbox/index.js';
import type { ConnectionStore } from '../connections/store.js';
import type { SecretService } from '../secrets/service.js';
import type { ToolHomeRuntimeConfig, ToolRuntimeConfig } from '../../protocol/secret-types.js';
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

function assertActive(signal?: AbortSignal) {
  if (signal?.aborted) throw signal.reason ?? new DOMException('Lifecycle operation aborted', 'AbortError');
}

function awaitActive<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  assertActive(signal);
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', abort);
    const abort = () => { cleanup(); reject(signal.reason ?? new DOMException('Lifecycle operation aborted', 'AbortError')); };
    signal.addEventListener('abort', abort, { once: true });
    promise.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    if (signal.aborted) abort();
  });
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
        assertActive(context.signal);
        await this.options.secrets?.repository.forgetRuntime(context.sandboxId);
        assertActive(context.signal);
        if (this.options.sharedDataRoot) {
          await mountedRuntime(this.options.sharedDataRoot, context.sandboxId).remove();
          assertActive(context.signal);
        }
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
    assertActive(context.signal);
    const previous = this.pending.get(boxId) ?? Promise.resolve();
    const startedAt = new Date().toISOString(), started = performance.now();
    const current = previous.catch(() => {}).then(() => {
      assertActive(context.signal);
      return this.apply(boxId, context, archive);
    });
    this.pending.set(boxId, current);
    // Keep the serialized queue attached to current even if this caller stops
    // waiting. A later lifecycle action must not overtake an in-flight write.
    void current.finally(() => { if (this.pending.get(boxId) === current) this.pending.delete(boxId); }).catch(() => {});
    let status = 'succeeded';
    try { await awaitActive(current, context.signal); } catch (error) { status = 'failed'; throw error; }
    finally {
      void this.options.logger?.write({ event: 'sandbox.runtime_stage', phase: archive ? 'archive.credentials' : 'runtime.credentials', sandboxId: boxId,
        status, startedAt, finishedAt: new Date().toISOString(), durationMs: Math.round(performance.now() - started) });
    }
  }

  private async apply(boxId: string, context: Readonly<SandboxLifecycleContext>, archive: boolean) {
    const signal = context.signal;
    assertActive(signal);
    const box = await this.options.provider.client.getBox(boxId, signal);
    assertActive(signal);
    if (!box.capabilities.protectedTools) return;
    if (box.phase !== 'running' && box.phase !== 'staged') throw new Error(`Cannot configure Cellbox in phase ${box.phase}`);
    const generation = box.generation;
    // Cold rebuild loses guest credential slots even though HOME and the stable
    // provisioning revision survive. A digest is not proof the slot still exists.
    const restoreRuntimeConfig = context.metadata?.restoreRuntimeConfig === 'true';
    const repository = this.options.secrets?.repository;
    const previous = await repository?.runtime(boxId);
    assertActive(signal);
    // The provisioning revision survives execution changes. The legacy SQL
    // generation column stores it; Cellbox's live generation still fences writes.
    const revision = previous?.generation ?? generation;
    const home = !archive && this.options.secrets?.homes && box.capabilities.mountedDebugHome;
    const mount = !archive && !home && this.options.secrets && this.options.sharedDataRoot && box.capabilities.mountedToolRuntime
      ? mountedRuntime(this.options.sharedDataRoot, boxId) : undefined;
    let previousPointer: string | undefined;
    let slots: Record<string, Uint8Array>;
    let applied: Record<string, string>;
    if (this.options.secrets) {
      applied = await repository!.runtimeConfig(boxId, revision);
      assertActive(signal);
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
        if (!previous || previous.projectId !== projectId) {
          assertActive(signal);
          await this.options.secrets.registerRuntime(boxId, projectId, revision);
          assertActive(signal);
        }
        if (!home) await repository!.prepareLegacyRuntime(boxId);
        if (home) {
          assertActive(signal);
          await this.options.secrets.publishHome(projectId);
          assertActive(signal);
          const config: ToolHomeRuntimeConfig = { mode: 'home', boxId, url: this.options.toolBrokerUrl };
          slots = { cocell_tool_runtime: Buffer.from(JSON.stringify(config)) };
        } else {
          // Existing images retain the delivery contract saved in their checkpoint.
          if (!['connect', 'reconcile'].includes(context.action) || !applied.cocell_tool_runtime || (restoreRuntimeConfig && !mount)) {
            const provisionedFiles = await this.options.secrets.provision(projectId);
            assertActive(signal);
            const config: ToolRuntimeConfig = { mode: 'files', boxId, revision, url: this.options.toolBrokerUrl, files: provisionedFiles,
              // Compatibility with checkpointed older runners; no authentication.
              generation: revision, token: boxId };
            const bytes = Buffer.from(JSON.stringify(config));
            if (bytes.length > 1024 * 1024) throw new Error('Selected credential files exceed the 1 MiB Sandbox configuration limit');
            slots = { cocell_tool_runtime: bytes };
          } else if (mount) {
            const bytes = await mount.read();
            assertActive(signal);
            if (createHash('sha256').update(bytes).digest('hex') !== applied.cocell_tool_runtime)
              throw new Error('Mounted runtime configuration differs from its acknowledged snapshot');
            if (restoreRuntimeConfig) slots = { cocell_tool_runtime: bytes };
          }
        }
      }
    } else {
      slots = await this.legacySlots(archive);
      assertActive(signal);
      const key = `${boxId}:${generation}`;
      applied = this.legacyDigests.get(key) ?? {};
      this.legacyDigests.set(key, applied);
    }
    const digests = Object.fromEntries(Object.entries(slots).map(([slot, bytes]) => [slot, createHash('sha256').update(bytes).digest('hex')]));
    const changed = Object.fromEntries(Object.entries(slots).filter(([slot]) => restoreRuntimeConfig || applied[slot] !== digests[slot]));
    let pointerDigest: string | undefined;
    if (mount && slots.cocell_tool_runtime) {
      assertActive(signal);
      await mount.publish(slots.cocell_tool_runtime);
      assertActive(signal);
      const pointer = Buffer.from(JSON.stringify(mount.descriptor));
      pointerDigest = createHash('sha256').update(pointer).digest('hex');
      // The descriptor is unchanged by checkpoint/resume and survives in the
      // restored filesystem. Ordinary resume does not touch either file.
      if (previousPointer === pointerDigest && !restoreRuntimeConfig) delete changed.cocell_tool_runtime;
      else changed.cocell_tool_runtime = pointer;
      if ((await this.options.provider.client.getBox(boxId, signal)).generation !== generation)
        throw new Error('Cellbox generation changed during runtime configuration');
      assertActive(signal);
    }
    const roleRuntime: Record<string, string> = archive ? {} : { cocell_role_runtime: home ? 'home' : 'legacy' };
    if (!Object.keys(changed).length && !pointerDigest && (archive || applied.cocell_role_runtime === roleRuntime.cocell_role_runtime)) return;
    const acknowledge = async () => {
      const acknowledged = { ...digests, ...roleRuntime, ...(pointerDigest ? { cocell_tool_runtime_mount: pointerDigest } : {}) };
      assertActive(signal);
      if (repository) await repository.markRuntimeConfigs(boxId, revision, acknowledged);
      assertActive(signal);
      Object.assign(applied, acknowledged);
    };
    if (!Object.keys(changed).length) { await acknowledge(); return; }
    if (box.capabilities.credentialBatch && !this.legacyGuests.has(boxId)) {
      try {
        assertActive(signal);
        await this.options.provider.client.writeCredentials(boxId, generation, changed, signal);
        assertActive(signal);
      } catch (error) {
        // An older Guest image can coexist briefly with the new API during rollout.
        if (!(error instanceof CellboxError && error.code === 'NOT_FOUND')) throw error;
        assertActive(signal);
        this.legacyGuests.add(boxId);
      }
      if (!this.legacyGuests.has(boxId)) {
        await acknowledge();
        return;
      }
    }
    for (const [slot, bytes] of Object.entries(changed)) {
      const digest = digests[slot];
      assertActive(signal);
      await this.options.provider.client.writeCredential(boxId, slot, bytes, signal);
      assertActive(signal);
      // Do not acknowledge a write against a generation that changed mid-sync.
      if ((await this.options.provider.client.getBox(boxId, signal)).generation !== generation)
        throw new Error('Cellbox generation changed during runtime configuration');
      assertActive(signal);
      if (!mount) {
        if (repository) {
          assertActive(signal);
          await repository.markRuntimeConfig(boxId, revision, slot, digest);
        }
        assertActive(signal);
        applied[slot] = digest;
      }
    }
    await acknowledge();
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
