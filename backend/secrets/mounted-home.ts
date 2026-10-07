import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ProvisionedToolFile } from '../../protocol/secret-types.js';
import { credentialPath } from './policy.js';

type Binding = Pick<ProvisionedToolFile, 'tool' | 'secretId' | 'path' | 'version'>;

/** Native CLI files live here, rather than in the checkpoint or an API response. */
export class MountedToolHomes {
  private pending = new Map<string, Promise<void>>();
  constructor(private root: string) {}
  private locations(projectId: string) {
    if (!/^[a-z0-9][a-z0-9-]{0,54}$/.test(projectId)) throw new Error('Invalid project identity');
    return { home: join(this.root, 'runtime/debug-homes', projectId),
      manifest: join(this.root, 'runtime/project-homes', projectId, 'home-files.json') };
  }
  async init() { await this.directory(join(this.root, 'runtime/debug-homes')); }
  private async bindings(projectId: string): Promise<Binding[] | null> {
    try { return JSON.parse(await readFile(this.locations(projectId).manifest, 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  }
  async exists(projectId: string) { await this.pending.get(projectId); return (await this.bindings(projectId)) !== null; }
  private async directory(path: string) {
    await mkdir(path, { recursive: true, mode: 0o700 });
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe credential directory');
    await chmod(path, 0o700);
  }
  private async atomicFile(path: string, bytes: Uint8Array) {
    const temporary = join(dirname(path), `.cocell-${randomUUID()}`);
    try {
      const file = await open(temporary, 'wx', 0o600);
      try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
      await rename(temporary, path);
      const directory = await open(dirname(path), 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    } finally { await rm(temporary, { force: true }); }
  }
  publish(projectId: string, resolveFiles: () => Promise<ProvisionedToolFile[]>) {
    const previous = this.pending.get(projectId) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(async () => this.write(projectId, await resolveFiles()));
    this.pending.set(projectId, current);
    return current.finally(() => { if (this.pending.get(projectId) === current) this.pending.delete(projectId); });
  }
  private async write(projectId: string, files: ProvisionedToolFile[]) {
    const { home, manifest } = this.locations(projectId);
    const next: Binding[] = files.map(({ tool, secretId, path, version, format }) => {
      if (format && format !== 'text') throw new Error('Mounted HOME supports one text credential file per tool');
      return { tool, secretId, path: credentialPath(path), version };
    });
    if (new Set(next.map(file => file.tool)).size !== next.length) throw new Error('Only one credential file per tool is supported');
    for (let i = 0; i < next.length; i++) for (let j = i + 1; j < next.length; j++) {
      const a = next[i].path, b = next[j].path;
      if (a === b || a.startsWith(b + '/') || b.startsWith(a + '/')) throw new Error('Credential HOME paths conflict');
    }
    const old = await this.bindings(projectId) ?? [];
    await this.directory(home);
    for (let i = 0; i < next.length; i++) {
      const file = next[i];
      let parent = home;
      for (const part of file.path.split('/').slice(0, -1)) {
        parent = join(parent, part); await this.directory(parent);
      }
      if (old.some(previous => JSON.stringify(previous) === JSON.stringify(file))) {
        try {
          const info = await lstat(join(home, file.path));
          if (!info.isFile() || info.isSymbolicLink()) throw new Error('Unsafe credential file');
          continue;
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
      const bytes = Buffer.from(files[i].content, 'base64');
      if (!bytes.length || bytes.length > 65536 || bytes.toString('base64') !== files[i].content) throw new Error('Invalid credential file');
      await this.atomicFile(join(home, file.path), bytes);
    }
    for (const file of old) if (!next.some(value => value.path === file.path)) {
      // Only remove files previously published by CoCell. CLI caches remain.
      let parent = home;
      for (const part of credentialPath(file.path).split('/').slice(0, -1)) {
        parent = join(parent, part);
        const info = await lstat(parent);
        if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe credential directory');
      }
      await rm(join(home, file.path), { force: true });
    }
    await this.directory(dirname(manifest));
    await this.atomicFile(manifest, Buffer.from(JSON.stringify(next)));
  }
  async ready(projectId: string, binding: Binding) {
    await this.pending.get(projectId);
    return (await this.bindings(projectId))?.some(file => JSON.stringify(file) === JSON.stringify(binding)) ?? false;
  }
}
