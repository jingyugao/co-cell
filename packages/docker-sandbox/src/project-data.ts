import { chmod, chown, lstat, mkdir, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';

export type DockerProjectData = {
  projectId: string;
  generation: string;
  root: string;
  workspace: string;
  codex: string;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_GENERATION = /^[a-zA-Z0-9_-]{1,80}$/;

function isWithin(root: string, path: string): boolean {
  const pathFromRoot = relative(root, path);
  return pathFromRoot === '' || (pathFromRoot !== '..' && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot));
}

async function ensurePlainDirectory(path: string, mode: number): Promise<void> {
  try { await mkdir(path, { mode }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Sandbox project data path is not a real directory: ${path}`);
}

/** Create an isolated, user-owned storage generation beneath an approved root. */
export async function createDockerProjectData(
  approvedRoot: string,
  projectId: string,
  uid: number,
  gid: number,
  generation: string = randomUUID(),
): Promise<DockerProjectData> {
  if (!UUID.test(projectId)) throw new Error('Docker project storage requires a UUID project ID');
  if (!SAFE_GENERATION.test(generation) || generation === '.' || generation === '..') throw new Error('Invalid Docker project storage generation');
  if (!Number.isSafeInteger(uid) || uid < 0 || !Number.isSafeInteger(gid) || gid < 0) throw new Error('Sandbox UID and GID must be non-negative integers');

  const requestedRoot = resolve(approvedRoot);
  await mkdir(requestedRoot, { recursive: true, mode: 0o711 });
  const root = await realpath(requestedRoot);
  const projectRoot = resolve(root, projectId);
  const generationRoot = resolve(projectRoot, generation);
  if (!isWithin(root, projectRoot) || !isWithin(root, generationRoot)) throw new Error('Docker project storage path escaped its approved root');

  await ensurePlainDirectory(projectRoot, 0o711);
  if (!isWithin(root, await realpath(projectRoot))) throw new Error('Docker project storage path escaped its approved root');
  // Every container receives a fresh generation. Reusing an existing path
  // could make a replacement share mutable data with its predecessor.
  await mkdir(generationRoot, { mode: 0o700 });
  const generationInfo = await lstat(generationRoot);
  if (!generationInfo.isDirectory() || generationInfo.isSymbolicLink()) throw new Error(`Sandbox generation is not a real directory: ${generationRoot}`);
  await chmod(generationRoot, 0o700);
  if (!isWithin(root, await realpath(generationRoot))) throw new Error('Docker project storage path escaped its approved root');

  const workspace = resolve(generationRoot, 'workspace');
  const codex = resolve(generationRoot, 'codex');
  for (const path of [workspace, codex]) {
    if (!isWithin(generationRoot, path)) throw new Error('Docker project data directory escaped its generation');
    await ensurePlainDirectory(path, 0o700);
    await chmod(path, 0o700);
    if (!isWithin(generationRoot, await realpath(path))) throw new Error('Docker project data directory escaped its generation');
    await chown(path, uid, gid);
  }
  await chown(generationRoot, uid, gid);
  return { projectId, generation, root: generationRoot, workspace, codex };
}

/** Resolve an existing generation without following a symlink in project-controlled path components. */
export async function resolveDockerProjectData(approvedRoot: string, projectId: string, generation: string): Promise<DockerProjectData | undefined> {
  if (!UUID.test(projectId) || !SAFE_GENERATION.test(generation) || generation === '.' || generation === '..') return undefined;
  let root: string;
  try { root = await realpath(resolve(approvedRoot)); }
  catch { return undefined; }
  const projectRoot = resolve(root, projectId);
  const generationRoot = resolve(projectRoot, generation);
  if (!isWithin(root, generationRoot)) return undefined;
  try {
    for (const path of [projectRoot, generationRoot, resolve(generationRoot, 'workspace'), resolve(generationRoot, 'codex')]) {
      const info = await lstat(path);
      if (!info.isDirectory() || info.isSymbolicLink() || !isWithin(root, await realpath(path))) return undefined;
    }
  } catch { return undefined; }
  return { projectId, generation, root: generationRoot, workspace: resolve(generationRoot, 'workspace'), codex: resolve(generationRoot, 'codex') };
}
