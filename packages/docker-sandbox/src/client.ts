import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import type { DockerExecHandle, DockerExecOptions, DockerExecResult, DockerSandboxRecord, DockerSandboxStatus } from './types.js';

const execFileAsync = promisify(execFile);

export class DockerSandboxClient {
  constructor(private readonly image: string, private readonly docker = 'docker', private readonly network = 'host', private readonly credentialsHostDirectory?: string,
    private readonly appServerTokenHostPath?: string, private readonly sharedAgentsHostPath?: string, private readonly appServerHost?: string,
    private readonly appServerEnvironment: Record<string, string> = {}) {}
  private async call(args: string[], timeout?: number, signal?: AbortSignal) { return execFileAsync(this.docker, args, { timeout, signal, maxBuffer: 16 * 1024 * 1024 }); }
  async create(projectId: string, workingDirectory: string): Promise<DockerSandboxRecord> {
    const name = `swarm-hive-sandbox-${projectId.slice(0, 12)}-${randomUUID().slice(0, 8)}`;
    // Sandboxes share Docker's host network so project preview ports remain
    // reachable. Give each long-lived App Server a distinct private port.
    const appServerPort = 20_000 + (parseInt(randomUUID().replaceAll('-', '').slice(0, 6), 16) % 20_000);
    const args = ['run', '-d', '--name', name, '--network', this.network,
      '--workdir', workingDirectory, '--label', 'app=swarm-hive-sandbox',
      '--label', 'swarm-hive.group=swarm-hive-sandbox',
      // A configured image may carry Compose labels. Override them so Docker
      // Desktop groups project sandboxes separately without making Compose own
      // their lifecycle.
      '--label', 'com.docker.compose.project=swarm-hive-sandbox',
      '--label', 'com.docker.compose.service=project-sandbox',
      '--label', `swarm-hive.app-server-port=${appServerPort}`,
      '--env', `CODEX_APP_SERVER_PORT=${appServerPort}`,
      '--label', `projectId=${projectId}`];
    for (const [key, value] of Object.entries(this.appServerEnvironment)) args.push('--env', `${key}=${value}`);
    // This is a stable host directory, rather than a per-turn generated
    // directory. A bind mount lets operators update CLI configuration without
    // recreating a Sandbox. Trusted personal deployments may let agents
    // update the host-managed files as well.
    if (this.credentialsHostDirectory) args.push('--mount', `type=bind,src=${this.credentialsHostDirectory},dst=/home/user/.codex-web/credentials/current`);
    if (this.appServerTokenHostPath) args.push('--mount', `type=bind,src=${this.appServerTokenHostPath},dst=/home/user/.codex-web/app-server-token`);
    // The App Server is started with the container and discovers AGENTS.md at
    // thread creation time. Mount the global rules rather than copying them
    // after the server has already started.
    if (this.sharedAgentsHostPath) args.push('--mount', `type=bind,src=${this.sharedAgentsHostPath},dst=/home/user/.codex/AGENTS.md`);
    args.push(this.image);
    const { stdout } = await this.call(args);
    return { id: stdout.trim(), image: this.image, status: 'ready', projectId, workingDirectory, createdAt: new Date().toISOString() };
  }
  async appServer(id: string): Promise<{ url: string; token: string }> {
    const { stdout } = await this.call(['inspect', '--format', '{{index .Config.Labels "swarm-hive.app-server-port"}}\t{{.Name}}', id]);
    const [rawPort, rawName] = stdout.trim().split('\t');
    const port = Number(rawPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Sandbox does not expose a managed App Server');
    const { stdout: token } = await this.call(['exec', '--user', 'user', id, 'cat', '/home/user/.codex-web/app-server-token']);
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
  async resume(id: string) { await this.call(['unpause', id]); }
  async remove(id: string) { await this.call(['rm', '--force', id]); }
  async archive(id: string, destination: string): Promise<{ sizeBytes: number; sha256: string }> {
    const child = spawn(this.docker, ['exec', '--user', 'root', id, 'tar', '-czf', '-', '-C', '/', 'home/user/workspace', 'home/user/.codex'], { stdio: ['ignore', 'pipe', 'pipe'] });
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
  async exec(id: string, command: string, options: DockerExecOptions = {}): Promise<DockerExecResult> {
    const args = ['exec']; for (const [key, value] of Object.entries(options.env ?? {})) args.push('--env', `${key}=${value}`); if (options.cwd) args.push('--workdir', options.cwd); args.push('--user', options.user ?? 'user', id, 'sh', '-lc', command);
    try { const result = await this.call(args, options.timeoutMs, options.signal); return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 }; } catch (error) { const value = error as { stdout?: string; stderr?: string; code?: number }; return { stdout: value.stdout ?? '', stderr: value.stderr ?? String(error), exitCode: typeof value.code === 'number' ? value.code : 1 }; }
  }
  execAttached(id: string, command: string, options: DockerExecOptions = {}): DockerExecHandle {
    const args = ['exec'];
    for (const [key, value] of Object.entries(options.env ?? {})) args.push('--env', `${key}=${value}`);
    if (options.cwd) args.push('--workdir', options.cwd);
    args.push('--user', options.user ?? 'user', id, 'sh', '-lc', command);
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
  async writeFile(id: string, path: string, content: Buffer, user = 'user'): Promise<void> {
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
    const outputs = await Promise.all(['swarm-hive.group=swarm-hive-sandbox', 'app=swarm-hive'].map(label => this.call(['ps', '-a', '--no-trunc', '--filter', `label=${label}`, '--format', '{{.ID}}\\t{{.Image}}\\t{{.State}}\\t{{.Label "projectId"}}']).then(value => value.stdout)));
    const rows = new Map<string, DockerSandboxRecord>();
    for (const output of outputs) for (const line of output.trim().split('\n').filter(Boolean)) {
      const [id, image, state, projectId] = line.split('\t');
      rows.set(id, { id, image, projectId, workingDirectory: '/home/user/workspace', createdAt: '', status: state === 'running' ? 'ready' : state === 'paused' ? 'paused' : 'unavailable' });
    }
    return [...rows.values()];
  }
}
