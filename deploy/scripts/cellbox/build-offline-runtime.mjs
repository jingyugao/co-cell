import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateArtifacts } from './runtime-artifacts.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
async function run(args, capture = false) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { cwd: root, stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit' });
    let text = ''; if (capture) child.stdout.on('data', chunk => { text += chunk; });
    child.on('error', reject); child.on('exit', code => code === 0 ? resolve(text) : reject(new Error(`docker exited ${code}`)));
  });
}
try {
  const manifest = await validateArtifacts(resolve(root, 'deploy/box-wrap/artifacts'));
  const base = process.env.COCELL_USER_BASE_IMAGE || manifest.baseImage;
  const info = JSON.parse(await run(['image', 'inspect', base], true))[0];
  await validateArtifacts(resolve(root, 'deploy/box-wrap/artifacts'), { baseImageId: info.Id });
  const tag = process.env.COCELL_RUNTIME_IMAGE;
  if (!tag) throw new Error('Set COCELL_RUNTIME_IMAGE to the local output image tag');
  // Pin an existing local tag to the inspected base. Neither this step nor build pulls images.
  const localBase = `cocell-offline-base:${info.Id.slice(7)}`;
  await run(['tag', info.Id, localBase]);
  await run(['build', '--pull=false', '--network=none', '--platform=linux/amd64', '--file=deploy/box-wrap/Dockerfile',
    '--build-arg', `COCELL_USER_BASE_IMAGE=${localBase}`, '--build-arg', `COCELL_PROXY_TOOLS=${process.env.COCELL_PROXY_TOOLS || ''}`, '--tag', tag, '.']);
} catch (error) { console.error(error.message); process.exitCode = 1; }
