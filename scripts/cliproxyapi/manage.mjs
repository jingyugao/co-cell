#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../../', import.meta.url));
const dataDir = path.resolve(process.env.CLIPROXY_DATA_DIR || path.join(root, 'data/cliproxyapi'));
const image = 'eceasy/cli-proxy-api:v7.2.154';
const [command = 'help', ...args] = process.argv.slice(2);
const usage = `Usage: node scripts/cliproxyapi/manage.mjs <command>
  init [--listen 127.0.0.1] [--port 8317] [--base-url https://proxy.example.com/v1]
  up       Start the pinned CLIProxyAPI Docker Compose service
  login    Log in separately with Codex device authorization (interactive)
  use-local  Mirror the host's current access token through a user systemd service
  status   Show container status and saved credential count, without secrets
  check    Check authenticated /v1/models (does not generate a model response)
  down     Stop the service, preserving config and credentials

Data defaults to data/cliproxyapi; CLIPROXY_DATA_DIR overrides that directory.
init refuses to overwrite existing data. Only use-local reads local Codex credentials;
it never copies refresh tokens or modifies the source login.`;

async function readSettings() {
  return JSON.parse(await readFile(path.join(dataDir, 'settings.json'), 'utf8'));
}

function compose(extra) {
  const result = spawnSync('docker', ['compose', '--project-name', 'swarm-hive-cliproxyapi',
    '--file', path.join(dataDir, 'compose.json'), ...extra], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Docker Compose exited with status ${result.status ?? result.signal}.`);
}

function initOptions() {
  const result = { listen: '127.0.0.1', port: 8317, baseUrl: undefined };
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index];
    const value = args[index + 1];
    if (!value || !['--listen', '--port', '--base-url'].includes(option)) {
      throw new Error(`Invalid init option: ${option}.\n${usage}`);
    }
    if (option === '--listen') result.listen = value;
    if (option === '--port') result.port = Number(value);
    if (option === '--base-url') result.baseUrl = value;
  }
  if (!isIP(result.listen)) throw new Error('--listen must be an IPv4 or IPv6 address.');
  if (!Number.isInteger(result.port) || result.port < 1 || result.port > 65535) {
    throw new Error('--port must be an integer between 1 and 65535.');
  }
  const localHost = ['0.0.0.0', '::'].includes(result.listen) ? '127.0.0.1' : result.listen;
  result.checkUrl = `http://${isIP(localHost) === 6 ? `[${localHost}]` : localHost}:${result.port}/v1`;
  const baseUrl = new URL(result.baseUrl || result.checkUrl);
  if (!['http:', 'https:'].includes(baseUrl.protocol) || baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) {
    throw new Error('--base-url must be an HTTP(S) URL without credentials, query, or fragment.');
  }
  if (baseUrl.pathname.replace(/\/+$/, '') !== '/v1') throw new Error('--base-url must end in /v1.');
  result.baseUrl = baseUrl.toString().replace(/\/+$/, '');
  return result;
}

async function init() {
  const settings = initOptions();
  if (!process.getuid || !process.getgid) throw new Error('Run this helper under Linux/macOS/WSL.');
  await mkdir(path.dirname(dataDir), { recursive: true });
  await mkdir(dataDir, { mode: 0o700 });
  await Promise.all(['auths', 'logs'].map(name => mkdir(path.join(dataDir, name), { mode: 0o700 })));
  const apiKey = `sh-${randomBytes(32).toString('hex')}`;
  const config = `# Managed initial configuration; credentials live only in /auths.
host: ""
port: 8317
auth-dir: "/auths"
api-keys:
  - "${apiKey}"
remote-management:
  allow-remote: false
  secret-key: ""
  disable-control-panel: true
debug: false
request-log: false
commercial-mode: true
logging-to-file: false
usage-statistics-enabled: false
pprof:
  enable: false
plugins:
  enabled: false
ws-auth: true
request-retry: 3
max-retry-interval: 30
`;
  const composeConfig = {
    services: {
      proxy: {
        image,
        restart: 'unless-stopped',
        user: `${process.getuid()}:${process.getgid()}`,
        entrypoint: ['/CLIProxyAPI/CLIProxyAPI'],
        command: ['--config', '/CLIProxyAPI/config.yaml'],
        environment: { HOME: '/tmp', TZ: 'Asia/Shanghai' },
        ports: [{ target: 8317, published: String(settings.port), host_ip: settings.listen, protocol: 'tcp' }],
        volumes: [
          { type: 'bind', source: path.join(dataDir, 'config.yaml'), target: '/CLIProxyAPI/config.yaml', read_only: true },
          { type: 'bind', source: path.join(dataDir, 'auths'), target: '/auths' },
          { type: 'bind', source: path.join(dataDir, 'logs'), target: '/CLIProxyAPI/logs' },
        ],
        logging: { driver: 'json-file', options: { 'max-size': '10m', 'max-file': '3' } },
      },
    },
  };
  const files = {
    'config.yaml': config,
    'compose.json': `${JSON.stringify(composeConfig, null, 2)}\n`,
    'settings.json': `${JSON.stringify(settings, null, 2)}\n`,
    'swarm-hive.env': `# Merge these settings into the service environment; this file contains a secret.\n# Loopback URLs work only on this host. E2B needs a reachable URL; use HTTPS outside trusted local networking.\nCODEX_PROXY_KIND=cliproxyapi\nOPENAI_BASE_URL=${settings.baseUrl}\nCODEX_API_KEY=${apiKey}\n`,
  };
  await Promise.all(Object.entries(files).map(([name, content]) =>
    writeFile(path.join(dataDir, name), content, { mode: 0o600, flag: 'wx' })));
  console.log(`Initialized ${dataDir}\nImage: ${image}\nListen: ${settings.listen}:${settings.port}\nService environment: ${path.join(dataDir, 'swarm-hive.env')} (0600; contains proxy key)\nNext: run up, then login. Existing .env and local Codex credentials were not changed.`);
}

async function check(settings) {
  const environment = await readFile(path.join(dataDir, 'swarm-hive.env'), 'utf8');
  const apiKey = environment.match(/^CODEX_API_KEY=(.+)$/m)?.[1];
  if (!apiKey) throw new Error('Missing proxy key in swarm-hive.env.');
  const response = await fetch(`${settings.checkUrl}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(15_000),
    redirect: 'error',
  });
  if (!response.ok) throw new Error(`CLIProxyAPI /v1/models returned HTTP ${response.status}.`);
  const body = await response.json();
  if (!Array.isArray(body.data)) throw new Error('CLIProxyAPI returned an invalid model list.');
  console.log(`CLIProxyAPI API authentication succeeded; ${body.data.length} models available.`);
  if (body.data.length === 0) throw new Error('No models available. Complete login first.');
  console.log('This checks the local API and model inventory; a real streamed turn must verify upstream login and E2B reachability.');
}

async function main() {
  if (['help', '--help', '-h'].includes(command)) return console.log(usage);
  if (command === 'init') return init();
  if (!['up', 'login', 'use-local', 'status', 'check', 'down'].includes(command) || args.length) {
    throw new Error(usage);
  }
  const settings = await readSettings();
  if (command === 'up') return compose(['up', '--detach']);
  if (command === 'down') return compose(['down']);
  if (command === 'use-local') {
    const existingAuths = await readdir(path.join(dataDir, 'auths'));
    if (existingAuths.some(name => name.endsWith('.json') && !/^host-codex-[a-f0-9]{24}\.json$/.test(name))) {
      throw new Error('The proxy auth directory contains independent credentials. Move them to a separate secure directory before enabling local-token sync; no files were changed.');
    }
    const composePath = path.join(dataDir, 'compose.json');
    const config = JSON.parse(await readFile(composePath, 'utf8'));
    const authMount = config.services?.proxy?.volumes?.find(volume => volume.target === '/auths');
    if (!authMount) throw new Error('Missing /auths mount in generated Compose configuration.');
    authMount.read_only = true;
    await writeFile(composePath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    settings.authMode = 'host-access-token';
    await writeFile(path.join(dataDir, 'settings.json'), `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
    compose(['up', '--detach']);
    const result = spawnSync(process.execPath, [path.join(root, 'scripts/cliproxyapi/auth-sync.mjs'), '--install'], { stdio: 'inherit' });
    if (result.error || result.status !== 0) throw new Error('Local access-token sync installation failed.');
    return;
  }
  if (command === 'login') {
    const entries = await readdir(dataDir);
    const auths = await readdir(path.join(dataDir, 'auths'));
    if (settings.authMode === 'host-access-token' || entries.includes('swarm-hive-cliproxyapi-auth.service') || auths.some(name => /^host-codex-[a-f0-9]{24}\.json$/.test(name))) {
      throw new Error('Local-token mode is enabled. Run auth-sync.mjs --uninstall, restore a writable /auths mount and remove settings.json authMode before independent login.');
    }
    if (!process.stdin.isTTY) throw new Error('login needs an interactive terminal.');
    return compose(['run', '--rm', '--no-deps', 'proxy', '--config', '/CLIProxyAPI/config.yaml', '--codex-device-login']);
  }
  if (command === 'status') {
    compose(['ps']);
    const count = (await readdir(path.join(dataDir, 'auths'))).filter(name => name.endsWith('.json')).length;
    console.log(`Saved credential files: ${count}\nAuthentication: ${settings.authMode || 'independent-login'}\nListen: ${settings.listen}:${settings.port}\nCredential count does not verify token validity; run check after login.`);
    return;
  }
  await check(settings);
}

main().catch(error => {
  console.error(error.code === 'EEXIST' ? `Already initialized: ${dataDir}. Existing configuration was preserved.` : error.message);
  process.exitCode = 1;
});
