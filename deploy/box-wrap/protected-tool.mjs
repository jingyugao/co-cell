import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, normalize } from 'node:path';

const LIMIT = 65536;
const toolName = /^[A-Za-z][A-Za-z0-9_.\-]{0,63}$/;
function safePath(path) {
  return typeof path === 'string' && path.length > 0 && path.length <= 256 && !path.startsWith('/') && normalize(path) === path &&
    !/[\\\u0000-\u001f\u007f]/.test(path) && path.split('/').every(part => part && part !== '.' && part !== '..');
}
function sensitiveValues(bytes) {
  const values = bytes.length >= 6 ? [bytes.toString('utf8')] : [];
  try {
    function visit(value, key = '') {
      if (typeof value === 'string' && /token|password|secret|(?:private|client).?key/i.test(key) && value.length) values.push(value);
      else if (value && typeof value === 'object') for (const [name, child] of Object.entries(value)) visit(child, name);
    }
    visit(JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')));
  } catch {
    for (const line of bytes.toString('utf8').split('\n')) {
      const match = /^\s*([^:=\s]+)\s*[:=]\s*["']?(.+?)["']?\s*$/.exec(line);
      if (match?.[2]?.length && /token|password|secret|(?:private|client).?key/i.test(match[1])) values.push(match[2]);
    }
  }
  return values.filter(Boolean);
}
async function readCredential(root, path) {
  let current = root;
  for (const part of path.split('/').slice(0, -1)) {
    current = join(current, part); const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe credential directory');
  }
  const file = await open(join(root, path), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > LIMIT) throw new Error('Invalid credential file');
    const bytes = await file.readFile();
    if (bytes.length > LIMIT) throw new Error('Credential exceeds limit');
    return bytes;
  } finally { await file.close(); }
}
async function execute(executable, args, env, cwd) {
  return new Promise(resolve => {
    const child = spawn(executable, args, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    let stdout = '', stderr = '', size = 0;
    const collect = target => chunk => { size += chunk.length; if (size <= 1024 * 1024) { if (target === 'out') stdout += chunk; else stderr += chunk; } };
    child.stdout.on('data', collect('out')); child.stderr.on('data', collect('err'));
    const kill = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Already exited. */ } };
    // Cellbox's default protected-tool timeout is 30 seconds. Leave time for
    // authorization and credential persistence before the supervisor kills us.
    const timer = setTimeout(kill, 20000);
    child.once('error', () => { clearTimeout(timer); resolve({ exitCode: 1, stdout: '', stderr: 'Tool executable is unavailable\n' }); });
    child.once('close', (code, signal) => { clearTimeout(timer); resolve({ exitCode: signal ? 124 : code ?? 1, stdout, stderr }); });
  });
}
/** Injectable paths/transport support isolated tests without host credentials. */
export async function runProtectedTool(tool, inputArgs, options = {}) {
  if (!toolName.test(tool)) throw new Error('Invalid protected tool name');
  const config = options.config ?? JSON.parse(await readFile(process.env.COCELL_TOOL_RUNTIME, 'utf8'));
  const base = new URL(config.url);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash || base.pathname !== '/') throw new Error('Invalid broker origin');
  const transport = options.fetch ?? fetch;
  const request = async (path, body) => {
    const response = await transport(new URL(path, base), { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(4000), headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.token}` }, body: JSON.stringify(body) });
    if (!response.ok) throw new Error('Project authorization or Secret update failed');
    return response.json();
  };
  const setup = await request('/api/tool-runtime/start', { tool, args: inputArgs });
  if (setup.tool !== tool || !Array.isArray(setup.files) || setup.files.length !== 1) throw new Error('Invalid tool setup');
  const parent = options.tempRoot ?? '/var/lib/cellbox/debug/tool-runs';
  await mkdir(parent, { recursive: true, mode: 0o700 }); await chmod(parent, 0o700);
  const root = await mkdtemp(join(parent, 'run-'));
  const originals = new Map(), masks = [config.token]; let retain = false;
  try {
    for (const file of setup.files) {
      if (!safePath(file.path) || originals.has(file.path)) throw new Error('Invalid tool file');
      const bytes = Buffer.from(file.content, 'base64');
      if (!bytes.length || bytes.length > LIMIT) throw new Error('Invalid tool credential');
      const destination = join(root, file.path);
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      await writeFile(destination, bytes, { mode: 0o600, flag: 'wx' });
      originals.set(file.path, bytes); masks.push(...sensitiveValues(bytes));
    }
    const env = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: root, LANG: 'C.UTF-8', XDG_CONFIG_HOME: join(root, '.config'), XDG_DATA_HOME: join(root, '.local/share') };
    let argv = setup.args;
    const credential = join(root, setup.files[0].path);
    if (tool === 'kubectl') env.KUBECONFIG = credential;
    if (tool === 'glab') env.GLAB_CONFIG_DIR = dirname(credential);
    if (tool === 'mysql') argv = [`--defaults-file=${credential}`, ...argv];
    retain = setup.files.some(file => file.mutable);
    const result = await execute(join(options.binaryRoot ?? '/opt/cellbox/debug-bin', tool), argv, env, root);
    const updates = [];
    for (const file of setup.files) {
      const bytes = await readCredential(root, file.path); masks.push(...sensitiveValues(bytes));
      if (file.mutable && !bytes.equals(originals.get(file.path))) updates.push({ secretId: file.secretId, content: bytes.toString('base64') });
    }
    const redact = text => masks.sort((a, b) => b.length - a.length).reduce((value, secret) => secret ? value.replaceAll(secret, '[REDACTED]') : value, text);
    let exitCode = result.exitCode;
    try { await request(`/api/tool-runtime/${setup.id}/complete`, { updates, exitCode }); retain = false; }
    catch {
      retain = updates.length > 0;
      console.error(retain ? 'Secret update failed; refreshed files retained in the protected tool directory' : 'Tool completion could not be recorded');
      exitCode = 1;
    }
    (options.stdout ?? process.stdout).write(redact(result.stdout));
    (options.stderr ?? process.stderr).write(redact(result.stderr));
    return exitCode;
  } finally { if (!retain) await rm(root, { recursive: true, force: true }); }
}
