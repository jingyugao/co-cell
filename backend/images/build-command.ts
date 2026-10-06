import { readFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { HttpError } from '../../util/errors.js';

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
/** No downloads: the source or user's command supplies Node.js, Codex and project tools. */
export async function prepareImageRequest(url: string, userCommand?: string) {
  const tools: string[] = JSON.parse(await readFile(new URL('../../deploy/box-wrap/proxy-tools.json', import.meta.url), 'utf8'));
  const sources = [
    ['deploy/box-wrap/tool-client.mjs', '/opt/product/cocell/deploy/box-wrap/tool-client.mjs'],
    ['deploy/box-wrap/protected-tool.mjs', '/opt/product/cocell/deploy/box-wrap/protected-tool.mjs'],
    ['util/credential-files.mjs', '/opt/product/cocell/util/credential-files.mjs'],
    ['util/gitlab-tool-host.mjs', '/opt/product/cocell/util/gitlab-tool-host.mjs'],
    ['deploy/box-wrap/tools/cocell-proxy', '/opt/cellbox/tools/cocell-proxy'],
    ['deploy/box-wrap/oss-archive-backup.mjs', '/opt/product/cocell/oss-archive-backup.mjs'],
    ['deploy/box-wrap/oss-archive-restore.mjs', '/opt/product/cocell/oss-archive-restore.mjs'],
    ['deploy/box-wrap/tools/cocell-archive-backup', '/opt/cellbox/tools/cocell-archive-backup'],
    ['deploy/box-wrap/tools/cocell-archive-restore', '/opt/cellbox/tools/cocell-archive-restore'],
  ];
  const files = await Promise.all(sources.map(async ([source, path]) => ({ path,
    content: await readFile(new URL(`../../${source}`, import.meta.url), 'utf8') })));
  const payload = gzipSync(JSON.stringify(files)).toString('base64');
  const proxies = `/usr/local/bin/node -e ${quote(`const fs=require('node:fs'),path=require('node:path'),z=require('node:zlib');for(const f of JSON.parse(z.gunzipSync(Buffer.from('${payload}','base64')))){fs.mkdirSync(path.dirname(f.path),{recursive:true});fs.writeFileSync(f.path,f.content,{mode:0o755});}for(const name of ['protected-tool','tool-client']){const link='/opt/product/cocell/'+name+'.mjs';try{fs.unlinkSync(link);}catch(e){if(e.code!=='ENOENT')throw e;}fs.symlinkSync('deploy/box-wrap/'+name+'.mjs',link);}`)}
mkdir -p /opt/cellbox/debug-bin
proxy_ids=''
for tool in ${tools.join(' ')}; do
  binary="$(command -v "$tool" || true)"
  if test -z "$binary"; then continue; fi
  if test -L "$binary"; then
    ln -sf "$(readlink -f "$binary")" "/opt/cellbox/debug-bin/$tool"
  elif ! test -x "/opt/cellbox/debug-bin/$tool"; then
    cp -L "$binary" "/opt/cellbox/debug-bin/$tool"
  fi
  tool_id="cocell_$(echo "$tool" | tr '-' '_')"
  rm -f "/usr/local/bin/$tool"
  printf '#!/bin/sh\\nexec /usr/local/bin/node /opt/product/cocell/tool-client.mjs %s "$@"\\n' "$tool_id" > "/usr/local/bin/$tool"
  chmod 0755 "/usr/local/bin/$tool"
  proxy_ids="$proxy_ids $tool_id"
done
/usr/local/bin/node -e 'require("node:fs").writeFileSync("/opt/product/cocell/proxy-tool-ids.json",JSON.stringify(process.argv.slice(1)))' $proxy_ids`;
  const launcher = await readFile(new URL('../../deploy/box-wrap/launcher.mjs', import.meta.url), 'utf8');
  const install = `/usr/local/bin/node -e ${quote(`const fs=require('node:fs');fs.mkdirSync('/opt/product/cocell',{recursive:true});fs.writeFileSync('/opt/product/cocell/launcher.mjs',Buffer.from('${Buffer.from(launcher).toString('base64')}','base64'),{mode:0o755});fs.chmodSync('/opt/product/cocell/launcher.mjs',0o755);`)}
test -x /usr/local/bin/codex
/usr/local/bin/codex --version
/usr/local/bin/node --check /opt/product/cocell/launcher.mjs`;
  // Run the user script in its own shell so `exit` cannot bypass platform installation.
  const buildCommand = `set -eu\n${userCommand ? `/bin/sh -ec ${quote(userCommand)}\n` : ''}${proxies}\n${install}`;
  if (Buffer.byteLength(buildCommand) > 65536) throw new HttpError(400, '构建命令加上 CoCell 启动器后超过 64 KiB，请缩短命令');
  return { url, platform: 'linux/amd64' as const, buildCommand,
    runCommand: `docker run -w /home/agent/workspace --entrypoint /usr/local/bin/node ${quote(url)} /opt/product/cocell/launcher.mjs` };
}
