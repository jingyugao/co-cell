import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { open, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { decodeWorkingDirectory } from '../../util/tool-working-directory.mjs';
import { decodeGitlabHost } from '../../util/gitlab-tool-host.mjs';
import { toolRuntimeBoxId } from '../../util/tool-runtime-identity.mjs';
import { validateDynamicToolExecution } from '../../util/dynamic-tool-config.mjs';

export class ToolAuthorizationError extends Error {}
async function authorizationError(response) {
  let detail = '';
  if (response.status >= 400 && response.status < 500 && response.headers.get('content-type')?.includes('application/json')) {
    const reader = response.body?.getReader();
    try {
      if (reader) {
        const chunks = []; let size = 0;
        while (true) {
          const { done, value } = await reader.read(); if (done) break;
          size += value.length; if (size > 4096) break; chunks.push(value);
        }
        if (size <= 4096) {
          const value = JSON.parse(Buffer.concat(chunks).toString());
          if (typeof value.error === 'string') detail = value.error.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 1024);
        }
      }
    } catch { /* Keep the status if the broker response is malformed. */ }
    finally { await reader?.cancel().catch(() => {}); }
  }
  return new ToolAuthorizationError(`Tool authorization failed (HTTP ${response.status})${detail ? ': ' + detail : ''}`);
}

function safePath(path) {
  return typeof path === 'string' && path.length > 0 && path.length <= 256 && !path.startsWith('/') && normalize(path) === path &&
    !/[\\\u0000-\u001f\u007f]/.test(path) && path.split('/').every(part => part && part !== '.' && part !== '..');
}

/** Root debug CLIs create 0600 files. Keep their native HOME editable by its
 * existing owner without changing bytes, modes, or following symlinks. */
export async function restoreCredentialOwnership(home, roots = []) {
  if (!Array.isArray(roots) || roots.length > 16 || roots.some(path => !safePath(path)))
    throw new Error('Invalid credential roots');
  if (process.getuid?.() !== 0 || !roots.length) return;
  const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
  const root = await open(home, directoryFlags);
  try {
    const owner = await root.stat();
    if (owner.uid === 0) return;
    let visited = 0;
    const child = async (parent, name, directory = false) => {
      try { return await open(`/proc/self/fd/${parent.fd}/${name}`, directory ? directoryFlags : constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
      catch (error) { if (['ENOENT', 'ELOOP', 'ENOTDIR'].includes(error.code)) return null; throw error; }
    };
    const repair = async (handle, depth = 0) => {
      if (++visited > 4096 || depth > 32) throw new Error('Credential directory is too large');
      const info = await handle.stat();
      if (!info.isFile() && !info.isDirectory()) return;
      if (info.uid !== owner.uid || info.gid !== owner.gid) await handle.chown(owner.uid, owner.gid);
      if (!info.isDirectory()) return;
      for (const name of await readdir(`/proc/self/fd/${handle.fd}`)) {
        const entry = await child(handle, name);
        if (entry) { try { await repair(entry, depth + 1); } finally { await entry.close(); } }
      }
    };
    const descend = async (parent, parts) => {
      const entry = await child(parent, parts[0], parts.length > 1);
      if (!entry) return;
      try { if (parts.length > 1) await descend(entry, parts.slice(1)); else await repair(entry); }
      finally { await entry.close(); }
    };
    for (const path of roots) await descend(root, path.split('/'));
  } finally { await root.close(); }
}
async function execute(executable, args, env, cwd, timeoutMs = 20000) {
  return new Promise(resolve => {
    const child = spawn(executable, args, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    let stdout = '', stderr = '', size = 0;
    const collect = target => chunk => { size += chunk.length; if (size <= 1024 * 1024) { if (target === 'out') stdout += chunk; else stderr += chunk; } };
    child.stdout.on('data', collect('out')); child.stderr.on('data', collect('err'));
    const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Already exited. */ } }, timeoutMs);
    child.once('error', () => { clearTimeout(timer); resolve({ exitCode: 1, stdout: '', stderr: 'Tool executable is unavailable\n' }); });
    child.once('close', (code, signal) => { clearTimeout(timer); resolve({ exitCode: signal ? 124 : code ?? 1, stdout, stderr }); });
  });
}

function executionDetails(execution, home, credential) {
  if (execution === undefined) return null;
  validateDynamicToolExecution(execution, { credentialAvailable: Boolean(credential) });
  const env = {};
  for (const [key, template] of Object.entries(execution.env)) {
    env[key] = template.replaceAll('${HOME}', home).replaceAll('${CREDENTIAL}', credential ?? '');
  }
  return { executable: execution.executable, args: execution.args, env, timeoutMs: execution.timeoutMs };
}

/** Authorize access, then execute against native files in the mounted HOME. */
export async function runProtectedTool(tool, inputArgs, options = {}) {
  if (!/^[A-Za-z][A-Za-z0-9_.\-]{0,63}$/.test(tool)) throw new Error('Invalid protected tool name');
  const invocation = await decodeWorkingDirectory(tool, inputArgs, options.agentHome, options.dynamic === true);
  inputArgs = invocation.args;
  options = { ...options, ...(invocation.cwd ? { cwd: invocation.cwd, gitEnv: invocation.gitEnv } : {}) };
  const config = options.config ?? JSON.parse(await readFile(process.env.COCELL_TOOL_RUNTIME, 'utf8'));
  if (config?.mode !== 'home') throw new Error(`Unsupported tool runtime mode '${String(config?.mode)}'; rebuild the Sandbox with mounted HOME credentials`);
  const decoded = decodeGitlabHost(tool, inputArgs);
  const boxId = toolRuntimeBoxId(config.boxId);
  if (!boxId) throw new Error('Invalid Box identity');
  const base = new URL(config.url);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash || base.pathname !== '/')
    throw new Error('Invalid broker origin');
  const response = await (options.fetch ?? fetch)(new URL('/api/tool-runtime/authorize', base), {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(4000),
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ boxId, tool, args: decoded.args }),
  });
  if (!response.ok) throw await authorizationError(response);
  const setup = await response.json();
  if (options.dynamic && setup.execution === undefined) throw new Error('Dynamic tool is no longer configured');
  if (setup.tool !== tool || setup.home !== '/home/debug' ||
      (setup.path !== undefined && !safePath(setup.path)) ||
      (['mysql', 'kubectl', 'ssh'].includes(tool) && !safePath(setup.path)) ||
      !Array.isArray(setup.args) || setup.args.length > 32 ||
      setup.args.some(arg => typeof arg !== 'string' || arg.includes('\0')))
    throw new Error('Invalid tool authorization');
  const home = options.homeRoot ?? setup.home;
  // Native tools may spawn each other. This PATH bypasses agent-side wrappers.
  const env = { PATH: `${options.binaryRoot ?? '/opt/cellbox/debug-bin'}:/usr/local/bin:/usr/bin:/bin`,
    HOME: home, LANG: 'C.UTF-8', XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local/share'), ...decoded.env, ...options.gitEnv };
  const credential = setup.path === undefined ? undefined : join(home, setup.path);
  const dynamicExecution = executionDetails(setup.execution, home, credential);
  if (setup.execution !== undefined && !dynamicExecution) throw new Error('Invalid dynamic tool execution');
  if (tool === 'kubectl') env.KUBECONFIG = credential;
  if (tool === 'glab' && credential) env.GLAB_CONFIG_DIR = dirname(credential);
  if (tool === 'git' && credential) env.GIT_CONFIG_GLOBAL = credential;
  // --no-defaults still reads the native login file. Pin its path and omit all
  // other option files so the account comes from the shared native config.
  if (tool === 'mysql' && !dynamicExecution) env.MYSQL_TEST_LOGIN_FILE = credential;
  const args = tool === 'mysql' && !dynamicExecution ? ['--no-defaults', ...setup.args] : setup.args;
  const executionEnv = dynamicExecution ? { ...env, ...dynamicExecution.env } : env;
  const executable = dynamicExecution?.executable ?? join(options.binaryRoot ?? '/opt/cellbox/debug-bin', tool);
  const executionArgs = dynamicExecution ? [...dynamicExecution.args, ...args] : args;
  if (tool === 'ssh') {
    // OpenSSH resolves its default HOME via getpwuid(), ignoring env.HOME.
    // Pin config and host trust to the mounted HOME even in root debug execs.
    executionArgs.unshift('-F', credential, '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'IdentityFile=none',
      '-o', 'IdentityAgent=none', '-o', `UserKnownHostsFile=${join(home, '.ssh/known_hosts')}`,
      '-o', 'StrictHostKeyChecking=yes');
  }
  const result = await execute(executable, executionArgs, executionEnv, options.cwd ?? process.cwd(), dynamicExecution?.timeoutMs ?? 20000);
  await restoreCredentialOwnership(home, setup.credentialPaths);
  (options.stdout ?? process.stdout).write(result.stdout);
  (options.stderr ?? process.stderr).write(result.stderr);
  return result.exitCode;
}
