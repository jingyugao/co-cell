import { randomBytes } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, relative, posix, dirname } from 'node:path';
import { AgentClient } from '@swarm-hive/agentcore/client';

const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
async function sources(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await sources(path));
    else if (entry.isFile() && entry.name.endsWith('.mjs')) result.push(path);
  }
  return result;
}

/** Connect without creating, resuming or terminating the sandbox or runtime. */
export function connectAgentRuntime(sandbox, { token, port = 8765, endpoint } = {}) {
  if (!token) throw new Error('Agent runtime bearer token is required');
  return new AgentClient({ endpoint: endpoint ?? `https://${sandbox.getHost(port)}`, token });
}

/** Provision a fresh runtime; retain the returned token/port for later reconnects. */
export async function deployAgentRuntime(sandbox, options = {}) {
  const port = options.port ?? 8765;
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid runtime port');
  const directory = options.directory ?? `/home/user/.agentcore/${randomBytes(12).toString('hex')}`;
  if (!posix.isAbsolute(directory) || directory.includes('\0')) throw new Error('Runtime directory must be absolute');
  const token = options.token ?? randomBytes(32).toString('hex');
  const sourceDirectory = options.sourceDirectory ?? dirname(fileURLToPath(import.meta.resolve('@swarm-hive/agentcore')));
  // Check all host resources before performing remote installation.
  const files = await Promise.all((await sources(sourceDirectory)).map(async path => ({
    path: `${directory}/src/${relative(sourceDirectory, path).split('\\').join('/')}`,
    data: await readFile(path, 'utf8'),
  })));
  if (!files.some(file => file.path === `${directory}/src/runtime/main.mjs`)) throw new Error('Agent runtime entry is missing');
  const directories = [...new Set([directory, `${directory}/data`, ...files.map(file => posix.dirname(file.path))])];
  await sandbox.commands.run(`umask 077; mkdir -p ${directories.map(quote).join(' ')}`, { user: 'user' });
  for (const file of files) await sandbox.files.write(file.path, file.data, { user: 'user' });
  let codexPath = options.codexPath;
  if (!codexPath) {
    const version = options.codexVersion ?? '0.153.4';
    if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version)) throw new Error('Invalid Codex version');
    await sandbox.commands.run(`npm install --prefix ${quote(directory)} --no-audit --no-fund --save-exact ${quote(`@openai/codex@${version}`)}`, { user: 'user', timeoutMs: 300_000 });
    codexPath = `${directory}/node_modules/.bin/codex`;
  }
  const launch = `umask 077; exec ${quote(options.nodePath ?? 'node')} ${quote(`${directory}/src/runtime/main.mjs`)} </dev/null >>${quote(`${directory}/runtime.log`)} 2>&1`;
  await sandbox.commands.run(`setsid sh -c ${quote(launch)}`, {
    user: 'user', background: true, timeoutMs: 0,
    envs: { ...options.env, CODEX_PATH: codexPath, AGENTCORE_PORT: String(port), AGENTCORE_HOST: '0.0.0.0',
      AGENTCORE_TOKEN: token, AGENTCORE_DATA_DIR: `${directory}/data`,
      ...(options.cwd ? { AGENTCORE_CWD: options.cwd } : {}) },
  });
  const endpoint = options.endpoint ?? `https://${sandbox.getHost(port)}`;
  // Read-only probe: never initialize another thread or retry a mutating RPC.
  const deadline = Date.now() + (options.readyTimeoutMs ?? 30_000);
  let reason = 'not ready';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${endpoint.replace(/\/$/, '')}/health`, {
        headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(3000),
      });
      await response.body?.cancel();
      if (response.ok) return { directory, port, endpoint, token, client: connectAgentRuntime(sandbox, { endpoint, token, port }) };
      reason = `HTTP ${response.status}`;
    } catch (error) { reason = error.cause?.code ? `${error.message} (${error.cause.code})` : error.message; }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`Agent runtime readiness failed (${reason}); inspect ${directory}/runtime.log. Runtime may still be running.`);
}
