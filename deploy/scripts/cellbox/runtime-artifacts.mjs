import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

export const runtimePackages = JSON.parse(await readFile(new URL('../../box-wrap/runtime-packages.json', import.meta.url), 'utf8'));
export async function fileHash(path, algorithm = 'sha256', encoding = 'hex') {
  const hash = createHash(algorithm);
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest(encoding);
}
export async function validateArtifacts(root, { baseImageId, packages = runtimePackages } = {}) {
  root = await realpath(root);
  const manifest = JSON.parse(await readFile(resolve(root, 'manifest.json'), 'utf8'));
  if (JSON.stringify(manifest.packages) !== JSON.stringify(packages)) throw new Error('Runtime package versions changed; prepare artifacts again');
  if (!/^sha256:[a-f0-9]{64}$/.test(manifest.baseImageId ?? '') || baseImageId && manifest.baseImageId !== baseImageId)
    throw new Error('Artifact base image differs; prepare artifacts for this base image');
  if (!Array.isArray(manifest.files) || !manifest.files.length) throw new Error('Artifact manifest has no files');
  const paths = new Set();
  for (const file of manifest.files) {
    if (typeof file.path !== 'string' || !/^(?:[a-zA-Z0-9._+-]+\/)*[a-zA-Z0-9._+%:~-]+$/.test(file.path)
      || file.path.split('/').some(part => part === '.' || part === '..') || paths.has(file.path) || !/^[a-f0-9]{64}$/.test(file.sha256 ?? ''))
      throw new Error('Invalid or duplicate artifact path/hash');
    paths.add(file.path);
    const path = resolve(root, file.path), canonical = await realpath(path);
    if (!canonical.startsWith(root + sep) || !(await lstat(path)).isFile()) throw new Error('Artifact must be a regular file inside the bundle');
    if (await fileHash(path) !== file.sha256) throw new Error(`Artifact checksum mismatch: ${file.path}`);
  }
  for (const file of [packages.codex.file, packages.codexLinuxX64.file, packages.restic.file]) {
    if (!paths.has(file)) throw new Error(`Required artifact missing: ${file}`);
  }
  const debs = await readdir(resolve(root, 'debs')).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  for (const name of debs) if (name.endsWith('.deb') && !paths.has('debs/' + name)) throw new Error(`Unverified system artifact: ${name}`);
  // Verify publisher checksums independently of the locally generated manifest.
  for (const artifact of [packages.codex, packages.codexLinuxX64]) {
    const [algorithm, expected] = artifact.integrity.split('-');
    if (algorithm !== 'sha512' || await fileHash(resolve(root, artifact.file), algorithm, 'base64') !== expected)
      throw new Error(`Publisher checksum mismatch: ${artifact.file}`);
  }
  if (await fileHash(resolve(root, packages.restic.file)) !== packages.restic.sha256)
    throw new Error('Publisher checksum mismatch: restic');
  return manifest;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await validateArtifacts(process.argv[2]); console.log('Offline runtime artifacts verified'); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
