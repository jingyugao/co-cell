#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';

const script = fileURLToPath(import.meta.url);
const root = fileURLToPath(new URL('../../', import.meta.url));
try { process.loadEnvFile(path.join(root, '.env')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const dataDir = path.resolve(root, process.env.LITELLM_DATA_DIR || 'data/litellm');
const unitName = 'swarm-hive-litellm-auth.service';
let source = path.join(process.env.CODEX_HOME || path.join(homedir(), '.codex'), 'auth.json');
let authDir = path.join(dataDir, 'auths');
let mode = '--once';

function systemctl(args) {
  const result = spawnSync('systemctl', ['--user', ...args], { stdio: 'inherit' });
  if (result.error || result.status !== 0) throw new Error('User systemd command failed.');
}

// systemd expands environment references ($) and specifiers (%) in ExecStart.
function unitArgument(value) {
  if (/[\r\n\0]/.test(value)) throw new Error('Paths must not contain line breaks or NUL.');
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('$', () => '$$').replaceAll('%', '%%')}"`;
}

async function removeManaged() {
  await unlink(path.join(authDir, 'auth.json')).catch(error => {
    if (error.code !== 'ENOENT') throw error;
  });
}

async function validateSourceLocation() {
  const inside = (file, directory) => {
    const relative = path.relative(directory, file);
    return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
  };
  // Resolve existing ancestors too, so a not-yet-created directory under a
  // symlink cannot accidentally target the original login directory.
  const resolveLocation = async value => {
    try { return await realpath(value); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(value);
      if (parent === value) return value;
      return path.join(await resolveLocation(parent), path.basename(value));
    }
  };
  if (inside(source, authDir) || inside(await resolveLocation(source), await resolveLocation(authDir))) {
    throw new Error('The source login must be outside the proxy auth directory.');
  }
}

async function credential() {
  try {
    const auth = JSON.parse(await readFile(source, 'utf8'));
    const token = auth.tokens?.access_token;
    const accountId = auth.tokens?.account_id;
    if (auth.auth_mode !== 'chatgpt' || typeof token !== 'string' || typeof accountId !== 'string' || !accountId.trim()) return null;
    const parts = token.split('.');
    if (parts.length !== 3 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) return null;
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (!Number.isSafeInteger(claims.exp) || claims.exp <= Date.now() / 1000) return null;
    const claimAccount = claims['https://api.openai.com/auth']?.chatgpt_account_id;
    if (claimAccount !== undefined && claimAccount !== accountId) return null;
    // LiteLLM uses epoch seconds. Never copy refresh_token or id_token.
    return { access_token: token, account_id: accountId, expires_at: claims.exp };
  } catch { return null; }
}

async function sync() {
  await validateSourceLocation();
  const auth = await credential();
  if (!auth) {
    await removeManaged();
    return 'Local ChatGPT access token unavailable or expired; managed LiteLLM credentials removed.';
  }
  await mkdir(authDir, { recursive: true, mode: 0o700 });
  const target = path.join(authDir, 'auth.json');
  const content = `${JSON.stringify(auth, null, 2)}\n`;
  let previous;
  try { previous = await readFile(target, 'utf8'); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (previous !== content) {
    const temporary = path.join(authDir, `.auth-${randomBytes(12).toString('hex')}.tmp`);
    try {
      await writeFile(temporary, content, { mode: 0o600, flag: 'wx' });
      await rename(temporary, target);
    } finally {
      await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  } else {
    await chmod(target, 0o600);
  }
  return 'Local ChatGPT access token synchronized; refresh credentials remain on the host.';
}

async function main() {
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (['--once', '--watch', '--install', '--uninstall'].includes(arg)) mode = arg;
    else if (arg === '--source' && args[index + 1]) source = path.resolve(args[++index]);
    else if (arg === '--auth-dir' && args[index + 1]) authDir = path.resolve(args[++index]);
    else throw new Error('Usage: auth-sync.mjs [--once|--watch|--install|--uninstall] [--source FILE] [--auth-dir DIR]');
  }
  source = path.resolve(source);
  authDir = path.resolve(authDir);
  await validateSourceLocation();
  const unitPath = path.join(path.dirname(authDir), unitName);
  if (mode === '--uninstall') {
    systemctl(['disable', '--now', unitName]);
    await removeManaged();
    await unlink(unitPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
    systemctl(['daemon-reload']);
    console.log('Local access-token synchronization stopped; managed LiteLLM credentials removed.');
    return;
  }
  if (mode === '--install') {
    const exec = [process.execPath, script, '--watch', '--source', source, '--auth-dir', authDir].map(unitArgument).join(' ');
    const unit = `[Unit]\nDescription=Read-only local Codex access-token mirror for LiteLLM\n\n[Service]\nType=simple\nExecStart=${exec}\nRestart=on-failure\nRestartSec=5\nUMask=0077\n\n[Install]\nWantedBy=default.target\n`;
    await mkdir(path.dirname(unitPath), { recursive: true, mode: 0o700 });
    await writeFile(unitPath, unit, { mode: 0o600 });
    systemctl(['daemon-reload']);
    systemctl(['enable', '--now', unitPath]);
    systemctl(['restart', unitName]);
    console.log('Installed user systemd access-token sync (every 5 seconds). The host remains responsible for OAuth refresh.');
    return;
  }
  let previousStatus;
  do {
    try {
      const status = await sync();
      if (status !== previousStatus) console.log(status);
      previousStatus = status;
    } catch {
      const status = 'Access-token sync failed while updating LiteLLM files; check directory permissions.';
      if (status !== previousStatus) console.error(status);
      previousStatus = status;
      if (mode === '--once') process.exitCode = 1;
    }
    if (mode === '--watch') await setTimeout(5_000);
  } while (mode === '--watch');
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
