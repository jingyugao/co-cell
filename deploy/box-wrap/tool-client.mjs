#!/usr/local/bin/node
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { encodeWorkingDirectory } from '../../util/tool-working-directory.mjs';
import { encodeGitlabHost } from '../../util/gitlab-tool-host.mjs';

const dynamic = process.argv[2] === '--dynamic';
const dynamicName = dynamic ? process.argv[3] : undefined;
function readCatalog() {
  try {
    const catalog = JSON.parse(readFileSync('/var/lib/cellbox/shared/tools/current/catalog.json', 'utf8'));
    const tools = Array.isArray(catalog) ? catalog : catalog.tools;
    return Array.isArray(tools) ? tools : [];
  } catch { return []; /* A catalog is created when dynamic tools are first published. */ }
}
if (dynamic && (!dynamicName || ['--help', '-h', 'help', 'list'].includes(dynamicName))) {
  const tools = readCatalog();
  if (dynamicName === 'list') {
    for (const item of tools) if (typeof item?.name === 'string') console.log(`${item.name}${item.description ? `\t${item.description}` : ''}`);
  } else if (dynamicName === 'help' && process.argv[4]) {
    const item = tools.find(value => value?.name === process.argv[4]);
    if (!item) {
      console.error(`Unknown CoCell tool: ${process.argv[4]}`);
      process.exit(2);
    }
    console.log(`${item.name}${item.description ? ` — ${item.description}` : ''}`);
    if (item.instructions) console.log(item.instructions);
  } else {
    console.log('Usage: cocell <tool> [args...]');
    console.log('       cocell help <tool>');
    if (tools.length) console.log(`Available tools: ${tools.map(item => item.name).filter(Boolean).join(', ')}`);
  }
  process.exit(0);
}
const tool = dynamic ? 'cocell_tool' : process.argv[2];
const invocationArgs = dynamic ? process.argv.slice(4) : process.argv.slice(3);
let allowed = [];
try { allowed = JSON.parse(readFileSync('/opt/product/cocell/proxy-tool-ids.json', 'utf8')); }
catch { /* No local proxy tools were configured for this image. */ }
if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(tool ?? '') || !Array.isArray(allowed) || !allowed.includes(tool) ||
    (dynamic && !/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(dynamicName ?? ''))) {
  console.error('Cellbox tool is not configured for proxy access');
  process.exit(2);
}
let args;
try {
  if (dynamic) {
    const forwarded = encodeGitlabHost(dynamicName, invocationArgs, process.env.GITLAB_HOST);
    args = [dynamicName, ...encodeWorkingDirectory(dynamicName, forwarded, process.cwd(), true)];
  } else {
    args = encodeWorkingDirectory(tool, encodeGitlabHost(tool, invocationArgs, process.env.GITLAB_HOST), process.cwd());
  }
} catch (error) { console.error(error.message); process.exit(2); }
if (args.length > 32 || args.some(arg => Buffer.byteLength(arg) > 8192) ||
    args.reduce((bytes, arg) => bytes + Buffer.byteLength(arg), 0) > 8192) {
  console.error('Tool arguments exceed the Cellbox limit');
  process.exit(2);
}
// Dynamic tools always use the one statically admitted dispatcher. If an older
// profile lacks it, fail closed instead of falling back to another tool ID.
const result = spawnSync('/opt/cellbox/bin/cellbox-container-agent', ['tool', tool, ...args], { stdio: 'inherit' });
if (result.error) console.error(`Cellbox tool unavailable: ${result.error.message}`);
process.exit(result.status ?? 1);
