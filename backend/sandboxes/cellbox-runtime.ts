import { createHash, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { posix } from 'node:path';
import type { SandboxHandle } from '@co-cell/sandbox';
import { CellboxError, CellboxSandboxProvider, type CellboxArchive } from '../../packages/sandbox/src/providers/cellbox/index.js';
import { CodexAppServerClient } from '../../packages/agentcore/src/index.mjs';
import type { AppServerEndpoint } from '../execution/container-runtime.js';
import type { ConnectionStore } from '../connections/store.js';
import type { RemoteArchives } from '../archives/remote.js';
import type { RemoteArchiveMetadata, RemoteArchiveRef } from '../../protocol/remote-archive-types.js';
import { downloadOssArchive } from '../archives/oss-download.js';
import type { SandboxState } from '../../protocol/sandbox-types.js';
import type { WorkspaceTarget } from './types.js';
import type { SecretService } from '../secrets/service.js';
const q = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const node = '/usr/local/bin/node';
const workspace = '/home/agent/workspace';
export const CELLBOX_PRODUCT_PATHS = { root: `${workspace}/.cocell`, runtime: `${workspace}/.cocell/runtime`, codexHome: `${workspace}/.cocell/codex`, startup: '/home/agent/.cocell-startup', node };
const metadata = (a: CellboxArchive): RemoteArchiveMetadata => ({ id: a.id, createdAt: a.createdAt, sizeBytes: a.size, sha256: a.sha256, imageId: a.imageId, sourceSandboxId: a.sourceBoxId, ...(a.portable ? { portable: true } : {}) });
export interface CellboxRuntimeIntegrationOptions {
    provider: CellboxSandboxProvider;
    profileId: string;
    appServerArgs: string[];
    env: Record<string, string>;
    connections?: ConnectionStore;
    /** Runtime bundle paths mapped only to explicitly admitted debug slots. */
    credentialSlots?: Record<string, string>;
    secrets?: SecretService;
    toolBrokerUrl?: string;
    onRenewalFailure?: (error: unknown) => void;
}
/** Product initialization. Cellbox retains ownership of identities, forwarding and archive bytes. */
export class CellboxRuntimeIntegration {
    readonly remoteArchives: RemoteArchives;
    private readonly preparations = new Map<string, Promise<void>>();
    private readonly prepared = new Map<string, { generation: number; workspace: string }>();
    private readonly credentialDigests = new Map<string, { generation: number; slots: Map<string, string> }>();
    private readonly releases = new Set<() => Promise<void>>();
    constructor(private readonly options: CellboxRuntimeIntegrationOptions) {
        const ossArchiveEndpoint = process.env.OSS_ENDPOINT;
        this.remoteArchives = {
        capture: async (target, key) => {
                if (!target.sandbox)
                    throw new Error('Project has no Cellbox');
                if (ossArchiveEndpoint && (await options.provider.client.getBox(target.sandbox.id)).capabilities.protectedTools) {
                    const suffix = `${target.projectId ?? target.id}/${key.replace(/[^A-Za-z0-9._/-]/g, '_')}.tar.gz`;
                    // The protected tool runs as Cellbox's debug identity with the
                    // agent group. Codex keeps its state in owner-only directories;
                    // grant that group read access after readiness preparation.
                    const handle = await options.provider.connectForSetup(target.sandbox.id);
                    await handle.commands.run(`chmod -R g+rX -- ${workspace}`, { timeoutMs: 120_000 });
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
                if (ref.storageType === 'oss') {
                    if (target.imageSelection) throw new Error('Imported images cannot restore protected OSS archives');
                    if (!ossArchiveEndpoint) throw new Error('OSS restore endpoint is unavailable');
                    const candidateHandle = await options.provider.create(options.profileId, { timeoutMs: 120_000, lifecycle: { onTimeout: 'pause', autoResume: false }, metadata: { projectId: target.projectId ?? target.id, cellboxOwnerKey: `project:${target.projectId ?? target.id}:oss-restore:${key}`, cellboxIdempotencyKey: key } });
                    const candidate: SandboxState = { id: candidateHandle.sandboxId, template: options.profileId, status: 'starting', workingDirectory: workspace };
                    await onCandidate(candidate);
                    await this.syncCredentials(candidate.id, (await options.provider.client.getBox(candidate.id)).generation, target.projectId ?? target.id);
                    const result = await options.provider.client.runTool(candidate.id, 'cocell_archive_restore', [JSON.stringify(ref.metadata), ossArchiveEndpoint], 5 * 60_000);
                    if (result.exitCode !== 0) throw new Error(result.stderr || `OSS archive restore exited ${result.exitCode}`);
                    candidate.image = await options.provider.currentImageIdentity(candidate.id);
                    return candidate;
                }
                const op = await options.provider.client.restoreBox({ profileId: options.profileId, ownerKey: `project:${target.projectId ?? target.id}:restore:${key}`, archiveId: ref.id, ...(target.imageSelection ? { importedImageId: target.imageSelection.importedImageId } : {}), ...(ref.portable ? { acceptImageChange: true } : {}) }, key);
                const candidate: SandboxState = { id: op.targetId, template: options.profileId, status: 'starting', workingDirectory: target.settings.workingDirectory };
                await onCandidate(candidate);
                await options.provider.waitForOperation(op);
                const box = await options.provider.client.getBox(candidate.id);
                if (box.phase !== 'staged')
                    throw new Error('Cellbox did not return a staged restore candidate');
                candidate.image = { reference: box.image, id: box.imageId ?? box.image, repoDigests: [] };
                if (this.options.secrets && box.capabilities.protectedTools)
                    await this.options.secrets.registerRuntime(candidate.id, target.projectId ?? target.id, box.generation);
                return candidate;
            },
            activate: async (candidate) => {
                const handle = await options.provider.connectForSetup(candidate.id);
                await this.prepare(handle, { id: candidate.id, settings: { workingDirectory: candidate.workingDirectory }, sandbox: candidate, updatedAt: new Date().toISOString() }, AbortSignal.timeout(120000), false);
                const box = await options.provider.client.getBox(candidate.id);
                if (box.phase === 'staged') await options.provider.activateBox(candidate.id, `cocell-activate-${candidate.id}`);
                else if (box.phase !== 'running') throw new Error(`Cellbox restore candidate is ${box.phase}`);
                await this.waitForAppServer(handle, AbortSignal.timeout(30000));
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
            const cached = this.prepared.get(handle.sandboxId);
            fresh = !cached || cached.generation !== box.generation || cached.workspace !== target.settings.workingDirectory;
            if (fresh) await this.prepareOnce(handle, target, signal, wait, box.generation);
            else await this.syncCredentials(handle.sandboxId, box.generation, target.projectId ?? target.id);
            if (wait) this.prepared.set(handle.sandboxId, { generation: box.generation, workspace: target.settings.workingDirectory });
        });
        this.preparations.set(handle.sandboxId, current);
        try {
            await current;
        }
        finally {
            if (this.preparations.get(handle.sandboxId) === current)
                this.preparations.delete(handle.sandboxId);
        }
        return fresh;
    }
    private async prepareOnce(handle: SandboxHandle, target: WorkspaceTarget, signal: AbortSignal, wait: boolean, generation: number) {
        if (posix.normalize(target.settings.workingDirectory) !== target.settings.workingDirectory || (target.settings.workingDirectory !== workspace && !target.settings.workingDirectory.startsWith(workspace + '/')))
            throw new Error(`Cellbox project workspace must be inside ${workspace}`);
        signal.throwIfAborted();
        const root = CELLBOX_PRODUCT_PATHS.root, runtime = CELLBOX_PRODUCT_PATHS.startup;
        const setup = `const fs=require('node:fs'),path=require('node:path');for(const p of ${JSON.stringify([root, CELLBOX_PRODUCT_PATHS.runtime, runtime, CELLBOX_PRODUCT_PATHS.codexHome, target.settings.workingDirectory])}){let current='/';for(const part of p.split('/').filter(Boolean)){current=path.join(current,part);try{fs.mkdirSync(current,{mode:0o700})}catch(e){if(e.code!=='EEXIST')throw e}const s=fs.lstatSync(current);if(!s.isDirectory()||s.isSymbolicLink())throw Error('Unsafe runtime directory');}if(fs.statSync(p).uid!==process.getuid())throw Error('Unsafe runtime owner');}fs.chmodSync(${JSON.stringify(root)},0o700);fs.chmodSync(${JSON.stringify(runtime)},0o700);`;
        await handle.commands.run(`${node} -e ${q(setup)}`, { user: 'agent', signal, timeoutMs: 30000 });
        await this.syncCredentials(handle.sandboxId, generation, target.projectId ?? target.id);
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
    private async syncCredentials(boxId: string, generation: number, projectId?: string) {
        if (this.options.secrets) {
            if (!(await this.options.provider.client.getBox(boxId)).capabilities.protectedTools) return;
            // Restore activation can address a candidate by box ID. Reuse only
            // its server-side registration rather than inventing project identity.
            const previous = await this.options.secrets.repository.runtime(boxId);
            const owner = projectId === boxId ? previous?.projectId : projectId;
            if (!owner) throw new Error('Project identity is required for tool credentials');
            const token = await this.options.secrets.registerRuntime(boxId, owner, generation);
            if (!this.options.toolBrokerUrl) throw new Error('COCELL_TOOL_BROKER_URL is required');
            let cached = this.credentialDigests.get(boxId);
            if (!cached || cached.generation !== generation) {
                cached = { generation, slots: new Map() };
                this.credentialDigests.set(boxId, cached);
            }
            // Only platform archive credentials retain the legacy slot transport.
            const slots = [
                ['cocell_tool_runtime', JSON.stringify({ token, url: this.options.toolBrokerUrl })],
                ['cocell_oss_access_key', process.env.OSS_ACCESS_KEY],
                ['cocell_oss_secret_key', process.env.OSS_SECRET_KEY],
            ];
            for (const [slot, value] of slots) {
                if (!value) continue;
                const bytes = Buffer.from(value), digest = createHash('sha256').update(bytes).digest('hex');
                if (cached.slots.get(slot!) === digest) continue;
                await this.options.provider.client.writeCredential(boxId, slot!, bytes);
                // Keep successful writes even if a later readiness probe times out.
                cached.slots.set(slot!, digest);
            }
            return;
        }
        const mapping = this.options.credentialSlots ?? {};
        if (!Object.keys(mapping).length || !this.options.connections)
            return;
        if (!(await this.options.provider.client.getBox(boxId)).capabilities.protectedTools) return;
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
        let cached = this.credentialDigests.get(boxId);
        if (!cached || cached.generation !== generation) {
            cached = { generation, slots: new Map() };
            this.credentialDigests.set(boxId, cached);
        }
        for (const [source, slot] of Object.entries(mapping)) {
            if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(slot))
                throw new Error('Invalid Cellbox credential slot mapping');
            // Clearing a configured connection must not retain its old secret.
            // Cellbox requires a nonempty credential. Replace a cleared secret
            // with an inert newline so its previous value cannot survive.
            const value = files[source];
            const bytes = value?.byteLength ? value : Buffer.from('\n');
            const digest = createHash('sha256').update(bytes).digest('hex');
            if (cached.slots.get(slot) === digest) continue;
            await this.options.provider.client.writeCredential(boxId, slot, bytes);
            cached.slots.set(slot, digest);
        }
    }
    private async waitForAppServer(handle: SandboxHandle, signal: AbortSignal) {
        const script = `const fs=require('node:fs'),net=require('node:net');const until=Date.now()+25000;function poll(){const s=net.connect(4500,'127.0.0.1');s.once('connect',()=>{s.end();if(fs.existsSync('${CELLBOX_PRODUCT_PATHS.startup}/config.json')){console.error('Startup config was not consumed');process.exit(1)}process.exit(0)});s.once('error',()=>{s.destroy();if(Date.now()>until){console.error('App Server did not become ready');process.exit(1)}setTimeout(poll,200)});s.setTimeout(500,()=>s.destroy(new Error('timeout')))}poll();`;
        await handle.commands.run(`${node} -e ${q(script)}`, { user: 'agent', signal, timeoutMs: 30000 });
    }
    async appServer(boxId: string): Promise<AppServerEndpoint> {
        const access = await this.options.provider.getServiceAccess(boxId, 4500, 'cocell-app-server', 180);
        const release = this.keepAlive(() => access.renew(180).then(() => { }), () => access.revoke());
        const url = new URL(access.url);
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
        return { url: url.href, headers: access.headers, release };
    }
    async acquireUsage(boxId: string): Promise<() => Promise<void>> {
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
    async verify(boxId: string) { const endpoint = await this.appServer(boxId); let client: CodexAppServerClient | undefined; try {
        client = await CodexAppServerClient.spawn({ url: endpoint.url, headers: endpoint.headers, requestTimeoutMs: 10000 });
        await client.request('thread/list', { limit: 1 });
    }
    finally {
        await client?.close();
        await endpoint.release?.();
    } }
    async close() {
        await Promise.allSettled([...this.releases].map(release => release()));
        this.prepared.clear();
        this.credentialDigests.clear();
    }
}
