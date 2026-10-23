import { chmod, lstat, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { credentialPath } from './policy.js';

/** One persistent HOME. Application startup never republishes credential files. */
export class MountedToolHomes {
  constructor(private root: string) {}
  private locations() { return { home: join(this.root, 'runtime/debug-homes') }; }
  async init() {
    const runtime = join(this.root, 'runtime');
    await mkdir(runtime, { recursive: true, mode: 0o755 });
    const parent = await lstat(runtime);
    if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error('Unsafe credential directory');
    const home = this.locations().home;
    await mkdir(home, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    const info = await lstat(home);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe credential directory');
    await chmod(home, 0o700);
  }
  async hasFile(path: string) {
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
}
