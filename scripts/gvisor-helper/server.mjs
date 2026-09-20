#!/usr/bin/env node
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { mkdir, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

const host = process.env.GVISOR_HELPER_HOST || '0.0.0.0';
const port = Number(process.env.GVISOR_HELPER_PORT || 8090);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('GVISOR_HELPER_PORT must be between 1 and 65535');
// The validated host installation uses the upstream release binary in
// /usr/local/bin.  Keep this overridable for distributions that package it
// elsewhere.
const runsc = process.env.GVISOR_RUNSC || '/usr/local/bin/runsc';
const platform = process.env.GVISOR_PLATFORM || 'ptrace';
const network = process.env.GVISOR_NETWORK || 'sandbox';
const rootDir = process.env.GVISOR_ROOT || '/var/lib/swarm-hive/gvisor';
const bundleRoot = resolve(process.env.GVISOR_BUNDLE_ROOT || `${rootDir}/bundles`);
const netnsRoot = resolve(process.env.GVISOR_NETNS_ROOT || '/var/run/netns');
const ipBinary = process.env.GVISOR_IP_BIN || '/usr/sbin/ip';
const iptablesBinary = process.env.GVISOR_IPTABLES_BIN || '/usr/sbin/iptables';
const cniPath = resolve(process.env.GVISOR_CNI_PATH || '/usr/lib/cni');
const cniNetwork = process.env.GVISOR_CNI_NETWORK || 'swarm-hive-gvisor';
const cniBridge = process.env.GVISOR_CNI_BRIDGE || 'swarm-gv0';
const cniSubnet = process.env.GVISOR_CNI_SUBNET || '10.89.0.0/16';
const forwards = new Map();

const command = (file, args, options = {}) => new Promise((resolvePromise, reject) => {
  const child = spawn(file, args, { env: options.env, stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8').on('data', value => { stdout += value; });
  child.stderr.setEncoding('utf8').on('data', value => { stderr += value; });
  child.once('error', reject).once('close', code => {
    const result = { stdout, stderr, exitCode: code ?? 1 };
    if (result.exitCode === 0 || options.allowFailure) resolvePromise(result);
    else reject(new Error(stderr || stdout || `${file} exited ${result.exitCode}`));
  });
  if (options.input !== undefined) child.stdin.end(options.input);
});

const networkNamespace = id => join(netnsRoot, id);
const cniEnv = (id, operation, ifname) => ({ ...process.env, CNI_COMMAND: operation, CNI_CONTAINERID: id,
  CNI_NETNS: networkNamespace(id), CNI_IFNAME: ifname, CNI_PATH: cniPath });
const bridgeConfig = () => JSON.stringify({ cniVersion: '1.0.0', name: cniNetwork, type: 'bridge', bridge: cniBridge,
  isGateway: true, ipam: { type: 'host-local', subnet: cniSubnet, routes: [{ dst: '0.0.0.0/0' }] } });
const loopbackConfig = () => JSON.stringify({ cniVersion: '1.0.0', name: `${cniNetwork}-loopback`, type: 'loopback' });
const callCni = (plugin, id, operation, ifname, config, allowFailure = false) => command(join(cniPath, plugin), [],
  { env: cniEnv(id, operation, ifname), input: config, allowFailure });
const removeNetwork = async id => {
  await callCni('loopback', id, 'DEL', 'lo', loopbackConfig(), true);
  await callCni('bridge', id, 'DEL', 'eth0', bridgeConfig(), true);
  await command(ipBinary, ['netns', 'delete', id], { allowFailure: true });
};
const ensureNat = async () => {
  const rule = ['POSTROUTING', '-s', cniSubnet, '!', '-d', cniSubnet, '-m', 'comment', '--comment', `swarm-hive gVisor ${cniNetwork}`, '-j', 'MASQUERADE'];
  const existing = await command(iptablesBinary, ['-t', 'nat', '-C', ...rule], { allowFailure: true });
  if (existing.exitCode !== 0) await command(iptablesBinary, ['-t', 'nat', '-A', ...rule]);
};
const ensureIsolation = async () => {
  const rule = ['-s', cniSubnet, '-d', cniSubnet, '-m', 'comment', '--comment', `swarm-hive gVisor isolation ${cniNetwork}`, '-j', 'DROP'];
  const existing = await command(iptablesBinary, ['-C', 'FORWARD', ...rule], { allowFailure: true });
  if (existing.exitCode !== 0) await command(iptablesBinary, ['-I', 'FORWARD', '1', ...rule]);
};
const ensureEgress = async () => {
  // Docker commonly installs a default DROP policy in FORWARD.  Permit traffic
  // leaving the dedicated gVisor subnet, plus only its established replies;
  // ensureIsolation remains rule 1 and continues to block peer sandboxes.
  const outbound = ['-s', cniSubnet, '!', '-d', cniSubnet, '-m', 'comment', '--comment', `swarm-hive gVisor egress ${cniNetwork}`, '-j', 'ACCEPT'];
  const inbound = ['-d', cniSubnet, '!', '-s', cniSubnet, '-m', 'conntrack', '--ctstate', 'ESTABLISHED,RELATED', '-m', 'comment', '--comment', `swarm-hive gVisor return ${cniNetwork}`, '-j', 'ACCEPT'];
  if ((await command(iptablesBinary, ['-C', 'FORWARD', ...outbound], { allowFailure: true })).exitCode !== 0) {
    await command(iptablesBinary, ['-I', 'FORWARD', '2', ...outbound]);
  }
  if ((await command(iptablesBinary, ['-C', 'FORWARD', ...inbound], { allowFailure: true })).exitCode !== 0) {
    await command(iptablesBinary, ['-I', 'FORWARD', '2', ...inbound]);
  }
};
const createNetwork = async id => {
  await mkdir(netnsRoot, { recursive: true, mode: 0o755 });
  await ensureNat();
  await ensureIsolation();
  await ensureEgress();
  await command(ipBinary, ['netns', 'add', id]);
  try {
    await callCni('bridge', id, 'ADD', 'eth0', bridgeConfig());
    await callCni('loopback', id, 'ADD', 'lo', loopbackConfig());
  } catch (error) {
    await removeNetwork(id);
    throw error;
  }
};

const run = (args, cwd, timeoutMs) => new Promise((resolve, reject) => {
  const child = spawn(runsc, [`-platform=${platform}`, `-network=${network}`, `-root=${rootDir}`, ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  const timer = timeoutMs && timeoutMs > 0 ? setTimeout(() => child.kill('SIGKILL'), timeoutMs) : undefined;
  child.stdout.setEncoding('utf8').on('data', value => { stdout += value; });
  child.stderr.setEncoding('utf8').on('data', value => { stderr += value; });
  // runsc create/start may leave its stdout/stderr descriptors inherited by
  // the long-lived gofer/sandbox process. `close` would then wait until the
  // sandbox exits, whereas `exit` correctly represents the CLI operation.
  child.once('error', error => { if (timer) clearTimeout(timer); reject(error); }).once('exit', code => {
    if (timer) clearTimeout(timer);
    resolve({ stdout, stderr, exitCode: code ?? 1 });
  });
});

const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_.-]{1,128}$/.test(value);
const safePath = async value => {
  if (typeof value !== 'string' || !value.startsWith('/')) throw new Error('invalid bundlePath');
  const actual = await realpath(value);
  if (actual !== bundleRoot && !actual.startsWith(`${bundleRoot}/`)) throw new Error('bundlePath is outside GVISOR_BUNDLE_ROOT');
  return actual;
};
const checked = async (args, cwd, timeoutMs) => {
  const result = await run(args, cwd, timeoutMs);
  if (result.exitCode !== 0) throw new Error(result.stderr || `runsc exited ${result.exitCode}`);
  return result.stdout;
};
const delay = milliseconds => new Promise(resolvePromise => setTimeout(resolvePromise, milliseconds));
const restore = async (id, checkpointId, bundlePath) => {
  const child = spawn(runsc, [`-platform=${platform}`, `-network=${network}`, `-root=${rootDir}`, 'restore',
    `-image-path=${rootDir}/checkpoints/${checkpointId}`, id], { cwd: bundlePath, stdio: ['ignore', 'pipe', 'pipe'] });
  let launchError;
  let stderr = '';
  child.stdout.resume();
  child.stderr.setEncoding('utf8').on('data', value => { stderr = `${stderr}${value}`.slice(-16 * 1024); });
  child.once('error', error => { launchError = error; });
  for (let attempt = 0; attempt < 100; attempt++) {
    await delay(100);
    if (launchError) throw launchError;
    const state = await run(['state', id]);
    if (state.exitCode === 0) {
      const parsed = JSON.parse(state.stdout);
      if (parsed.status === 'running') return;
    }
    if (child.exitCode !== null) throw new Error(stderr || `runsc restore exited ${child.exitCode}`);
  }
  throw new Error('runsc restore did not reach running state');
};
const forwardKey = (id, remotePort) => `${id}:${remotePort}`;
const availablePort = () => new Promise((resolve, reject) => {
  const server = createNetServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    server.close(error => error ? reject(error) : resolve(address.port));
  });
});
const stopForwards = id => {
  for (const [key, value] of forwards) if (value.sandboxId === id) {
    value.child.kill('SIGTERM');
    forwards.delete(key);
  }
};
const startForward = async (id, remotePort, requestedPort) => {
  if (!Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65535) throw new Error('invalid remotePort');
  const key = forwardKey(id, remotePort);
  const existing = forwards.get(key);
  if (existing) return { hostPort: existing.hostPort, remotePort };
  const hostPort = requestedPort ?? await availablePort();
  if (!Number.isInteger(hostPort) || hostPort < 1 || hostPort > 65535) throw new Error('invalid hostPort');
  const child = spawn(runsc, [`-platform=${platform}`, `-network=${network}`, `-root=${rootDir}`, 'port-forward', id, `${hostPort}:${remotePort}`], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', value => { stderr += value; });
  const record = { sandboxId: id, hostPort, child };
  forwards.set(key, record);
  child.once('exit', () => forwards.delete(key));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, 150);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(stderr || `runsc port-forward exited ${code}`)); });
  });
  return { hostPort, remotePort };
};
const request = async input => {
  if (!input || typeof input !== 'object' || typeof input.action !== 'string') throw new Error('invalid request');
  const id = input.sandboxId;
  if (!safeId(id)) throw new Error('invalid sandboxId');
  if (input.action === 'checkpoint') {
    const checkpointId = `${id}-${Date.now()}`;
    await checked(['checkpoint', `-image-path=${rootDir}/checkpoints/${checkpointId}`, '-leave-running=false', id]);
    return { id: checkpointId, createdAt: new Date().toISOString() };
  }
  if (input.action === 'create') {
    const bundlePath = await safePath(input.bundlePath);
    await createNetwork(id);
    try { await checked(['create', '--bundle', bundlePath, id]); }
    catch (error) { await removeNetwork(id); throw error; }
    return { created: true };
  }
  if (input.action === 'start') { await checked(['start', id]); return { started: true }; }
  if (input.action === 'delete') {
    stopForwards(id);
    await run(['kill', id, 'KILL']);
    await removeNetwork(id);
    await checked(['delete', '-force', id]);
    return { deleted: true };
  }
  if (input.action === 'kill') { stopForwards(id); await checked(['kill', id, 'KILL']); return { killed: true }; }
  if (input.action === 'forward') return startForward(id, input.remotePort, input.hostPort);
  if (input.action === 'forwards') return [...forwards.values()].filter(value => value.sandboxId === id).map(value => ({ hostPort: value.hostPort }));
  if (input.action === 'restore') {
    if (!safeId(input.checkpointId)) throw new Error('invalid checkpointId');
    const bundlePath = await safePath(input.bundlePath);
    // A non-live checkpoint leaves a stopped runtime record behind. runsc
    // requires that record to be removed before restoring the same ID. The
    // network setup also has to be recreated because runsc imports its IP and
    // routes into netstack, leaving the host namespace without that config.
    await removeNetwork(id);
    await run(['delete', '-force', id]);
    await createNetwork(id);
    try { await restore(id, input.checkpointId, bundlePath); }
    catch (error) { await removeNetwork(id); throw error; }
    return { restored: true };
  }
  if (input.action === 'state') return JSON.parse(await checked(['state', id]));
  if (input.action === 'exec') {
    if (typeof input.command !== 'string' || input.command.length > 1024 * 1024) throw new Error('invalid command');
    if (input.cwd !== undefined && (typeof input.cwd !== 'string' || !input.cwd.startsWith('/'))) throw new Error('invalid cwd');
    if (input.user !== undefined && !['root', 'user', '0', '1000'].includes(input.user)) throw new Error('invalid user');
    if (input.env !== undefined && (!input.env || typeof input.env !== 'object' || Object.entries(input.env).some(([key, value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== 'string'))) throw new Error('invalid env');
    const timeoutMs = typeof input.timeoutMs === 'number' && Number.isFinite(input.timeoutMs) ? Math.min(Math.max(input.timeoutMs, 1), 3 * 60 * 60 * 1000) : undefined;
    const envArgs = Object.entries(input.env ?? {}).flatMap(([key, value]) => ['--env', `${key}=${value}`]);
    const user = input.user === 'user' || input.user === '1000' ? '1000:1000' : input.user === 'root' || input.user === '0' ? '0:0' : undefined;
    const result = await run(['exec', ...envArgs, ...(input.cwd ? ['--cwd', input.cwd] : []), ...(user ? ['--user', user] : []), id, 'sh', '-lc', input.command], undefined, timeoutMs);
    return result;
  }
  throw new Error(`unsupported action: ${input.action}`);
};

await mkdir(`${rootDir}/checkpoints`, { recursive: true, mode: 0o700 });
await mkdir(bundleRoot, { recursive: true, mode: 0o700 });
const json = (response, status, value) => {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(value));
};
const server = createServer((incoming, response) => {
  if (incoming.method === 'GET' && incoming.url === '/health') return json(response, 200, { ok: true });
  if (incoming.method !== 'POST' || incoming.url !== '/v1/actions') return json(response, 404, { error: 'not found' });
  let body = '';
  incoming.setEncoding('utf8');
  incoming.on('data', chunk => {
    body += chunk;
    if (body.length > 2 * 1024 * 1024) incoming.destroy(new Error('request body too large'));
  });
  incoming.once('error', error => json(response, 400, { ok: false, error: error.message }));
  incoming.once('end', () => void (async () => {
    try { json(response, 200, { ok: true, result: await request(JSON.parse(body)) }); }
    catch (error) { json(response, 400, { ok: false, error: error instanceof Error ? error.message : String(error) }); }
  })());
});
server.listen(port, host, () => console.log(`gVisor helper listening on http://${host}:${port}`));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
