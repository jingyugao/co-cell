import { spawn } from 'node:child_process';
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fileHash, runtimePackages } from './runtime-artifacts.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
let context;
try {
  const image = process.env.COCELL_ARTIFACTS_IMAGE;
  if (!image || !image.endsWith(':dev') || /\s/.test(image)) {
    throw new Error('Set COCELL_ARTIFACTS_IMAGE to the destination image with the :dev tag');
  }
  context = await mkdtemp(join(tmpdir(), 'cocell-artifacts-'));
  const files = [];
  for (const [name, pkg] of [['codex.tgz', runtimePackages.codex], ['codex-linux-x64.tgz', runtimePackages.codexLinuxX64]]) {
    if (pkg.file !== name) throw new Error(`Unexpected package filename: ${pkg.file}`);
    const destination = join(context, name);
    await copyFile(join(root, 'deploy/box-wrap/artifacts', name), destination);
    const integrity = `sha512-${await fileHash(destination, 'sha512', 'base64')}`;
    if (integrity !== pkg.integrity) throw new Error(`Publisher checksum mismatch: ${name}`);
    files.push({ path: name, sha256: await fileHash(destination), integrity, source: pkg.url });
  }
  await writeFile(join(context, 'manifest.json'), JSON.stringify({
    version: 1, codexVersion: runtimePackages.codexVersion, platform: 'linux/amd64', files,
  }, null, 2) + '\n');
  await writeFile(join(context, 'SHA256SUMS'), files.map(file => `${file.sha256}  ${file.path}\n`).join(''));
  // Only the verified packages and their metadata enter the build context.
  await new Promise((resolve, reject) => {
    const child = spawn('docker', ['build', '--pull=false', '--network=none', '--platform=linux/amd64',
      '--file', join(root, 'deploy/box-wrap/artifacts.Dockerfile'),
      '--build-arg', `CODEX_VERSION=${runtimePackages.codexVersion}`, '--tag', image, context], { stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`docker build exited ${code}`)));
  });
  console.log(`Built ${image}: Codex ${runtimePackages.codexVersion} linux/amd64 archives in /artifacts/`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  if (context) await rm(context, { recursive: true, force: true });
}
