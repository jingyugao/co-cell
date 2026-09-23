import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { chmod, chown, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import type { DockerArchiveData, DockerArchiveDataOptions, DockerExecHandle, DockerExecOptions, DockerExecResult, DockerImageIdentity, DockerSandboxRecord, DockerSandboxStatus } from './types.js';
import { createDockerProjectData, resolveDockerProjectData, type DockerProjectData } from './project-data.js';

type Mount = { source: string; destination: string; readonly: boolean };
export type DockerProjectDataOptions = { root: string; dockerRoot?: string; uid: number; gid: number };
const PROJECT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_ARCHIVE_STDOUT_BYTES = 1024 * 1024;
const ARCHIVE_SOURCE_ROOT = '/home/user/.cocell-backup-source';

const execFileAsync = promisify(execFile);

export class DockerSandboxClient {
  constructor(private readonly image: string, private readonly docker = 'docker', private readonly network = 'host', private readonly appServerTokenHostPath?: string,
    private readonly sharedAgentsHostPath?: string, private readonly appServerHost?: string,
    private readonly mounts: Mount[] = [],
    private readonly appServerEnvironment: Record<string, string> = {},
    private readonly cellboxProxyHostPath?: string,
    private readonly startupCommand?: string,
    private readonly runtimeUser = 'user',
    private readonly projectDataOptions?: DockerProjectDataOptions,
    private readonly archiveDataOptions?: DockerArchiveDataOptions) {}
  get defaultUser() { return this.runtimeUser; }
  private async call(args: string[], timeout?: number, signal?: AbortSignal) { return execFileAsync(this.docker, args, { timeout, signal, maxBuffer: 16 * 1024 * 1024 }); }
  async imageIdentity(reference = this.image): Promise<DockerImageIdentity> {
    const { stdout } = await this.call(['image', 'inspect', '--format', '{{json .}}', reference]);
    const image = JSON.parse(stdout) as {
      Id: string; RepoDigests?: string[] | null; Created?: string;
      Config?: { Labels?: Record<string, string> | null };
    };
    const labels = image.Config?.Labels ?? {};
    return {
      reference,
      id: image.Id,
      repoDigests: image.RepoDigests ?? [],
      ...(labels['org.opencontainers.image.version'] ? { version: labels['org.opencontainers.image.version'] } : {}),
      ...(labels['org.opencontainers.image.created'] || image.Created
        ? { createdAt: labels['org.opencontainers.image.created'] || image.Created }
        : {}),
    };
  }
  async containerDetails(id: string): Promise<{ status: DockerSandboxStatus; createdAt: string; imageIdentity: DockerImageIdentity }> {
    const { stdout } = await this.call(['inspect', '--format', '{{json .}}', id]);
    const container = JSON.parse(stdout) as {
      Image: string; Created: string; Config: { Image: string }; State: { Status: string; Paused: boolean };
    };
    const status = container.State.Status === 'paused' || (container.State.Status === 'running' && container.State.Paused)
      ? 'paused' : container.State.Status === 'running' ? 'ready' : 'unavailable';
    let imageIdentity: DockerImageIdentity;
    try {
      imageIdentity = { ...(await this.imageIdentity(container.Image)), reference: container.Config.Image };
    } catch {
      // Container inspect itself always exposes the immutable image ID, even
      // if the image's optional labels/digests are no longer inspectable.
      imageIdentity = { reference: container.Config.Image, id: container.Image, repoDigests: [] };
    }
    return { status, createdAt: container.Created, imageIdentity };
  }
  async create(projectId: string, workingDirectory: string, options: { generation?: string; start?: boolean } = {}): Promise<DockerSandboxRecord> {
    const projectData = this.projectDataOptions && PROJECT_UUID.test(projectId)
      ? await createDockerProjectData(this.projectDataOptions.root, projectId, this.projectDataOptions.uid, this.projectDataOptions.gid, options.generation)
      : undefined;
    let archiveData: DockerArchiveData | undefined;
    try {
      archiveData = this.archiveDataOptions && PROJECT_UUID.test(projectId)
        ? await this.createArchiveData(projectId) : undefined;
    } catch (error) {
      if (projectData) await rm(projectData.root, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
    if (projectData) {
      for (const mount of this.mounts) {
        const destination = mount.destination.replace(/\/$/, '');
        const overlaps = (root: string) => destination === root || destination.startsWith(`${root}/`) || root.startsWith(`${destination}/`);
        if (overlaps('/home/user/workspace') || (overlaps('/home/user/.codex') && destination !== '/home/user/.codex/AGENTS.md')
          || overlaps(ARCHIVE_SOURCE_ROOT)) {
          if (projectData) await rm(projectData.root, { recursive: true, force: true }).catch(() => {});
          throw new Error(`Configured mount conflicts with host-backed project data: ${mount.destination}`);
        }
      }
    }
    if (archiveData && this.archiveDataOptions) {
      const destination = archiveData.sandboxRoot.replace(/\/$/, '');
      if (!isAbsolute(destination)) throw new Error('Sandbox archive mount path must be absolute');
      const overlaps = (root: string) => destination === root || destination.startsWith(`${root}/`) || root.startsWith(`${destination}/`);
      if (overlaps('/home/user/workspace') || overlaps('/home/user/.codex')) {
        if (projectData) await rm(projectData.root, { recursive: true, force: true }).catch(() => {});
        throw new Error(`Configured archive mount conflicts with project data: ${archiveData.sandboxRoot}`);
      }
      for (const mount of this.mounts) {
        const configured = mount.destination.replace(/\/$/, '');
        if (configured === destination || configured.startsWith(`${destination}/`) || destination.startsWith(`${configured}/`)) {
          if (projectData) await rm(projectData.root, { recursive: true, force: true }).catch(() => {});
          throw new Error(`Configured mount conflicts with project archive storage: ${mount.destination}`);
        }
      }
    }
    const name = `cellbox-${projectId.slice(0, 12)}-${randomUUID().slice(0, 8)}`;
    // Sandboxes share Docker's host network so project preview ports remain
    // reachable. Give each long-lived App Server a distinct private port.
    const appServerPort = 20_000 + (parseInt(randomUUID().replaceAll('-', '').slice(0, 6), 16) % 20_000);
    const args = ['create', '--name', name, '--network', this.network, '--user', this.runtimeUser,
      '--workdir', workingDirectory, '--label', 'app=cellbox',
      '--label', 'co-cell.group=cellbox',
      // A configured image may carry Compose labels. Override them so Docker
      // Desktop groups project sandboxes separately without making Compose own
      // their lifecycle.
      '--label', 'com.docker.compose.project=cellbox',
      '--label', 'com.docker.compose.service=cellbox',
      '--label', `swarm-hive.app-server-port=${appServerPort}`,
      '--env', `CODEX_APP_SERVER_PORT=${appServerPort}`,
      '--label', `projectId=${projectId}`];
    for (const [key, value] of Object.entries(this.appServerEnvironment)) args.push('--env', `${key}=${value}`);
    // This is a stable host directory, rather than a per-turn generated
    // directory. A bind mount lets operators update CLI configuration without
    // recreating a Sandbox. Trusted personal deployments may let agents
    // update the host-managed files as well.
    for (const mount of this.mounts) args.push('--mount', `type=bind,src=${mount.source},dst=${mount.destination}${mount.readonly ? ',readonly' : ''}`);
    if (projectData) {
      const sourceRoot = this.projectDataOptions!.dockerRoot ?? this.projectDataOptions!.root;
      const dockerProjectRoot = join(sourceRoot, projectData.projectId, projectData.generation);
      args.push('--mount', `type=bind,src=${join(dockerProjectRoot, 'workspace')},dst=/home/user/workspace`);
      args.push('--mount', `type=bind,src=${join(dockerProjectRoot, 'codex')},dst=/home/user/.codex`);
      args.push('--mount', `type=bind,src=${dockerProjectRoot},dst=${ARCHIVE_SOURCE_ROOT},readonly`);
    }
    if (archiveData && this.archiveDataOptions) {
      const sourceRoot = this.archiveDataOptions.dockerRoot ?? this.archiveDataOptions.root;
      args.push('--mount', `type=bind,src=${join(resolve(sourceRoot), projectId)},dst=${archiveData.sandboxRoot}`);
    }
    if (this.appServerTokenHostPath) args.push('--mount', `type=bind,src=${this.appServerTokenHostPath},dst=/home/user/.codex-web/app-server-token`);
    // The App Server is started with the container and discovers AGENTS.md at
    // thread creation time. Mount the global rules rather than copying them
    // after the server has already started.
    if (this.sharedAgentsHostPath) args.push('--mount', `type=bind,src=${this.sharedAgentsHostPath},dst=/home/user/.codex/AGENTS.md`);
    args.push(this.image);
    if (this.startupCommand) args.push('node', '-e', this.startupCommand);
    let stdout: string;
    try { ({ stdout } = await this.call(args)); }
    catch (error) {
      if (projectData) await rm(projectData.root, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
    const id = stdout.trim();
    try {
      if (projectData) await writeFile(join(projectData.root, 'sandbox-id'), id, { flag: 'wx', mode: 0o600 });
      if (this.cellboxProxyHostPath) await this.call(['cp', this.cellboxProxyHostPath, `${id}:/tmp/cellbox-proxy.mjs`]);
      if (options.start !== false) await this.call(['start', id], 30_000);
    } catch (error) {
      await this.remove(id).catch(() => {});
      throw error;
    }
    try {
      const details = await this.containerDetails(id);
      return { id, image: details.imageIdentity.reference, imageIdentity: details.imageIdentity,
        status: details.status, projectId, workingDirectory, createdAt: details.createdAt,
        ...(projectData ? { generation: projectData.generation } : {}) };
    } catch {
      // Do not report creation failure after Docker created the container:
      // callers would otherwise retry and leave it untracked.
      return { id, image: this.image, status: options.start === false ? 'unavailable' : 'ready', projectId, workingDirectory, createdAt: new Date().toISOString(),
        ...(projectData ? { generation: projectData.generation } : {}) };
    }
  }
  /** Create persistent per-project storage writable by the configured Sandbox user. */
  private async createArchiveData(projectId: string): Promise<DockerArchiveData> {
    const options = this.archiveDataOptions!;
    if (!PROJECT_UUID.test(projectId)) throw new Error('Docker archive storage requires a UUID project ID');
    if (!Number.isSafeInteger(options.uid) || options.uid < 0 || !Number.isSafeInteger(options.gid) || options.gid < 0) {
      throw new Error('Sandbox UID and GID must be non-negative integers');
    }
    const requestedRoot = resolve(options.root);
    await mkdir(requestedRoot, { recursive: true, mode: 0o711 });
    const root = await realpath(requestedRoot);
    const projectRoot = join(root, projectId);
    try { await mkdir(projectRoot, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const info = await lstat(projectRoot);
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(projectRoot) !== projectRoot) {
      throw new Error('Docker project archive path is not a real directory');
    }
    await chmod(projectRoot, 0o700);
    await chown(projectRoot, options.uid, options.gid);
    const configuredSandboxBase = options.sandboxRoot ?? '/home/user/.codex-web/archives/repositories';
    if (!isAbsolute(configuredSandboxBase)) throw new Error('Sandbox archive repository path must be absolute');
    const sandboxBase = resolve(configuredSandboxBase);
    return { projectId, root: projectRoot, sandboxRoot: join(sandboxBase, projectId) };
  }
  async start(id: string): Promise<void> { await this.call(['start', id], 30_000); }
  /** Return host-backed project data only when both expected bind mounts are present. */
  async projectData(projectId: string, sandboxId: string): Promise<DockerProjectData | undefined> {
    if (!this.projectDataOptions || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(projectId)) return undefined;
    let mounts: Array<{ Type?: string; Source?: string; Destination?: string }>;
    try {
      const { stdout } = await this.call(['inspect', '--format', '{{json .Mounts}}', sandboxId]);
      mounts = JSON.parse(stdout) as typeof mounts;
    } catch { return undefined; }
    const dockerRoot = resolve(this.projectDataOptions.dockerRoot ?? this.projectDataOptions.root);
    const workspaceMount = mounts.find(mount => mount.Destination === '/home/user/workspace' && mount.Type === 'bind');
    const codexMount = mounts.find(mount => mount.Destination === '/home/user/.codex' && mount.Type === 'bind');
    if (!workspaceMount?.Source || !codexMount?.Source) return undefined;
    const workspaceRelative = relative(dockerRoot, resolve(workspaceMount.Source));
    const codexRelative = relative(dockerRoot, resolve(codexMount.Source));
    if (workspaceRelative.startsWith(`..${sep}`) || workspaceRelative.startsWith('..') || isAbsolute(workspaceRelative) || codexRelative.startsWith(`..${sep}`) || codexRelative.startsWith('..') || isAbsolute(codexRelative)) return undefined;
    const match = /^([^/]+)\/([^/]+)\/workspace$/.exec(workspaceRelative);
    if (!match || match[1] !== projectId || codexRelative !== `${match[1]}/${match[2]}/codex`) return undefined;
    const local = await resolveDockerProjectData(this.projectDataOptions.root, projectId, match[2]);
    return local;
  }
  /** Return the read-only source root only for a container with the validated project generation mounts. */
  async archiveSourceRoot(sandboxId: string): Promise<string | undefined> {
    if (!this.projectDataOptions) return undefined;
    let mounts: Array<{ Type?: string; Source?: string; Destination?: string; RW?: boolean }>;
    try {
      const { stdout } = await this.call(['inspect', '--format', '{{json .Mounts}}', sandboxId]);
      mounts = JSON.parse(stdout) as typeof mounts;
    } catch { return undefined; }
    const dockerRoot = resolve(this.projectDataOptions.dockerRoot ?? this.projectDataOptions.root);
    const source = mounts.find(mount => mount.Destination === ARCHIVE_SOURCE_ROOT && mount.Type === 'bind' && mount.RW === false);
    if (!source?.Source) return undefined;
    const sourceRelative = relative(dockerRoot, resolve(source.Source));
    const workspace = mounts.find(mount => mount.Destination === '/home/user/workspace' && mount.Type === 'bind');
    const codex = mounts.find(mount => mount.Destination === '/home/user/.codex' && mount.Type === 'bind');
    if (!workspace?.Source || !codex?.Source || sourceRelative.startsWith('..') || isAbsolute(sourceRelative)) return undefined;
    const match = /^([^/]+)\/([^/]+)$/.exec(sourceRelative);
    if (!match || !PROJECT_UUID.test(match[1]) || resolve(workspace.Source) !== join(resolve(source.Source), 'workspace')
      || resolve(codex.Source) !== join(resolve(source.Source), 'codex')) return undefined;
    if (!(await resolveDockerProjectData(this.projectDataOptions.root, match[1], match[2]))) return undefined;
    return ARCHIVE_SOURCE_ROOT;
  }
  async appServer(id: string): Promise<{ url: string; token: string }> {
    const { stdout } = await this.call(['inspect', '--format', '{{index .Config.Labels "swarm-hive.app-server-port"}}\t{{.Name}}', id]);
    const [rawPort, rawName] = stdout.trim().split('\t');
    const port = Number(rawPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Sandbox does not expose a managed App Server');
    const { stdout: token } = await this.call(['exec', '--user', this.runtimeUser, id, 'cat', '/home/user/.codex-web/app-server-token']);
    if (!token.trim()) throw new Error('Sandbox App Server token is unavailable');
    const host = this.appServerHost || rawName.replace(/^\//, '');
    if (!host) throw new Error('Sandbox App Server hostname is unavailable');
    return { url: `ws://${host}:${port}`, token: token.trim() };
  }
  async inspect(id: string): Promise<DockerSandboxStatus> {
    try {
      const { stdout } = await this.call(['inspect', '--format', '{{.State.Status}}\t{{.State.Paused}}', id]);
      const [status, paused] = stdout.trim().split('\t');
      return status === 'paused' || (status === 'running' && paused === 'true') ? 'paused'
        : status === 'running' ? 'ready' : 'unavailable';
    } catch { return 'unavailable'; }
  }
  async pause(id: string) { await this.call(['pause', id]); }
  async stop(id: string) { await this.call(['stop', id], 30_000); }
  async resume(id: string) { await this.call(['unpause', id]); }
  async remove(id: string) {
    let data: DockerProjectData | undefined;
    try {
      const { stdout } = await this.call(['inspect', '--format', '{{index .Config.Labels "projectId"}}', id]);
      data = await this.projectData(stdout.trim(), id);
    } catch { /* A legacy or already removed container may have no managed generation. */ }
    if (!data) data = await this.findProjectDataBySandboxId(id);
    try { await this.call(['rm', '--force', id]); }
    catch (error) { if (!/no such (?:container|object)|not found/i.test(String(error))) throw error; }
    if (data) await rm(data.root, { recursive: true, force: true });
  }

  private async findProjectDataBySandboxId(id: string): Promise<DockerProjectData | undefined> {
    if (!this.projectDataOptions) return undefined;
    let projects;
    try { projects = await readdir(this.projectDataOptions.root, { withFileTypes: true }); }
    catch { return undefined; }
    for (const project of projects.filter(entry => entry.isDirectory())) {
      let generations;
      try { generations = await readdir(join(this.projectDataOptions.root, project.name), { withFileTypes: true }); }
      catch { continue; }
      for (const generation of generations.filter(entry => entry.isDirectory())) {
        const data = await resolveDockerProjectData(this.projectDataOptions.root, project.name, generation.name);
        if (!data) continue;
        const marker = join(data.root, 'sandbox-id');
        try {
          if ((await lstat(marker)).isFile() && (await readFile(marker, 'utf8')).trim() === id) return data;
        } catch { /* A generation may have been created before its container. */ }
      }
    }
    return undefined;
  }
  async restoreArchive(id: string, archivePath: string): Promise<void> {
    const directory = await mkdtemp(join(tmpdir(), 'swarm-hive-restore-'));
    try {
      await execFileAsync('tar', ['--exclude=home/user/.codex/AGENTS.md', '--exclude=home/user/.codex/AGENTS.md/*',
        '-xzf', archivePath, '-C', directory], { timeout: 120_000 });
      const codex = join(directory, 'home/user/.codex');
      const workspace = join(directory, 'home/user/workspace');
      if (!(await stat(codex)).isDirectory() || !(await stat(workspace)).isDirectory()) throw new Error('归档缺少工作区或 Codex 数据');
      // A fresh App Server already created SQLite sidecars. docker cp merges
      // directories, so replace absent backup sidecars with empty files rather
      // than replaying the new server's WAL over the restored database.
      for (const name of await readdir(codex)) {
        if (!name.endsWith('.sqlite')) continue;
        const owner = await stat(join(codex, name));
        for (const suffix of ['-wal', '-shm']) {
          const path = join(codex, name + suffix);
          try { await writeFile(path, '', { flag: 'wx', mode: 0o600 }); }
          catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue; throw error; }
          await chown(path, owner.uid, owner.gid);
        }
      }
      // Never overwrite SQLite while App Server has it open. Keep the new
      // container stopped on copy failure so a retry can restore the same backup.
      const status = await this.inspect(id);
      if (status === 'ready' || status === 'paused') await this.call(['stop', id], 30_000);
      await this.call(['cp', '-a', `${workspace}/.`, `${id}:/home/user/workspace`], 120_000);
      await this.call(['cp', '-a', `${codex}/.`, `${id}:/home/user/.codex`], 120_000);
      await this.call(['start', id], 30_000);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
  async archive(id: string, destination: string): Promise<{ sizeBytes: number; sha256: string }> {
    // Checkpoint all SQLite WAL files so the tar captures consistent database state.
    // Without this, the restored thread_history may be discarded by the App Server.
    try { await this.call(['exec', '--user', 'user', id, 'sh', '-c',
      'for db in /home/user/.codex/*.sqlite; do [ -f "$db" ] && sqlite3 "$db" "PRAGMA wal_checkpoint(TRUNCATE)" 2>/dev/null; done; true'
    ]); } catch { /* sqlite3 unavailable is non-fatal */ }
    const child = spawn(this.docker, ['exec', '--user', 'root', id, 'tar', '--warning=no-file-changed', '-czf', '-', '-C', '/', 'home/user/workspace', 'home/user/.codex'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const output = createWriteStream(destination, { flags: 'wx', mode: 0o600 });
    const hash = createHash('sha256'); let sizeBytes = 0; let stderr = '';
    child.stderr.setEncoding('utf8').on('data', value => { stderr += value; });
    child.stdout.on('data', chunk => { sizeBytes += chunk.length; hash.update(chunk); });
    child.stdout.pipe(output);
    const exited = new Promise<void>((resolve, reject) => child.once('error', reject).once('close', code => code === 0 ? resolve() : reject(new Error(stderr || `docker archive exited ${code}`))));
    const written = new Promise<void>((resolve, reject) => output.once('finish', resolve).once('error', reject));
    await Promise.all([exited, written]);
    return { sizeBytes, sha256: hash.digest('hex') };
  }
  /** Execute an archive driver's argv directly in a running Sandbox, retaining only the stdout tail. */
  async executeArchiveCommand(id: string, command: { executable: string; args: readonly string[]; cwd?: string; env?: Readonly<Record<string, string>> }): Promise<{ exitCode: number; stdout: string }> {
    if (await this.inspect(id) !== 'ready') throw new Error('Archive commands require a running Docker Sandbox');
    if (!command.executable || command.executable.includes('\0') || command.args.some(value => value.includes('\0'))
      || (command.cwd && (!isAbsolute(command.cwd) || command.cwd.includes('\0')))) throw new Error('Invalid archive command');
    const args = ['exec', '--user', this.runtimeUser];
    if (command.cwd) args.push('--workdir', command.cwd);
    for (const [key, value] of Object.entries(command.env ?? {})) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || value.includes('\0')) throw new Error('Invalid archive command environment');
      args.push('--env', `${key}=${value}`);
    }
    // GNU timeout runs inside the container, so killing the CLI at the deadline
    // also terminates the backup process attached to Docker exec.
    args.push(id, 'timeout', '--signal=TERM', '--kill-after=10s', '10800s', command.executable, ...command.args);
    const child = spawn(this.docker, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let chunks: Buffer[] = [];
    let retained = 0;
    let truncated = false;
    child.stdout.on('data', chunk => {
      const value = Buffer.from(chunk);
      chunks.push(value);
      retained += value.length;
      while (retained > MAX_ARCHIVE_STDOUT_BYTES && chunks.length) {
        truncated = true;
        const excess = retained - MAX_ARCHIVE_STDOUT_BYTES;
        if (chunks[0].length <= excess) { retained -= chunks[0].length; chunks.shift(); }
        else { chunks[0] = chunks[0].subarray(excess); retained -= excess; }
      }
    });
    let stderr = '';
    child.stderr.setEncoding('utf8').on('data', (value: string) => {
      stderr = (stderr + value).slice(-4096);
    });
    const exitCode = await new Promise<number>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', code => resolve(code ?? 1));
    });
    let stdout = Buffer.concat(chunks, retained).toString('utf8');
    if (truncated) {
      const firstLine = stdout.indexOf('\n');
      stdout = firstLine < 0 ? '' : stdout.slice(firstLine + 1);
    }
    if (exitCode !== 0) throw new Error(`Archive command exited ${exitCode}: ${stderr.trim() || 'no error output'}`);
    return { exitCode, stdout };
  }
  /** Checkpoint current SQLite WALs. The caller must hold maintenance; this does not fence arbitrary Sandbox writes. */
  async quiesceForBackup(id: string): Promise<() => Promise<void>> {
    if (await this.inspect(id) !== 'ready') throw new Error('Backup checkpoint requires a running Docker Sandbox');
    const checkpoint = await this.exec(id,
      'for db in /home/user/.codex/*.sqlite; do if [ -f "$db" ]; then result=$(sqlite3 "$db" "PRAGMA wal_checkpoint(TRUNCATE)") || exit 1; [ "${result%%|*}" = 0 ] || exit 1; fi; done',
      { timeoutMs: 30_000 });
    if (checkpoint.exitCode !== 0) throw new Error(checkpoint.stderr || 'SQLite checkpoint failed');
    return async () => {};
  }
  async exec(id: string, command: string, options: DockerExecOptions = {}): Promise<DockerExecResult> {
    const args = ['exec']; for (const [key, value] of Object.entries(options.env ?? {})) args.push('--env', `${key}=${value}`); if (options.cwd) args.push('--workdir', options.cwd); args.push('--user', options.user ?? this.runtimeUser, id, 'sh', '-lc', command);
    try { const result = await this.call(args, options.timeoutMs, options.signal); return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 }; } catch (error) { const value = error as { stdout?: string; stderr?: string; code?: number }; return { stdout: value.stdout ?? '', stderr: value.stderr ?? String(error), exitCode: typeof value.code === 'number' ? value.code : 1 }; }
  }
  execAttached(id: string, command: string, options: DockerExecOptions = {}): DockerExecHandle {
    const args = ['exec'];
    for (const [key, value] of Object.entries(options.env ?? {})) args.push('--env', `${key}=${value}`);
    if (options.cwd) args.push('--workdir', options.cwd);
    args.push('--user', options.user ?? this.runtimeUser, id, 'sh', '-lc', command);
    const child = spawn(this.docker, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', settled = false;
    child.stdout.setEncoding('utf8').on('data', value => { stdout += value; options.onStdout?.(value); });
    child.stderr.setEncoding('utf8').on('data', value => { stderr += value; options.onStderr?.(value); });
    const abort = () => { child.kill('SIGTERM'); };
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    const result = new Promise<DockerExecResult>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => {
        settled = true;
        resolve({ stdout, stderr: stderr || (signal ? `docker exec terminated by ${signal}` : ''), exitCode: code ?? 1 });
      });
    });
    const timer = options.timeoutMs && options.timeoutMs > 0
      ? setTimeout(() => child.kill('SIGKILL'), options.timeoutMs)
      : undefined;
    timer?.unref();
    void result.then(() => { if (timer) clearTimeout(timer); options.signal?.removeEventListener('abort', abort); }, () => {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
    });
    return {
      wait: () => result,
      kill: async () => settled ? false : child.kill('SIGTERM'),
      disconnect: async () => {
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
      },
    };
  }
  async readFile(id: string, path: string): Promise<Buffer> { const result = await this.exec(id, `base64 -w0 -- ${JSON.stringify(path)}`); if (result.exitCode) throw new Error(result.stderr); return Buffer.from(result.stdout, 'base64'); }
  async writeFile(id: string, path: string, content: Buffer, user = this.runtimeUser): Promise<void> {
    const parent = path.slice(0, Math.max(path.lastIndexOf('/'), 1));
    const prepared = await this.exec(id, `mkdir -p -- ${JSON.stringify(parent)}`, { user });
    if (prepared.exitCode) throw new Error(prepared.stderr);
    // `docker cp` from inside the Web Compose container relies on a Docker
    // Desktop bind-mount translation that can disappear between requests.
    // Stream the content over docker exec instead; the daemon never needs a
    // path from the Web container's filesystem.
    const encoded = content.toString('base64');
    await new Promise<void>((resolve, reject) => {
      const child = spawn(this.docker, ['exec', '-i', '--user', user, id, 'sh', '-lc', `umask 077; base64 -d > ${JSON.stringify(path)}`],
        { stdio: ['pipe', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr.setEncoding('utf8').on('data', value => { stderr += value; });
      child.stdin.on('error', () => { /* close handler reports the command failure */ });
      child.once('error', reject).once('close', code => code === 0 ? resolve() : reject(new Error(stderr || `docker exec write exited ${code}`)));
      child.stdin.end(encoded);
    });
  }
  async list(): Promise<DockerSandboxRecord[]> {
    // Project bindings persist Docker's full 64-character ID. `docker ps`
    // otherwise emits its 12-character display ID and every live Sandbox is
    // incorrectly classified as dangling by the inventory view.
    const outputs = await Promise.all(['co-cell.group=cellbox', 'swarm-hive.group=swarm-hive-sandbox', 'app=swarm-hive'].map(label => this.call(['ps', '-a', '--no-trunc', '--filter', `label=${label}`, '--format', '{{.ID}}\\t{{.Image}}\\t{{.State}}\\t{{.Label "projectId"}}']).then(value => value.stdout)));
    const rows = new Map<string, DockerSandboxRecord>();
    for (const output of outputs) for (const line of output.trim().split('\n').filter(Boolean)) {
      const [id, image, state, projectId] = line.split('\t');
      rows.set(id, { id, image, projectId, workingDirectory: '/home/user/workspace', createdAt: '', status: state === 'running' ? 'ready' : state === 'paused' ? 'paused' : 'unavailable' });
    }
    return Promise.all([...rows.values()].map(async row => {
      try {
        const details = await this.containerDetails(row.id);
        return { ...row, image: details.imageIdentity.reference, imageIdentity: details.imageIdentity,
          createdAt: details.createdAt, status: details.status };
      } catch {
        // A container can disappear between `docker ps` and `docker inspect`.
        // Keep it in inventory using the information already returned by ps.
        return row;
      }
    }));
  }
}
