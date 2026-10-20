import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ProvisionedToolFile } from '../../protocol/secret-types.js';
import { credentialPath } from './policy.js';

type Binding = Pick<ProvisionedToolFile, 'tool' | 'secretId' | 'path' | 'version' | 'revision' | 'externallyManaged'>;

/** One persistent debug HOME; project lifecycles never own these files. */
export class MountedToolHomes {
  private pending: Promise<void> = Promise.resolve();
  constructor(private root: string) {}
  private locations() {
    return { home: join(this.root, 'runtime/debug-homes'),
      manifest: join(this.root, 'runtime/debug-home-files.json') };
  }
  async init() {
    await this.directory(join(this.root, 'runtime'), 0o755);
    await this.directory(join(this.root, 'runtime/debug-homes'));
  }
  private async bindings(): Promise<Binding[] | null> {
    try { return JSON.parse(await readFile(this.locations().manifest, 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  }
  async hasFile(path: string) {
    await this.pending;
    let target = this.locations().home;
    try {
      for (const part of credentialPath(path).split('/')) {
        const parent = await lstat(target);
        if (!parent.isDirectory() || parent.isSymbolicLink()) return false;
        target = join(target, part);
      }
      const info = await lstat(target);
      return info.isFile() && !info.isSymbolicLink();
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  }
  async read(path: string) {
    if (!await this.hasFile(path)) return undefined;
    return readFile(join(this.locations().home, credentialPath(path)));
  }
  private async directory(path: string, mode = 0o700) {
    await mkdir(path, { recursive: true, mode });
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe credential directory');
    await chmod(path, mode);
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
  publish(resolveFiles: () => Promise<ProvisionedToolFile[]>) {
    const current = this.pending.catch(() => {}).then(async () => this.write(await resolveFiles()));
    this.pending = current.catch(() => {});
    return current;
  }
  private async write(files: ProvisionedToolFile[]) {
    const { home, manifest } = this.locations();
    const next: Binding[] = files.map(({ tool, secretId, path, version, revision, format, externallyManaged }) => {
      if (format && format !== 'text') throw new Error('Mounted HOME supports text credential files only');
      return { tool, secretId, path: credentialPath(path), version, ...(revision ? { revision } : {}), ...(externallyManaged ? { externallyManaged: true } : {}) };
    });
    if (new Set(next.map(file => JSON.stringify([file.tool, file.secretId, file.path]))).size !== next.length)
      throw new Error('Duplicate tool credential file');
    for (let i = 0; i < next.length; i++) for (let j = i + 1; j < next.length; j++) {
      const a = next[i].path, b = next[j].path;
      if (a === b || a.startsWith(b + '/') || b.startsWith(a + '/')) throw new Error('Credential HOME paths conflict');
    }
    const old = await this.bindings() ?? [];
    await this.directory(home);
    for (let i = 0; i < next.length; i++) {
      const file = next[i];
      let parent = home;
      for (const part of file.path.split('/').slice(0, -1)) {
        parent = join(parent, part); await this.directory(parent);
      }
      if (file.externallyManaged) continue;
      if (old.some(previous => JSON.stringify(previous) === JSON.stringify(file))) {
        try {
          const info = await lstat(join(home, file.path));
          if (!info.isFile() || info.isSymbolicLink()) throw new Error('Unsafe credential file');
          continue;
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
      const bytes = Buffer.from(files[i].content, 'base64');
      if (!bytes.length || bytes.length > (file.revision ? 1024 * 1024 : 65536) || bytes.toString('base64') !== files[i].content) throw new Error('Invalid credential file');
      await this.atomicFile(join(home, file.path), bytes);
    }
    for (const file of old) if (!file.externallyManaged && !next.some(value => value.path === file.path || value.externallyManaged && value.secretId === file.secretId)) {
      // Only remove files previously published by CoCell. CLI caches remain.
      let parent = home;
      for (const part of credentialPath(file.path).split('/').slice(0, -1)) {
        parent = join(parent, part);
        const info = await lstat(parent);
        if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe credential directory');
      }
      await rm(join(home, file.path), { force: true });
    }
    // The launcher reads runtime/config.json as the agent. Only the HOME and
    // credential manifest are private; their shared parent must stay traversable.
    await this.directory(dirname(manifest), 0o755);
    await this.atomicFile(manifest, Buffer.from(JSON.stringify(next)));
  }
  async ready(binding: Binding) {
    await this.pending;
    return (await this.bindings())?.some(file => JSON.stringify(file) === JSON.stringify(binding)) ?? false;
  }
}
