import { createHash, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { posix } from 'node:path';
import { SandboxLifecycle, type SandboxHandle, type SandboxLifecycleContext } from '@co-cell/sandbox';
import { CellboxError, CellboxSandboxProvider, type CellboxArchive } from '../../packages/sandbox/src/providers/cellbox/index.js';
import { CodexAppServerClient } from '../../packages/agentcore/src/index.mjs';
import type { AppServerEndpoint } from '../execution/container-runtime.js';
import type { RemoteArchives } from '../archives/remote.js';
import type { RemoteArchiveMetadata, RemoteArchiveRef } from '../../protocol/remote-archive-types.js';
import { downloadOssArchive } from '../archives/oss-download.js';
import type { SandboxState } from '../../protocol/sandbox-types.js';
import type { WorkspaceTarget } from './types.js';
import { SandboxRuntimeConfig, type SandboxRuntimeConfigOptions } from './runtime-config.js';
import type { RuntimeLog } from '../infra/diagnostics/runtime-log.js';
const q = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const node = '/usr/local/bin/node';
const workspace = '/home/agent/workspace';
export const CELLBOX_PRODUCT_PATHS = { root: `${workspace}/.cocell`, runtime: `${workspace}/.cocell/runtime`, codexHome: `${workspace}/.cocell/codex`, startup: '/home/agent/.cocell-startup', node };
const metadata = (a: CellboxArchive): RemoteArchiveMetadata => ({ id: a.id, createdAt: a.createdAt, sizeBytes: a.size, sha256: a.sha256, imageId: a.imageId, sourceSandboxId: a.sourceBoxId, ...(a.portable ? { portable: true } : {}) });
export interface CellboxRuntimeIntegrationOptions extends SandboxRuntimeConfigOptions {
    profileId: string;
    appServerArgs: string[];
    env: Record<string, string>;
    lifecycle?: SandboxLifecycle;
    onRenewalFailure?: (error: unknown) => void;
    logger?: RuntimeLog;
    sharedDirectory?: boolean;
}
/** Product initialization. Cellbox retains ownership of identities, forwarding and archive bytes. */
export class CellboxRuntimeIntegration {
    readonly lifecycle: SandboxLifecycle;
    readonly remoteArchives: RemoteArchives;
    private readonly preparations = new Map<string, Promise<void>>();
    private readonly prepared = new Map<string, { generation: number; workspace: string }>();
    private readonly sharedMounts = new Set<string>();
    private readonly releases = new Set<() => Promise<void>>();
    constructor(private readonly options: CellboxRuntimeIntegrationOptions) {
        const runtimeConfig = new SandboxRuntimeConfig(options);
        this.lifecycle = options.lifecycle ?? new SandboxLifecycle([runtimeConfig.extension]);
        const ossArchiveEndpoint = process.env.OSS_ENDPOINT;
        this.remoteArchives = {
        capture: async (target, key) => {
                if (!target.sandbox)
                    throw new Error('Project has no Cellbox');
                const capabilities = ossArchiveEndpoint ? (await options.provider.client.getBox(target.sandbox.id)).capabilities : undefined;
                if (capabilities?.protectedTools) {
                    await runtimeConfig.ensureArchiveCredentials(target.sandbox.id);
                    const suffix = `${target.projectId ?? target.id}/${key.replace(/[^A-Za-z0-9._/-]/g, '_')}.tar.gz`;
                    // Root debug reads private Codex state directly. Existing
                    // non-root debug boxes still require agent-group read access.
                    if (!capabilities.rootDebug) {
                        const handle = await options.provider.connectForSetup(target.sandbox.id);
                        await handle.commands.run(`chmod -R g+rX -- ${workspace}`, { timeoutMs: 120_000 });
                    }
                    const result = await options.provider.client.runTool(target.sandbox.id, 'cocell_archive_backup', [suffix], 5 * 60_000);
                    if (result.exitCode !== 0) throw new Error(result.stderr || `OSS archive backup exited ${result.exitCode}`);
                    const value = JSON.parse(result.stdout.trim());
                    if (value.storageType !== 'oss' || value.objectKey !== `legacy-archives/${suffix}`) throw new Error('OSS backup returned invalid metadata');
                    const image = await options.provider.currentImageIdentity(target.sandbox.id);
                    return { id: `oss:${value.objectKey}`, createdAt: value.createdAt, sizeBytes: value.sizeBytes, sha256: value.sha256,
                        imageId: image.id, sourceSandboxId: target.sandbox.id, storageType: 'oss', metadata: value };
                }
                const op = await options.provider.captureArchive(target.sandbox.id, key);
                const id = op.result?.archiveId;
                if (!id)
                    throw new Error('Cellbox capture returned no archive ID');
                return metadata(await options.provider.client.getArchive(id));
        },
            inspect: async (ref) => {
                if (ref.storageType === 'oss') return { id: ref.id, createdAt: ref.createdAt, sizeBytes: ref.sizeBytes, sha256: ref.sha256, imageId: ref.imageId, sourceSandboxId: ref.sourceSandboxId, storageType: 'oss', metadata: ref.metadata };
                return metadata(await options.provider.client.getArchive(ref.id));
            },
            restore: async (target, ref, key, onCandidate) => {
                const context: SandboxLifecycleContext = { action: 'restore', resourceKey: `project:${target.projectId ?? target.id}` };
                return this.lifecycle.run(context, async () => {
                    if (ref.storageType === 'oss') {
                        if (target.imageSelection) throw new Error('Imported images cannot restore protected OSS archives');
                        if (!ossArchiveEndpoint) throw new Error('OSS restore endpoint is unavailable');
                        const createContext: SandboxLifecycleContext = { action: 'create', resourceKey: context.resourceKey };
                        let candidate!: SandboxState;
                        await this.lifecycle.run(createContext, async () => {
                            const handle = await options.provider.create(options.profileId, { timeoutMs: 120_000, lifecycle: { onTimeout: 'pause', autoResume: false }, metadata: { projectId: target.projectId ?? target.id, cellboxOwnerKey: `project:${target.projectId ?? target.id}:oss-restore:${key}`, cellboxIdempotencyKey: key, ...(options.sharedDirectory ? { cellboxStaged: 'true' } : {}) } });
                            candidate = { id: handle.sandboxId, template: options.profileId, status: 'starting', workingDirectory: workspace };
                            await onCandidate(candidate);
                            createContext.sandboxId = context.sandboxId = candidate.id;
                            createContext.sandbox = handle;
                        });
                        await this.timed('archive.restore_oss', candidate.id, async () => {
                            await runtimeConfig.ensureArchiveCredentials(candidate.id);
                            const result = await options.provider.client.runTool(candidate.id, 'cocell_archive_restore', [JSON.stringify(ref.metadata), ossArchiveEndpoint], 5 * 60_000);
                            if (result.exitCode !== 0) throw new Error(result.stderr || `OSS archive restore exited ${result.exitCode}`);
                        });
                        candidate.image = await options.provider.currentImageIdentity(candidate.id);
                        return candidate;
                    }
                    const op = await options.provider.client.restoreBox({ profileId: options.profileId, ownerKey: `project:${target.projectId ?? target.id}:restore:${key}`, archiveId: ref.id, ...(target.imageSelection ? { importedImageId: target.imageSelection.importedImageId } : {}), ...(ref.portable ? { acceptImageChange: true } : {}) }, key);
                    const candidate: SandboxState = { id: op.targetId, template: options.profileId, status: 'starting', workingDirectory: target.settings.workingDirectory };
                    await onCandidate(candidate);
                    context.sandboxId = candidate.id;
                    await this.timed('cellbox.restore_operation', candidate.id, () => options.provider.waitForOperation(op));
                    const box = await options.provider.client.getBox(candidate.id);
                    if (box.phase !== 'staged')
                        throw new Error('Cellbox did not return a staged restore candidate');
                    candidate.image = { reference: box.image, id: box.imageId ?? box.image, repoDigests: [] };
                    return candidate;
                });
            },
            activate: async (candidate) => {
                await this.lifecycle.run({ action: 'activate', resourceKey: `sandbox:${candidate.id}`, sandboxId: candidate.id }, async () => {
                    const handle = await options.provider.connectForSetup(candidate.id);
                    await this.prepare(handle, { id: candidate.id, settings: { workingDirectory: candidate.workingDirectory }, sandbox: candidate, updatedAt: new Date().toISOString() }, AbortSignal.timeout(120000), false);
                    const box = await options.provider.client.getBox(candidate.id);
                    if (box.phase === 'staged') await this.timed('cellbox.activate', candidate.id,
                        () => options.provider.activateBox(candidate.id, `cocell-activate-${candidate.id}`));
                    else if (box.phase !== 'running') throw new Error(`Cellbox restore candidate is ${box.phase}`);
                    if (!this.usesSharedDirectory(candidate.id)) await this.waitForAppServer(handle, AbortSignal.timeout(30000));
                });
            },
            download: async (ref, destination) => {
                if (ref.sizeBytes > 256 * 1024 * 1024)
                    throw new Error('Archive exceeds the 256 MiB interactive browsing limit');
                if (ref.storageType === 'oss') return downloadOssArchive(ref, destination);
                const bytes = await options.provider.client.downloadArchive(ref.id, 256 * 1024 * 1024);
                if (bytes.byteLength !== ref.sizeBytes || createHash('sha256').update(bytes).digest('hex') !== ref.sha256)
                    throw new Error('Cellbox archive integrity check failed');
                await writeFile(destination, bytes, { mode: 0o600, flag: 'wx' });
            },
            remove: async (ref) => {
                if (ref.storageType === 'oss') return;
                try {
                await options.provider.client.deleteArchive(ref.id);
            }
            catch (error) {
                if (!(error instanceof CellboxError && error.code === 'NOT_FOUND'))
                    throw error;
                }
            },
        };
    }
    async prepare(handle: SandboxHandle, target: WorkspaceTarget, signal: AbortSignal, wait = true): Promise<boolean> {
        const previous = this.preparations.get(handle.sandboxId) ?? Promise.resolve();
        let fresh = false;
        const current = previous.catch(() => { }).then(async () => {
            const box = await this.options.provider.client.getBox(handle.sandboxId);
            if (box.phase !== 'running' && box.phase !== 'staged') throw new Error(`Cellbox is ${box.phase}`);
            if (this.options.sharedDirectory && box.capabilities.sharedDirectory) this.sharedMounts.add(handle.sandboxId);
            else this.sharedMounts.delete(handle.sandboxId);
            const cached = this.prepared.get(handle.sandboxId);
            fresh = !cached || cached.generation !== box.generation || cached.workspace !== target.settings.workingDirectory;
            if (fresh) await this.prepareOnce(handle, target, signal, wait);
            if (wait) this.prepared.set(handle.sandboxId, { generation: box.generation, workspace: target.settings.workingDirectory });
        });
        this.preparations.set(handle.sandboxId, current);
        try {
            await this.timed('product.prepare', handle.sandboxId, () => current);
        }
        finally {
            if (this.preparations.get(handle.sandboxId) === current)
                this.preparations.delete(handle.sandboxId);
        }
        return fresh;
    }
    private async prepareOnce(handle: SandboxHandle, target: WorkspaceTarget, signal: AbortSignal, wait: boolean) {
        if (posix.normalize(target.settings.workingDirectory) !== target.settings.workingDirectory || (target.settings.workingDirectory !== workspace && !target.settings.workingDirectory.startsWith(workspace + '/')))
            throw new Error(`Cellbox project workspace must be inside ${workspace}`);
        signal.throwIfAborted();
        if (this.usesSharedDirectory(handle.sandboxId)) {
            // Guest/Launcher prepare standard directories and read the shared
            // startup config locally. Only a custom project subdirectory needs exec.
            if (target.settings.workingDirectory !== workspace) {
                const script = `const fs=require('node:fs'),path=require('node:path');let p=${JSON.stringify(workspace)};for(const part of ${JSON.stringify(target.settings.workingDirectory.slice(workspace.length + 1).split('/'))}){p=path.join(p,part);try{fs.mkdirSync(p,{mode:0o700})}catch(e){if(e.code!=='EEXIST')throw e}const s=fs.lstatSync(p);if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==process.getuid())throw Error('Unsafe project directory');}`;
                await handle.commands.run(`${node} -e ${q(script)}`, { user: 'agent', signal, timeoutMs: 30000 });
            }
            return;
        }
        const root = CELLBOX_PRODUCT_PATHS.root, runtime = CELLBOX_PRODUCT_PATHS.startup;
        const setup = `const fs=require('node:fs'),path=require('node:path');for(const p of ${JSON.stringify([root, CELLBOX_PRODUCT_PATHS.runtime, runtime, CELLBOX_PRODUCT_PATHS.codexHome, target.settings.workingDirectory])}){let current='/';for(const part of p.split('/').filter(Boolean)){current=path.join(current,part);try{fs.mkdirSync(current,{mode:0o700})}catch(e){if(e.code!=='EEXIST')throw e}const s=fs.lstatSync(current);if(!s.isDirectory()||s.isSymbolicLink())throw Error('Unsafe runtime directory');}if(fs.statSync(p).uid!==process.getuid())throw Error('Unsafe runtime owner');}fs.chmodSync(${JSON.stringify(root)},0o700);fs.chmodSync(${JSON.stringify(runtime)},0o700);`;
        await handle.commands.run(`${node} -e ${q(setup)}`, { user: 'agent', signal, timeoutMs: 30000 });
        const probe = `const n=require('node:net').connect(4500,'127.0.0.1');n.on('connect',()=>{n.end();process.exit(0)});n.on('error',()=>process.exit(1));n.setTimeout(1000,()=>process.exit(1));`;
        const running = await handle.commands.run(`${node} -e ${q(probe)}`, { user: 'agent', signal, timeoutMs: 2000 }).then(() => true, error => { if ((error as {
            exitCode?: number;
        }).exitCode === 1)
            return false; throw error; });
        if (running)
            return;
        const temp = `${runtime}/.config-${randomUUID()}.json`, final = `${runtime}/config.json`;
        const config = JSON.stringify({ version: 1, appServerArgs: this.options.appServerArgs, env: this.options.env });
        if (Buffer.byteLength(config) > 64 * 1024)
            throw new Error('Product startup config exceeds 64 KiB');
        try {
            await handle.files.write(temp, config, { user: 'agent', signal });
            await handle.commands.run(`chmod 600 -- ${q(temp)} && mv -- ${q(temp)} ${q(final)}`, { user: 'agent', signal, timeoutMs: 30000 });
            if (wait)
                await this.waitForAppServer(handle, signal);
        }
        catch (error) {
            await handle.files.remove(final, { user: 'agent' }).catch(() => { });
            throw error;
        }
        finally {
            await handle.files.remove(temp, { user: 'agent' }).catch(() => { });
        }
    }
    usesSharedDirectory(boxId: string): boolean { return this.sharedMounts.has(boxId); }
    /** Reconcile active instances after operator configuration changes; never wake paused boxes. */
    async reconcile(target: WorkspaceTarget): Promise<void> {
        if (!target.sandbox) return;
        const box = await this.options.provider.client.getBox(target.sandbox.id);
        if (box.phase !== 'running' && box.phase !== 'staged') return;
        await this.lifecycle.run({ action: 'reconcile', resourceKey: `project:${target.projectId ?? target.id}`,
            sandboxId: target.sandbox.id }, async () => {});
    }
    private async waitForAppServer(handle: SandboxHandle, signal: AbortSignal) {
        const script = `const fs=require('node:fs'),net=require('node:net');const until=Date.now()+25000;function poll(){const s=net.connect(4500,'127.0.0.1');s.once('connect',()=>{s.end();if(fs.existsSync('${CELLBOX_PRODUCT_PATHS.startup}/config.json')){console.error('Startup config was not consumed');process.exit(1)}process.exit(0)});s.once('error',()=>{s.destroy();if(Date.now()>until){console.error('App Server did not become ready');process.exit(1)}setTimeout(poll,200)});s.setTimeout(500,()=>s.destroy(new Error('timeout')))}poll();`;
        await this.timed('product.appserver_ready', handle.sandboxId,
            () => handle.commands.run(`${node} -e ${q(script)}`, { user: 'agent', signal, timeoutMs: 30000 }));
    }
    async appServer(boxId: string): Promise<AppServerEndpoint> {
        const access = await this.options.provider.getServiceAccess(boxId, 4500);
        const url = new URL(access.url);
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
        return { url: url.href, headers: access.headers };
    }
    async acquireUsage(boxId: string, initializationDirectory?: string): Promise<() => Promise<void>> {
        // Mounted default-workspace initialization does no remote I/O. The
        // project usage remains held locally; the subsequent RPC holds an API
        // stream fence. Custom directories, legacy setup and execution keep leases.
        if (initializationDirectory === workspace && this.options.sharedDirectory &&
            (await this.options.provider.client.getBox(boxId)).capabilities.sharedDirectory) return async () => {};
        const lease = await this.options.provider.createLease(boxId, 'cocell-product', 180);
        return this.keepAlive(() => this.options.provider.renewLease(lease.id, 'cocell-product', 180).then(() => { }), () => this.options.provider.releaseLease(lease.id));
    }
    private keepAlive(renew: () => Promise<void>, close: () => Promise<void>) {
        let closed = false;
        let active: Promise<void> | undefined;
        const timer = setInterval(() => { if (!closed && !active)
            active = renew().catch(error => { this.options.onRenewalFailure?.(error); }).finally(() => { active = undefined; }); }, 60000);
        timer.unref();
        const release = async () => { if (closed)
            return; closed = true; clearInterval(timer); this.releases.delete(release); await active; await close(); };
        this.releases.add(release);
        return release;
    }
    private async timed<T>(phase: string, sandboxId: string, action: () => Promise<T>): Promise<T> {
        const startedAt = new Date().toISOString();
        const started = performance.now();
        let status = 'succeeded';
        try { return await action(); }
        catch (error) { status = 'failed'; throw error; }
        finally {
            void this.options.logger?.write({ event: 'sandbox.runtime_stage', phase, sandboxId, status,
                startedAt, finishedAt: new Date().toISOString(), durationMs: Math.round(performance.now() - started) });
        }
    }
    async verify(boxId: string) { return this.timed('product.verify', boxId, async () => {
      const endpoint = await this.appServer(boxId); let client: CodexAppServerClient | undefined; try {
        client = await CodexAppServerClient.spawn({ url: endpoint.url, headers: endpoint.headers, requestTimeoutMs: 10000 });
    }
    finally {
        await client?.close();
    } }); }
    async close() {
        await Promise.allSettled([...this.releases].map(release => release()));
        this.prepared.clear();
    }
}
