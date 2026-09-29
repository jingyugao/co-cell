#!/usr/local/bin/node
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const tool = process.argv[2];
let allowed = [];
try { allowed = JSON.parse(readFileSync('/opt/product/cocell/proxy-tool-ids.json', 'utf8')); }
catch { /* No local proxy tools were configured for this image. */ }
if (!/^[a-z][a-z0-9_-]{0,63}$/.test(tool ?? '') || !Array.isArray(allowed) || !allowed.includes(tool)) {
  console.error('Cellbox tool is not configured for proxy access');
  process.exit(2);
}
const payload = JSON.stringify(process.argv.slice(3));
if (Buffer.byteLength(payload) > 8192) {
  console.error('Tool arguments exceed the Cellbox limit');
  process.exit(2);
}
const result = spawnSync('/opt/cellbox/bin/cellbox-guest', ['tool', tool, payload], { stdio: 'inherit' });
if (result.error) console.error(`Cellbox tool unavailable: ${result.error.message}`);
process.exit(result.status ?? 1);
