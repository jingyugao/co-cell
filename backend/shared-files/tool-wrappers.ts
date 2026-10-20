import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const sources = [
  'deploy/box-wrap/tool-client.mjs',
  'deploy/box-wrap/protected-tool.mjs',
  'util/tool-working-directory.mjs',
  'util/gitlab-tool-host.mjs',
  'util/tool-runtime-identity.mjs',
];

async function readToolWrapperAssets() {
  return Promise.all(sources.map(async path => ({ path,
    content: await readFile(new URL(`../../${path}`, import.meta.url), 'utf8') })));
}

/** Keep complete generations available to in-flight Node imports across updates. */
export async function publishToolWrappers(sharedRoot: string) {
  const files = await readToolWrapperAssets();
  const version = createHash('sha256').update(JSON.stringify(files)).digest('hex');
  const root = join(sharedRoot, 'tool-wrap'), versions = join(root, 'versions');
  for (const directory of [root, versions]) {
    await mkdir(directory, { recursive: true, mode: 0o755 });
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Invalid shared tool wrapper directory');
    await chmod(directory, 0o755);
  }
  const target = join(versions, version);
  const staging = await mkdtemp(join(versions, '.publish-'));
  try {
    await chmod(staging, 0o755);
    for (const file of files) {
      const path = join(staging, file.path);
      await mkdir(dirname(path), { recursive: true, mode: 0o755 });
      await writeFile(path, file.content, { flag: 'wx', mode: 0o644 });
    }
    try { await rename(staging, target); }
    catch (error) {
      if (!['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    }
    // Existing versions are immutable: reject corrupt contents rather than
    // replacing files that another process may already be importing.
    const info = await lstat(target);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Invalid shared tool wrapper version');
    for (const file of files) {
      let path = target;
      for (const part of file.path.split('/')) {
        path = join(path, part);
        if ((await lstat(path)).isSymbolicLink()) throw new Error('Invalid shared tool wrapper asset');
      }
      if (await readFile(path, 'utf8') !== file.content) throw new Error('Shared tool wrapper version contents changed');
    }
    const pointer = join(root, `.current-${randomUUID()}`);
    try {
      await symlink(`versions/${version}`, pointer);
      await rename(pointer, join(root, 'current'));
    } finally { await unlink(pointer).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }); }
  } finally { await rm(staging, { recursive: true, force: true }); }
  return version;
}
