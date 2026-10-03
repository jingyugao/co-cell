import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadAgentDocs } from './agent-docs.js';

/** Publish once on service startup; Sandboxes read the directory directly. */
export async function publishSharedDirectory(root: string, legacyRoot: string,
  config: { version: number; appServerArgs: string[]; env: Record<string, string> }) {
  await mkdir(root, { recursive: true, mode: 0o755 });
  await mkdir(join(root, 'docs'), { recursive: true, mode: 0o755 });
  await mkdir(join(root, 'runtime'), { recursive: true, mode: 0o755 });
  for (const path of [root, join(root, 'docs'), join(root, 'runtime')]) await chmod(path, 0o755);
  const marker = join(root, 'runtime', 'migrated');
  if (root !== legacyRoot && await readFile(marker).then(() => false, error => {
    if (error.code === 'ENOENT') return true;
    throw error;
  })) {
    const agents = await readFile(join(legacyRoot, 'AGENTS.md')).catch(error => {
      if (error.code === 'ENOENT') return Buffer.alloc(0);
      throw error;
    });
    const docs = await loadAgentDocs(pathToFileURL(`${join(legacyRoot, 'docs')}/`));
    for (const file of [{ path: 'AGENTS.md', contents: agents }, ...docs.map(file => ({ ...file, path: `docs/${file.path}` }))]) {
      const destination = join(root, file.path);
      await mkdir(dirname(destination), { recursive: true, mode: 0o755 });
      const bytes = file.contents instanceof ArrayBuffer ? new Uint8Array(file.contents) : file.contents;
      await writeFile(destination, bytes, { flag: 'wx', mode: 0o644 }).catch(error => {
        if (error.code !== 'EEXIST') throw error;
      });
    }
    await writeFile(marker, '', { mode: 0o644 });
  }
  const destination = join(root, 'runtime', 'config.json');
  await writeFile(join(root, 'AGENTS.md'), '', { flag: 'wx', mode: 0o644 }).catch(error => {
    if (error.code !== 'EEXIST') throw error;
  });
  const bytes = JSON.stringify(config);
  if (Buffer.byteLength(bytes) > 64 * 1024) throw new Error('Shared startup config exceeds 64 KiB');
  if (await readFile(destination, 'utf8').catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  }) === bytes) return;
  const temp = join(root, 'runtime', `.config-${randomUUID()}.tmp`);
  try {
    await writeFile(temp, bytes, { flag: 'wx', mode: 0o644 });
    await chmod(temp, 0o644);
    await rename(temp, destination);
  } finally { await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}
