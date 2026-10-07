import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join, normalize } from 'node:path';
import { decodeGitlabHost } from '../../util/gitlab-tool-host.mjs';
import { toolRuntimeBoxId } from '../../util/tool-runtime-identity.mjs';

function safePath(path) {
  return typeof path === 'string' && path.length > 0 && path.length <= 256 && !path.startsWith('/') && normalize(path) === path &&
    !/[\\\u0000-\u001f\u007f]/.test(path) && path.split('/').every(part => part && part !== '.' && part !== '..');
}
async function execute(executable, args, env, cwd) {
  return new Promise(resolve => {
    const child = spawn(executable, args, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    let stdout = '', stderr = '', size = 0;
    const collect = target => chunk => { size += chunk.length; if (size <= 1024 * 1024) { if (target === 'out') stdout += chunk; else stderr += chunk; } };
    child.stdout.on('data', collect('out')); child.stderr.on('data', collect('err'));
    const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Already exited. */ } }, 20000);
    child.once('error', () => { clearTimeout(timer); resolve({ exitCode: 1, stdout: '', stderr: 'Tool executable is unavailable\n' }); });
    child.once('close', (code, signal) => { clearTimeout(timer); resolve({ exitCode: signal ? 124 : code ?? 1, stdout, stderr }); });
  });
}

/** Authorize access, then execute against native files in the mounted HOME. */
export async function runProtectedTool(tool, inputArgs, options = {}) {
  if (!/^[A-Za-z][A-Za-z0-9_.\-]{0,63}$/.test(tool)) throw new Error('Invalid protected tool name');
  const config = options.config ?? JSON.parse(await readFile(process.env.COCELL_TOOL_RUNTIME, 'utf8'));
  if (config.mode !== 'home') {
    // Checkpointed images/configurations keep their original delivery contract.
    const legacy = await import('./legacy-protected-tool.mjs');
    return legacy.runProtectedTool(tool, inputArgs, { ...options, config });
  }
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
  if (!response.ok) throw new Error(`Tool authorization failed (HTTP ${response.status})`);
  const setup = await response.json();
  if (setup.tool !== tool || typeof setup.home !== 'string' || !/^\/home\/debug\/[a-f0-9-]{36}$/.test(setup.home) ||
      !safePath(setup.path) || !Array.isArray(setup.args) || setup.args.length > 32 ||
      setup.args.some(arg => typeof arg !== 'string' || arg.includes('\0')))
    throw new Error('Invalid tool authorization');
  const home = options.homeRoot ? join(options.homeRoot, setup.home.slice('/home/debug/'.length)) : setup.home;
  // Native tools may spawn each other. This PATH bypasses agent-side wrappers.
  const env = { PATH: `${options.binaryRoot ?? '/opt/cellbox/debug-bin'}:/usr/local/bin:/usr/bin:/bin`,
    HOME: home, LANG: 'C.UTF-8', XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local/share'), ...decoded.env };
  const credential = join(home, setup.path);
  if (tool === 'kubectl') env.KUBECONFIG = credential;
  if (tool === 'glab') env.GLAB_CONFIG_DIR = dirname(credential);
  if (tool === 'git') env.GIT_CONFIG_GLOBAL = credential;
  const args = tool === 'mysql' ? [`--defaults-file=${credential}`, ...setup.args] : setup.args;
  const result = await execute(join(options.binaryRoot ?? '/opt/cellbox/debug-bin', tool), args, env, options.cwd ?? process.cwd());
  (options.stdout ?? process.stdout).write(result.stdout);
  (options.stderr ?? process.stderr).write(result.stderr);
  return result.exitCode;
}
