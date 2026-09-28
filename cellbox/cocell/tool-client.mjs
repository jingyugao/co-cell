#!/usr/local/bin/node
import { spawnSync } from 'node:child_process';

const tool = { mysql: 'cocell_mysql', kubectl: 'cocell_kubectl' }[process.argv[2]];
if (!tool) {
  console.error('Unknown CoCell tool');
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
