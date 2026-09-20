import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export interface SandboxMount { source: string; destination: string; readonly: boolean; }

const sections: Record<string, boolean> = { rw_mount: false, r_mount: true };

/** Read the deliberately small mount-map subset of TOML used by sandbox.toml. */
export async function loadSandboxMounts(path = resolve('sandbox.toml'), hostRoot = process.env.SANDBOX_MOUNT_ROOT): Promise<SandboxMount[]> {
  let text: string;
  try { text = await readFile(path, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  let section: boolean | undefined;
  const seen = new Set<string>();
  const mounts: SandboxMount[] = [];
  for (const [index, raw] of text.split('\n').entries()) {
    const line = raw.trimStart().startsWith('#') ? '' : raw.replace(/\s+#.*$/, '').trim();
    if (!line) continue;
    const header = /^\[([a-z_]+)\]$/.exec(line);
    if (header) { section = sections[header[1]]; if (section === undefined) throw new Error(`sandbox.toml:${index + 1}: unsupported section`); continue; }
    const entry = /^(?:"([^"\\]*(?:\\.[^"\\]*)*)"|([A-Za-z0-9_.-]+))\s*=\s*"([^"\\]*(?:\\.[^"\\]*)*)"\s*$/.exec(line);
    if (section === undefined || !entry) throw new Error(`sandbox.toml:${index + 1}: expected a quoted path mapping in a mount section`);
    const destination = (entry[1] ?? entry[2]!).replace(/\\"/g, '"');
    const source = entry[3].replace(/\\"/g, '"');
    const expanded = destination === '~' ? '/home/user' : destination.startsWith('~/') ? `/home/user/${destination.slice(2)}` : destination;
    if (!expanded.startsWith('/home/user/') || expanded.includes('\0') || source.includes('\0')) throw new Error(`sandbox.toml:${index + 1}: destination must be inside /home/user`);
    if (seen.has(expanded)) throw new Error(`sandbox.toml:${index + 1}: duplicate destination`);
    seen.add(expanded); mounts.push({ source: resolve(hostRoot || dirname(path), source), destination: expanded, readonly: section });
  }
  return mounts;
}
