import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const directory = 'tmp/integration/ci/diagnostics';
await mkdir(directory, { recursive: true });
const generated = JSON.parse(await readFile(join(process.env.RUNNER_TEMP ?? '/nonexistent', 'cocell-ci/credentials.json'), 'utf8').catch(() => '{}'));
const secrets = [process.env.CODEX_API_KEY, ...Object.values(generated)].filter(Boolean);
const redact = text => secrets.reduce((result, secret) => result.replaceAll(secret, '[redacted]'), String(text));
function capture(command, args) {
  try { return execFileSync(command, args, { encoding: 'utf8', timeout: 20000, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (error) { return `Unavailable: ${command}\n${error.stderr ?? ''}`; }
}
const kube = ['--context', 'cocell-ci', '-n', 'co-cell-ci'];
await writeFile(join(directory, 'pods.txt'), redact(capture('kubectl', [...kube, 'get', 'pods', '-o', 'wide'])));
await writeFile(join(directory, 'events.txt'), redact(capture('kubectl', [...kube, 'get', 'events', '--sort-by=.lastTimestamp'])));
const names = capture('kubectl', [...kube, 'get', 'pods', '-o', 'name']).split('\n').filter(name => /^pod\/[a-z0-9-]+$/.test(name));
for (const name of names) {
  await writeFile(join(directory, name.slice(4) + '.log'), redact(capture('kubectl', [...kube, 'logs', name, '--all-containers=true', '--tail=300'])));
}
const runtimeLog = capture('sudo', ['journalctl', '-u', 'k3s', '-n', '200', '--no-pager'])
  .split('\n').filter(line => !/token|password|secret|credential|authorization/i.test(line)).join('\n');
await writeFile(join(directory, 'k3s.log'), redact(runtimeLog));
// Do not upload kubeconfigs, Helm values, Secret manifests or Pod environment.
