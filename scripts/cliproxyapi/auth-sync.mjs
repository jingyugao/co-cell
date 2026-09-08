#!/usr/bin/env node
import { createHash, randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';

const script = fileURLToPath(import.meta.url);
const root = fileURLToPath(new URL('../../', import.meta.url));
const dataDir = path.resolve(process.env.CLIPROXY_DATA_DIR || path.join(root, 'data/cliproxyapi'));
const unitName = 'swarm-hive-cliproxyapi-auth.service';
const managedPattern = /^host-codex-[a-f0-9]{24}\.json$/;
let source = path.join(process.env.CODEX_HOME || path.join(homedir(), '.codex'), 'auth.json');
let authDir = path.join(dataDir, 'auths');
let mode = '--once';
const args = process.argv.slice(2);

function systemctl(args) {
  const result = spawnSync('systemctl', ['--user', ...args], { stdio: 'inherit' });
  if (result.error || result.status !== 0) throw new Error('User systemd command failed.');
}

// systemd performs both environment ($) and specifier (%) expansion in ExecStart.
function unitArgument(value) {
  if (/[\r\n\0]/.test(value)) throw new Error('Paths must not contain line breaks or NUL.');
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('$', () => '$$').replaceAll('%', '%%')}"`;
}

async function removeManaged(keep) {
  let names;
  try { names = await readdir(authDir); } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  for (const name of names) {
    if (managedPattern.test(name) && name !== keep) await unlink(path.join(authDir, name)).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

async function validateSourceLocation() {
  const inside = (file, directory) => {
    const relative = path.relative(directory, file);
    return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
  };
  const resolveExisting = async value => realpath(value).catch(error => {
    if (error.code === 'ENOENT') return value;
    throw error;
  });
  if (inside(source, authDir) || inside(await resolveExisting(source), await resolveExisting(authDir))) {
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
    if (!Number.isSafeInteger(claims.exp) || claims.exp * 1000 <= Date.now()) return null;
    const claimAccount = claims['https://api.openai.com/auth']?.chatgpt_account_id;
    if (claimAccount !== undefined && claimAccount !== accountId) return null;
    // Deliberately omit refresh_token, id_token, and all source metadata.
    return { type: 'codex', access_token: token, account_id: accountId, expired: new Date(claims.exp * 1000).toISOString(), disabled: false };
  } catch { return null; }
}

async function sync() {
  await validateSourceLocation();
  const auth = await credential();
  if (!auth) {
    await removeManaged();
    return 'Local ChatGPT access token unavailable or expired; managed proxy credentials removed.';
  }
  await mkdir(authDir, { recursive: true, mode: 0o700 });
  const generation = createHash('sha256').update(JSON.stringify([auth.access_token, auth.account_id])).digest('hex').slice(0, 24);
  const name = `host-codex-${generation}.json`;
  const target = path.join(authDir, name);
  const content = `${JSON.stringify(auth, null, 2)}\n`;
  let previous;
  try { previous = await readFile(target, 'utf8'); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (previous !== content) {
    const temporary = path.join(authDir, `.host-codex-${randomBytes(12).toString('hex')}.tmp`);
    try {
      await writeFile(temporary, content, { mode: 0o600, flag: 'wx' });
      await rename(temporary, target);
    } finally {
      await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  } else {
    await chmod(target, 0o600);
  }
  // Each token gets a fresh CPA auth ID instead of retaining the old token's 401 cooldown.
  await removeManaged(name);
  return 'Local ChatGPT access token synchronized; refresh credentials remain on the host.';
}

async function main() {
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
    console.log('Local access-token synchronization stopped; managed credentials removed.');
    return;
  }
  if (mode === '--install') {
    const exec = [process.execPath, script, '--watch', '--source', source, '--auth-dir', authDir].map(unitArgument).join(' ');
    const unit = `[Unit]\nDescription=Read-only local Codex access-token mirror for CLIProxyAPI\n\n[Service]\nType=simple\nExecStart=${exec}\nRestart=on-failure\nRestartSec=5\nUMask=0077\n\n[Install]\nWantedBy=default.target\n`;
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
      const status = 'Access-token sync failed while updating proxy files; check directory permissions.';
      if (status !== previousStatus) console.error(status);
      previousStatus = status;
      if (mode === '--once') process.exitCode = 1;
    }
    if (mode === '--watch') await setTimeout(5_000);
  } while (mode === '--watch');
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
