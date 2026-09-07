import { readdir, readFile } from 'node:fs/promises';

const SOURCE = new URL('../data/docs/', import.meta.url);

/** Only this dedicated directory is published, never other application data. */
export async function loadAgentDocs(directory = SOURCE, prefix = ''): Promise<{ path: string; contents: ArrayBuffer }[]> {
  const files: { path: string; contents: ArrayBuffer }[] = [];
  const entries = await readdir(directory, { withFileTypes: true }).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  for (const entry of entries) {
    if (entry.name.startsWith('.shared-write-')) continue;
    const relative = prefix + entry.name;
    const location = new URL(encodeURIComponent(entry.name) + (entry.isDirectory() ? '/' : ''), directory);
    if (entry.isDirectory()) files.push(...await loadAgentDocs(location, relative + '/'));
    else if (entry.isFile()) files.push({ path: relative, contents: new Uint8Array(await readFile(location)).buffer });
    // Do not follow symlinks out of the shared documentation directory.
  }
  return files;
}
