#!/usr/local/bin/node
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { encodeGitlabHost } from '../../util/gitlab-tool-host.mjs';

const tool = process.argv[2];
let allowed = [];
try { allowed = JSON.parse(readFileSync('/opt/product/cocell/proxy-tool-ids.json', 'utf8')); }
catch { /* No local proxy tools were configured for this image. */ }
if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(tool ?? '') || !Array.isArray(allowed) || !allowed.includes(tool)) {
  console.error('Cellbox tool is not configured for proxy access');
  process.exit(2);
}
let args;
try { args = encodeGitlabHost(tool, process.argv.slice(3), process.env.GITLAB_HOST); }
catch (error) { console.error(error.message); process.exit(2); }
if (args.length > 32 || args.some(arg => Buffer.byteLength(arg) > 8192) ||
    args.reduce((bytes, arg) => bytes + Buffer.byteLength(arg), 0) > 8192) {
  console.error('Tool arguments exceed the Cellbox limit');
  process.exit(2);
}
const result = spawnSync('/opt/cellbox/bin/cellbox-container-agent', ['tool', tool, ...args], { stdio: 'inherit' });
if (result.error) console.error(`Cellbox tool unavailable: ${result.error.message}`);
process.exit(result.status ?? 1);
