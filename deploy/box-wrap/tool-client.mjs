#!/usr/local/bin/node
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { encodeWorkingDirectory } from '../../util/tool-working-directory.mjs';

const invocationArgs = process.argv.slice(2);
const dispatcher = invocationArgs.shift();
let dynamicName;
if (dispatcher === '--dynamic') dynamicName = invocationArgs.shift();
else {
  // Installed CLI launchers identify their entry by its Cellbox command ID.
  // Resolve it against the current dynamic catalog instead of a built-in list.
  const matches = readCatalog().filter(item => typeof item?.name === 'string' &&
    `cocell_${item.name.replaceAll('-', '_')}` === dispatcher);
  if (matches.length === 1) dynamicName = matches[0].name;
  else { console.error('Tool launcher is not registered in the dynamic catalog'); process.exit(2); }
}
function readCatalog() {
  try {
    const catalog = JSON.parse(readFileSync('/var/lib/cellbox/shared/tools/current/catalog.json', 'utf8'));
    const tools = Array.isArray(catalog) ? catalog : catalog.tools;
    return Array.isArray(tools) ? tools : [];
  } catch { return []; /* A catalog is created when dynamic tools are first published. */ }
}
if (!dynamicName || ['--help', '-h', 'help', 'list'].includes(dynamicName)) {
  const tools = readCatalog();
  if (dynamicName === 'list') {
    for (const item of tools) if (typeof item?.name === 'string') console.log(`${item.name}${item.description ? `\t${item.description}` : ''}`);
  } else if (dynamicName === 'help' && invocationArgs[0]) {
    const item = tools.find(value => value?.name === invocationArgs[0]);
    if (!item) {
      console.error(`Unknown CoCell tool: ${invocationArgs[0]}`);
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
const tool = 'cocell_tool';
let allowed = [];
try { allowed = JSON.parse(readFileSync('/opt/product/cocell/proxy-tool-ids.json', 'utf8')); }
catch { /* No local proxy tools were configured for this image. */ }
if (!Array.isArray(allowed) || !allowed.includes(tool) ||
    !/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(dynamicName ?? '')) {
  console.error('Cellbox tool is not configured for proxy access');
  process.exit(2);
}
let args;
try { args = [dynamicName, ...encodeWorkingDirectory(invocationArgs, process.cwd())]; }
catch (error) { console.error(error.message); process.exit(2); }
if (args.length > 32 || args.some(arg => Buffer.byteLength(arg) > 8192) ||
    args.reduce((bytes, arg) => bytes + Buffer.byteLength(arg), 0) > 8192) {
  console.error('Tool arguments exceed the Cellbox limit');
  process.exit(2);
}
const result = spawnSync('/opt/cellbox/bin/cellbox-container-agent', ['tool', tool, ...args], { stdio: 'inherit' });
if (result.error) console.error(`Cellbox tool unavailable: ${result.error.message}`);
process.exit(result.status ?? 1);
