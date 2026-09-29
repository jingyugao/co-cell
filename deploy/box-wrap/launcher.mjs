#!/usr/local/bin/node
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_WORKSPACE = '/home/agent/workspace';
const DEFAULT_CODEX = '/usr/local/bin/codex';
const POLL_MS = 250;
const MAX_CONFIG_BYTES = 64 * 1024;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RESERVED_ENV = new Set(['HOME', 'PATH', 'PWD', 'CODEX_HOME', 'NODE_OPTIONS']);

function assertPrivateObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

export function parseConfig(raw) {
  let config;
  try { config = JSON.parse(raw); } catch { throw new Error('provisioning config is not valid JSON'); }
  assertPrivateObject(config, 'provisioning config');
  if (Object.keys(config).some(key => !['version', 'appServerArgs', 'env'].includes(key))) {
    throw new Error('provisioning config contains an unknown field');
  }
  if (config.version !== 1) throw new Error('unsupported provisioning config version');
  if (!Array.isArray(config.appServerArgs)) throw new Error('appServerArgs must be an array');
  if (config.appServerArgs.length > 128) throw new Error('too many App Server arguments');
  for (let i = 0; i < config.appServerArgs.length; i += 2) {
    const flag = config.appServerArgs[i];
    const value = config.appServerArgs[i + 1];
    if (!['-c', '--config', '--enable', '--disable'].includes(flag) ||
        typeof value !== 'string' || !value || value.includes('\0') || value.length > 8192) {
      throw new Error('appServerArgs must contain Codex config or feature flag/value pairs');
    }
  }
  assertPrivateObject(config.env, 'env');
  for (const [key, value] of Object.entries(config.env)) {
    if (!ENV_NAME.test(key) || RESERVED_ENV.has(key) || key.startsWith('CELLBOX_') ||
        key.startsWith('COCELL_LAUNCHER_') || typeof value !== 'string' || value.includes('\0') || value.length > 8192) {
      throw new Error(`invalid provisioning environment variable ${key}`);
    }
  }
  return config;
}

async function ensurePrivateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid()) {
    throw new Error(`runtime directory is not owned by the agent: ${path}`);
  }
  await chmod(path, 0o700);
}

async function takeConfig(path) {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  try {
    const info = await file.stat();
    if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o777) !== 0o600) {
      throw new Error('provisioning config must be a regular agent-owned file with mode 0600');
    }
    if (info.size > MAX_CONFIG_BYTES) throw new Error('provisioning config is too large');
    const config = parseConfig(await file.readFile({ encoding: 'utf8' }));
    // Startup config lives outside workspace archives and is consumed once.
    await unlink(path);
    return config;
  } finally {
    await file.close();
  }
}

function delay(ms, signal) {
  return new Promise(resolve => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); }
    signal.addEventListener('abort', done, { once: true });
  });
}

async function runCodex(config, { workspace, codex, codexHome, signal, log }) {
  const env = {
    PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/home/agent', LANG: 'C.UTF-8',
    CODEX_HOME: codexHome, ...config.env,
  };
  // Cellbox is the Sandbox boundary; Codex must not start its nested Linux sandbox.
  const args = ['app-server', ...config.appServerArgs, '-c', 'sandbox_mode="danger-full-access"',
    '--listen', 'ws://127.0.0.1:4500'];
  log('provisioning accepted; starting Codex App Server on 127.0.0.1:4500');
  return new Promise((resolve, reject) => {
    const child = spawn(codex, args, { cwd: workspace, env, stdio: 'inherit' });
    let stopped = false;
    let killTimer;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 10_000);
      killTimer.unref();
    };
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) stop();
    child.once('error', error => {
      signal.removeEventListener('abort', stop);
      clearTimeout(killTimer);
      reject(new Error(`cannot start Codex App Server: ${error.code ?? 'unknown error'}`));
    });
    child.once('exit', (code, childSignal) => {
      signal.removeEventListener('abort', stop);
      clearTimeout(killTimer);
      log(`Codex App Server exited (code ${code ?? 'none'}, signal ${childSignal ?? 'none'})`);
      resolve(signal.aborted ? 0 : (code || 1));
    });
  });
}

export async function startLauncher({ workspace = DEFAULT_WORKSPACE, codex = DEFAULT_CODEX,
  startupDirectory = '/home/agent/.cocell-startup', pollMs = POLL_MS, signal, log = message => console.error(`cocell launcher: ${message}`) } = {}) {
  if (!signal) throw new Error('an AbortSignal is required');
  const cocellDir = join(workspace, '.cocell');
  const runtimeDir = startupDirectory;
  const codexHome = join(cocellDir, 'codex');
  await ensurePrivateDirectory(cocellDir);
  await ensurePrivateDirectory(runtimeDir);
  await ensurePrivateDirectory(codexHome);
  const configPath = join(runtimeDir, 'config.json');
  log('waiting for provisioning config');
  while (!signal.aborted) {
    const config = await takeConfig(configPath);
    if (config) return runCodex(config, { workspace, codex, codexHome, signal, log });
    await delay(pollMs, signal);
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const shutdown = new AbortController();
  process.on('SIGINT', () => shutdown.abort());
  process.on('SIGTERM', () => shutdown.abort());
  try {
    process.exitCode = await startLauncher({ signal: shutdown.signal });
  } catch (error) {
    // Config and environment values may be secret; only controlled error text is emitted.
    console.error(`cocell launcher: ${error.message}`);
    process.exitCode = 1;
  }
}
