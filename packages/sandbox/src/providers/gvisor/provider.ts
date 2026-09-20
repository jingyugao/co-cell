import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { SandboxCommandHandle, SandboxCommandResult, SandboxHandle, SandboxProvider, CheckpointableSandboxProvider, SandboxCheckpoint, SandboxInfo } from '../../types.js';
import type { SandboxBundle, SandboxBundleOptions, SandboxImageManager } from '../../image/types.js';
import { GvisorHelperClient } from './client.js';

export interface GvisorSandboxProviderOptions {
  /** Directory shared by the Web service and the host-side helper. */
  bundleRoot: string;
  workingDirectory?: string;
  process: NonNullable<SandboxBundleOptions['process']>;
  mounts?: SandboxBundleOptions['mounts'];
  networkNamespaceRoot?: string;
  appServer?: { host?: string; token: string };
}

export class GvisorSandboxProvider implements CheckpointableSandboxProvider {
  private readonly bundles = new Map<string, SandboxBundle>();
  constructor(private readonly images: SandboxImageManager, private readonly helper: GvisorHelperClient, private readonly image: string,
    private readonly options: GvisorSandboxProviderOptions) {}
  private bundle(id: string): SandboxBundle {
    return this.bundles.get(id) ?? { id, image: { reference: this.image, id: '' }, path: join(this.options.bundleRoot, id),
      rootfs: join(this.options.bundleRoot, id, 'rootfs'), configPath: join(this.options.bundleRoot, id, 'config.json') };
  }
  private async forward(id: string, remotePort: number) {
    return this.helper.request<{ hostPort: number }>({ action: 'forward', sandboxId: id, remotePort });
  }
  private gatewayHost() { return this.options.appServer?.host ?? '127.0.0.1'; }
  private handle(id: string): SandboxHandle {
    const run = async (command: string, options: { user?: string; signal?: AbortSignal; timeoutMs?: number; background?: boolean;
      cwd?: string; envs?: Record<string, string>; onStdout?: (value: string) => void; onStderr?: (value: string) => void } = {}) => {
      const result = await this.helper.request<SandboxCommandResult>({ action: 'exec', sandboxId: id, command, user: options.user,
        cwd: options.cwd ?? this.options.workingDirectory, env: options.envs, timeoutMs: options.timeoutMs },
      { signal: options.signal, timeoutMs: (options.timeoutMs ?? 120_000) + 10_000 });
      if (result.stdout) options.onStdout?.(result.stdout);
      if (result.stderr) options.onStderr?.(result.stderr);
      return result;
    };
    return { sandboxId: id, getHost: () => this.gatewayHost(),
      getServiceUrl: async port => {
        const proxy = await this.forward(id, 40000);
        return `http://${this.gatewayHost()}:${proxy.hostPort}/${port}`;
      }, setTimeout: async () => {}, commands: {
      run: (async (command: string, commandOptions: Parameters<typeof run>[1] = {}) => {
        if (!commandOptions.background) {
          const result = await run(command, commandOptions);
          if (result.exitCode) throw Object.assign(new Error(result.stderr || `exit ${result.exitCode}`), result);
          return result;
        }
        // runsc exec is request-scoped. The handle preserves the command API,
        // while a background request is allowed to complete independently.
        const result = run(command, commandOptions);
        return {
          wait: async () => {
            const value = await result;
            if (value.exitCode) throw Object.assign(new Error(value.stderr || `exit ${value.exitCode}`), value);
            return value;
          },
          kill: async () => false,
          disconnect: async () => {},
        } satisfies SandboxCommandHandle;
      }) as SandboxHandle['commands']['run'],
    }, files: {
      read: async path => {
        const result = await run(`base64 -w0 -- ${JSON.stringify(path)}`);
        if (result.exitCode) throw new Error(result.stderr);
        return Buffer.from(result.stdout, 'base64').toString();
      },
      write: async (path, value, writeOptions = {}) => {
        const encoded = Buffer.from(value instanceof ArrayBuffer ? new Uint8Array(value) : value).toString('base64');
        const result = await run(`mkdir -p -- ${JSON.stringify(path.slice(0, Math.max(path.lastIndexOf('/'), 1)))} && printf %s "$SWARM_HIVE_FILE" | base64 -d > ${JSON.stringify(path)}`,
          { user: writeOptions.user, signal: writeOptions.signal, envs: { SWARM_HIVE_FILE: encoded } });
        if (result.exitCode) throw new Error(result.stderr);
      },
      exists: async path => (await run(`test -e ${JSON.stringify(path)}`)).exitCode === 0,
      remove: async (path, removeOptions = {}) => { await run(`rm -rf -- ${JSON.stringify(path)}`, removeOptions); },
      rename: async (from, to, renameOptions = {}) => { const result = await run(`mv -- ${JSON.stringify(from)} ${JSON.stringify(to)}`, renameOptions); if (result.exitCode) throw new Error(result.stderr); },
    } };
  }
  async create(_template: string, _options: Parameters<SandboxProvider['create']>[1]): Promise<SandboxHandle> {
    const id = `gvisor-${randomUUID()}`;
    const image = await this.images.inspect(this.image);
    const bundle = await this.images.prepareBundle(image, id, { process: { ...this.options.process,
      env: { ...(this.options.process.env ?? {}), CODEX_APP_SERVER_PORT: String(this.appServerPort(id)) } }, mounts: this.options.mounts,
      networkNamespace: join(this.options.networkNamespaceRoot ?? '/var/run/netns', id) });
    this.bundles.set(id, bundle);
    await this.helper.request({ action: 'create', sandboxId: id, bundlePath: bundle.path });
    await this.helper.request({ action: 'start', sandboxId: id });
    await Promise.all([this.forward(id, this.appServerPort(id)), this.forward(id, 40000)]);
    return this.handle(id);
  }
  async connect(id: string): Promise<SandboxHandle> {
    await stat(this.bundle(id).configPath);
    const state = await this.helper.request<{ status: string }>({ action: 'state', sandboxId: id });
    if (state.status !== 'running') throw new Error(`gVisor Sandbox ${id} is unavailable`);
    return this.handle(id);
  }
  async getInfo(id: string): Promise<SandboxInfo> {
    const state = await this.helper.request<{ status: string; pid: number }>({ action: 'state', sandboxId: id });
    const now = new Date();
    return { sandboxId: id, state: state.status === 'running' ? 'running' : 'unknown', startedAt: now, endAt: new Date(now.getTime() + 3 * 60 * 60 * 1000) };
  }
  async pause(id: string) { await this.helper.request({ action: 'kill', sandboxId: id }); return true; }
  async kill(id: string) { await this.helper.request({ action: 'delete', sandboxId: id }); await this.images.removeBundle(this.bundle(id)); this.bundles.delete(id); return true; }
  async checkpoint(id: string): Promise<SandboxCheckpoint> { return this.helper.request<SandboxCheckpoint>({ action: 'checkpoint', sandboxId: id }); }
  async restore(id: string, checkpointId: string) {
    const bundle = this.bundle(id);
    await stat(bundle.configPath);
    await this.helper.request({ action: 'restore', sandboxId: id, checkpointId, bundlePath: bundle.path });
  }
  async appServer(id: string) {
    if (!this.options.appServer) throw new Error('gVisor App Server is not configured');
    const forward = await this.forward(id, this.appServerPort(id));
    return { url: `ws://${this.gatewayHost()}:${forward.hostPort}`, token: this.options.appServer.token };
  }
  private appServerPort(id: string) { return 20_000 + (parseInt(id.replaceAll('-', '').slice(-6), 16) % 20_000); }
}
