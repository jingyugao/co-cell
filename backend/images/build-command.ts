import { readFile } from 'node:fs/promises';
import { HttpError } from '../../util/errors.js';

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
/** No downloads: the source or user's command supplies Node.js, Codex and project tools. */
export async function prepareImageRequest(url: string, userCommand?: string) {
  const launcher = await readFile(new URL('../../deploy/box-wrap/launcher.mjs', import.meta.url), 'utf8');
  const install = `/usr/local/bin/node -e ${quote(`const fs=require('node:fs');fs.mkdirSync('/opt/product/cocell',{recursive:true});fs.writeFileSync('/opt/product/cocell/launcher.mjs',Buffer.from('${Buffer.from(launcher).toString('base64')}','base64'),{mode:0o755});fs.chmodSync('/opt/product/cocell/launcher.mjs',0o755);`)}
test -x /usr/local/bin/codex
/usr/local/bin/codex --version
/usr/local/bin/node --check /opt/product/cocell/launcher.mjs`;
  // Run the user script in its own shell so `exit` cannot bypass platform installation.
  const buildCommand = `set -eu\n${userCommand ? `/bin/sh -ec ${quote(userCommand)}\n` : ''}${install}`;
  if (Buffer.byteLength(buildCommand) > 65536) throw new HttpError(400, '构建命令加上 CoCell 启动器后超过 64 KiB，请缩短命令');
  return { url, platform: 'linux/amd64' as const, buildCommand,
    runCommand: `docker run -w /home/agent/workspace --entrypoint /usr/local/bin/node ${quote(url)} /opt/product/cocell/launcher.mjs` };
}
