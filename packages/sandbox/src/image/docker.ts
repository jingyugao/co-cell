import { execFile, spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { join } from 'node:path';
import type { SandboxBundle, SandboxBundleOptions, SandboxImage, SandboxImageManager } from './types.js';

const execFileAsync = promisify(execFile);

/** Converts a Docker image into an OCI bundle for a host-side runsc provider. */
export class DockerSandboxImageManager implements SandboxImageManager {
  constructor(private readonly rootDirectory: string, private readonly docker = 'docker') {}

  private async call(args: string[]) { return execFileAsync(this.docker, args, { maxBuffer: 16 * 1024 * 1024 }); }

  async inspect(reference: string): Promise<SandboxImage> {
    const { stdout } = await this.call(['image', 'inspect', '--format', '{{.Id}}', reference]);
    return { reference, id: stdout.trim() };
  }

  async prepareBundle(image: SandboxImage, sandboxId: string, options: SandboxBundleOptions = {}): Promise<SandboxBundle> {
    if (!/^[A-Za-z0-9_.-]{1,128}$/.test(sandboxId)) throw new Error('Invalid sandbox ID');
    const path = join(this.rootDirectory, 'bundles', sandboxId);
    const rootfs = join(path, 'rootfs');
    await mkdir(rootfs, { recursive: true, mode: 0o755 });
    const { stdout } = await this.call(['create', '--name', `swarm-hive-export-${sandboxId}-${Date.now()}`, image.reference]);
    const containerId = stdout.trim();
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(this.docker, ['export', containerId], { stdio: ['ignore', 'pipe', 'pipe'] });
        const tar = spawn('tar', ['-C', rootfs, '-xf', '-'], { stdio: ['pipe', 'ignore', 'pipe'] });
        let stderr = '';
        child.stderr.setEncoding('utf8').on('data', value => { stderr += value; });
        tar.stderr.setEncoding('utf8').on('data', value => { stderr += value; });
        child.stdout.pipe(tar.stdin);
        let childCode: number | null = null; let tarCode: number | null = null;
        const finish = () => childCode !== null && tarCode !== null && (childCode || tarCode ? reject(new Error(stderr || 'image export failed')) : resolve());
        child.once('close', code => { childCode = code; finish(); });
        tar.once('close', code => { tarCode = code; finish(); });
        child.once('error', reject); tar.once('error', reject);
      });
    } finally {
      await this.call(['rm', '-f', containerId]).catch(() => {});
    }
    const configPath = join(path, 'config.json');
    const process = options.process;
    await writeFile(configPath, JSON.stringify({
      ociVersion: '1.0.2', process: { terminal: false,
        user: { uid: process?.uid ?? 0, gid: process?.gid ?? 0 },
        args: process?.args ?? ['/bin/sh', '-c', 'while true; do sleep 3600; done'], cwd: process?.cwd ?? '/',
        env: Object.entries({ PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', ...(process?.env ?? {}) }).map(([key, value]) => `${key}=${value}`),
      },
      root: { path: 'rootfs', readonly: false }, mounts: [
        { destination: '/proc', type: 'proc', source: 'proc' },
        { destination: '/dev', type: 'tmpfs', source: 'tmpfs' },
        { destination: '/sys', type: 'sysfs', source: 'sysfs', options: ['nosuid', 'noexec', 'nodev', 'ro'] },
        ...(options.mounts ?? []).map(mount => ({ destination: mount.destination, type: 'bind', source: mount.source,
          options: ['rbind', 'nosuid', 'nodev', ...(mount.readonly === false ? [] : ['ro'])] })),
      ], linux: { namespaces: [{ type: 'pid' }, { type: 'mount' }, { type: 'uts' }, { type: 'ipc' },
        { type: 'network', ...(options.networkNamespace ? { path: options.networkNamespace } : {}) }] }, hostname: 'gvisor',
    }, null, 2) + '\n', { mode: 0o644 });
    return { id: sandboxId, image, path, rootfs, configPath };
  }

  async removeBundle(bundle: SandboxBundle) { await rm(bundle.path, { recursive: true, force: true }); }
}
