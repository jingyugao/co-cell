import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DockerExecHandle, DockerExecOptions, DockerExecResult, DockerSandboxRecord, DockerSandboxStatus } from './types.js';

const execFileAsync = promisify(execFile);

export class DockerSandboxClient {
  constructor(private readonly image: string, private readonly docker = 'docker', private readonly network = 'host') {}
  private async call(args: string[], timeout?: number, signal?: AbortSignal) { return execFileAsync(this.docker, args, { timeout, signal, maxBuffer: 16 * 1024 * 1024 }); }
  async create(projectId: string, workingDirectory: string): Promise<DockerSandboxRecord> {
    const name = `swarm-hive-sandbox-${projectId.slice(0, 12)}-${randomUUID().slice(0, 8)}`;
    const { stdout } = await this.call(['run', '-d', '--name', name, '--network', this.network,
      '--workdir', workingDirectory, '--label', 'app=swarm-hive-sandbox',
      '--label', 'swarm-hive.group=swarm-hive-sandbox',
      // A configured image may carry Compose labels. Override them so Docker
      // Desktop groups project sandboxes separately without making Compose own
      // their lifecycle.
      '--label', 'com.docker.compose.project=swarm-hive-sandbox',
      '--label', 'com.docker.compose.service=project-sandbox',
      '--label', `projectId=${projectId}`, this.image]);
    return { id: stdout.trim(), image: this.image, status: 'ready', projectId, workingDirectory, createdAt: new Date().toISOString() };
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
  async writeFile(id: string, path: string, content: Buffer, user = 'user'): Promise<void> { const directory = await mkdtemp(join(tmpdir(), 'docker-sandbox-')); const local = join(directory, 'file'); try { await writeFile(local, content, { mode: 0o600 }); const parent = path.slice(0, Math.max(path.lastIndexOf('/'), 1)); const prepared = await this.exec(id, `mkdir -p -- ${JSON.stringify(parent)}`, { user }); if (prepared.exitCode) throw new Error(prepared.stderr); await this.call(['cp', local, `${id}:${path}`]); const owned = await this.exec(id, `chown ${JSON.stringify(user)} -- ${JSON.stringify(path)}`, { user: 'root' }); if (owned.exitCode) throw new Error(owned.stderr); } finally { await rm(directory, { recursive: true, force: true }); } }
  async list(): Promise<DockerSandboxRecord[]> {
    const outputs = await Promise.all(['swarm-hive.group=swarm-hive-sandbox', 'app=swarm-hive'].map(label => this.call(['ps', '-a', '--filter', `label=${label}`, '--format', '{{.ID}}\\t{{.Image}}\\t{{.State}}\\t{{.Label "projectId"}}']).then(value => value.stdout)));
    const rows = new Map<string, DockerSandboxRecord>();
    for (const output of outputs) for (const line of output.trim().split('\n').filter(Boolean)) {
      const [id, image, state, projectId] = line.split('\t');
      rows.set(id, { id, image, projectId, workingDirectory: '/home/user/workspace', createdAt: '', status: state === 'running' ? 'ready' : state === 'paused' ? 'paused' : 'unavailable' });
    }
    return [...rows.values()];
  }
}
