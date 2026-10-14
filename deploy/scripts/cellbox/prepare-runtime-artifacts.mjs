import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { fileHash, runtimePackages as packages, validateArtifacts } from './runtime-artifacts.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const artifacts = resolve(root, 'deploy/box-wrap/artifacts');
const base = process.env.COCELL_USER_BASE_IMAGE || 'node:22.18.0-bookworm-slim';
async function run(command, args, capture = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit' });
    let text = ''; if (capture) child.stdout.on('data', chunk => { text += chunk; });
    child.on('error', reject); child.on('exit', code => code === 0 ? resolve(text) : reject(new Error(`${command} exited ${code}`)));
  });
}
async function download(url, destination) {
  console.log(`Downloading ${new URL(url).pathname.split('/').at(-1)}`);
  const response = await fetch(url, { signal: AbortSignal.timeout(30 * 60 * 1000) });
  if (!response.ok || !response.body) throw new Error(`Download failed: HTTP ${response.status}`);
  try { await pipeline(Readable.fromWeb(response.body), createWriteStream(destination + '.partial', { mode: 0o644 })); await rename(destination + '.partial', destination); }
  finally { await rm(destination + '.partial', { force: true }); }
}
try {
  let info;
  try { info = JSON.parse(await run('docker', ['image', 'inspect', base], true))[0]; }
  catch { await run('docker', ['pull', '--platform=linux/amd64', base]); info = JSON.parse(await run('docker', ['image', 'inspect', base], true))[0]; }
  if (info.Architecture !== 'amd64' || info.Os !== 'linux') throw new Error('Runtime package bundle supports linux/amd64');
  await mkdir(artifacts, { recursive: true });
  try {
    const manifest = await validateArtifacts(artifacts, { baseImageId: info.Id });
    console.log(`Using verified cached artifacts for ${manifest.baseImageId}`); process.exit(0);
  } catch { /* Preparation repairs missing, outdated, or corrupted public artifacts. */ }
  for (const item of [packages.codex, packages.codexLinuxX64]) {
    const [algorithm, expected] = item.integrity.split('-'); const path = resolve(artifacts, item.file);
    let matches = false; try { matches = await fileHash(path, algorithm, 'base64') === expected; } catch {}
    if (!matches) await download(item.url, path);
    if (await fileHash(path, algorithm, 'base64') !== expected) throw new Error(`Publisher checksum mismatch: ${item.file}`);
  }
  const restic = resolve(artifacts, packages.restic.file);
  let resticMatches = false; try { resticMatches = await fileHash(restic) === packages.restic.sha256; } catch {}
  if (!resticMatches) {
    await download(packages.restic.url, restic + '.bz2');
    const child = spawn('bzip2', ['-dc', restic + '.bz2'], { stdio: ['ignore', 'pipe', 'inherit'] });
    const closed = new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error('restic decompression failed'))); });
    await Promise.all([closed, pipeline(child.stdout, createWriteStream(restic + '.partial'))]);
    if (await fileHash(restic + '.partial') !== packages.restic.sha256) throw new Error('Publisher checksum mismatch: restic');
    await rename(restic + '.partial', restic); await rm(restic + '.bz2');
  }
  // Resolve OS dependencies against the exact locally cached base, ahead of build.
  await rm(resolve(artifacts, 'debs'), { recursive: true, force: true }); await mkdir(resolve(artifacts, 'debs'));
  await run('docker', ['run', '--rm', '--platform=linux/amd64', '--user=0', '--entrypoint=/bin/sh',
    '--mount', `type=bind,source=${resolve(artifacts, 'debs')},target=/var/cache/apt/archives`, info.Id,
    '-ec', 'apt-get update && apt-get install --download-only -y --no-install-recommends "$@" && chmod -R a+rX /var/cache/apt/archives', 'sh', ...packages.systemPackages]);
  const files = [];
  for (const path of [packages.codex.file, packages.codexLinuxX64.file, packages.restic.file,
    ...(await readdir(resolve(artifacts, 'debs'))).filter(name => name.endsWith('.deb')).map(name => 'debs/' + name)])
    files.push({ path, sha256: await fileHash(resolve(artifacts, path)) });
  await writeFile(resolve(artifacts, 'manifest.json'), JSON.stringify({ baseImage: base, baseImageId: info.Id, packages, files }, null, 2) + '\n');
  await validateArtifacts(artifacts, { baseImageId: info.Id });
  console.log(`Prepared ${files.length} verified offline artifacts for ${base}`);
} catch (error) { console.error(error.message); process.exitCode = 1; }
