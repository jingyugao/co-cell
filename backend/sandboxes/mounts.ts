import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export interface SandboxMount { source: string; destination: string; readonly: boolean; }

export interface SandboxRuntimeConfig {
  image?: string;
  workingDirectory?: string;
  user?: string;
  network?: string;
  uid?: number;
  gid?: number;
}

export interface SandboxConfig {
  mounts: SandboxMount[];
  runtime: SandboxRuntimeConfig;
}

const mountSections: Record<string, boolean> = { rw_mount: false, r_mount: true };
const runtimeKeys = new Set(['image', 'working_directory', 'user', 'network', 'uid', 'gid']);

function textValue(value: string, path: string, line: number): string {
  const entry = /^"([^"\\]*(?:\\.[^"\\]*)*)"$/.exec(value);
  if (!entry) throw new Error(`${path}:${line}: expected a quoted string`);
  const parsed = entry[1].replace(/\\"/g, '"');
  if (!parsed || parsed.includes('\0')) throw new Error(`${path}:${line}: invalid value`);
  return parsed;
}

/** Read the deliberately small Box configuration subset used by sandbox.toml. */
export async function loadSandboxConfig(path = resolve('sandbox.toml'), hostRoot = process.env.SANDBOX_MOUNT_ROOT): Promise<SandboxConfig> {
  let text: string;
  try { text = await readFile(path, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { mounts: [], runtime: {} }; throw error; }
  let section: 'sandbox' | boolean | undefined;
  const seen = new Set<string>();
  const mounts: SandboxMount[] = [];
  const runtime: SandboxRuntimeConfig = {};
  for (const [index, raw] of text.split('\n').entries()) {
    const line = raw.trimStart().startsWith('#') ? '' : raw.replace(/\s+#.*$/, '').trim();
    if (!line) continue;
    const header = /^\[([a-z_]+)\]$/.exec(line);
    if (header) {
      section = header[1] === 'sandbox' ? 'sandbox' : mountSections[header[1]];
      if (section === undefined) throw new Error(`${path}:${index + 1}: unsupported section`);
      continue;
    }
    const entry = /^(?:"([^"\\]*(?:\\.[^"\\]*)*)"|([A-Za-z0-9_.-]+))\s*=\s*"([^"\\]*(?:\\.[^"\\]*)*)"\s*$/.exec(line);
    if (section === undefined || !entry) throw new Error(`${path}:${index + 1}: expected a quoted mapping`);
    if (section === 'sandbox') {
      const key = entry[2];
      if (!key || !runtimeKeys.has(key)) throw new Error(`${path}:${index + 1}: unsupported sandbox setting`);
      const value = textValue(`"${entry[3]}"`, path, index + 1);
      if (key === 'uid' || key === 'gid') {
        const numeric = Number(value);
        if (!Number.isInteger(numeric) || numeric < 0) throw new Error(`${path}:${index + 1}: ${key} must be a non-negative integer`);
        if (key === 'uid') runtime.uid = numeric; else runtime.gid = numeric;
      } else if (key === 'working_directory') runtime.workingDirectory = value;
      else if (key === 'image') runtime.image = value;
      else if (key === 'user') runtime.user = value;
      else runtime.network = value;
      continue;
    }
    const destination = (entry[1] ?? entry[2]!).replace(/\\"/g, '"');
    const source = entry[3].replace(/\\"/g, '"');
    const expanded = destination === '~' ? '/home/user' : destination.startsWith('~/') ? `/home/user/${destination.slice(2)}` : destination;
    if (!expanded.startsWith('/home/user/') || expanded.includes('\0') || source.includes('\0')) throw new Error(`${path}:${index + 1}: destination must be inside /home/user`);
    if (seen.has(expanded)) throw new Error(`${path}:${index + 1}: duplicate destination`);
    seen.add(expanded); mounts.push({ source: resolve(hostRoot || dirname(path), source), destination: expanded, readonly: section });
  }
  return { mounts, runtime };
}

/** Backward-compatible mount-only access for callers that do not need runtime settings. */
export async function loadSandboxMounts(path = resolve('sandbox.toml'), hostRoot = process.env.SANDBOX_MOUNT_ROOT): Promise<SandboxMount[]> {
  return (await loadSandboxConfig(path, hostRoot)).mounts;
}
