#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { isIP } from 'node:net';
import { parseEnv } from 'node:util';

const root = fileURLToPath(new URL('../../', import.meta.url));
try { process.loadEnvFile(path.join(root, '.env')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const directory = path.resolve(root, process.env.LITELLM_DATA_DIR || 'data/litellm');
const command = process.argv[2] || 'help';
const image = 'ghcr.io/berriai/litellm:v1.100.0';
function compose(args) {
  const result = spawnSync('docker', ['compose', '-f', path.join(root, 'docker-compose.yml'), ...args], { cwd: root, stdio: 'inherit' });
  if (result.error || result.status !== 0) throw new Error('LiteLLM Docker Compose command failed');
}
async function main() {
  if (command === 'init') {
    const url = new URL(process.argv[3] || 'http://127.0.0.1:8317/v1');
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/v1') throw new Error('Provide an HTTP(S) base URL ending in /v1 without credentials');
    const listen = process.env.LITELLM_LISTEN || '127.0.0.1';
    if (!isIP(listen)) throw new Error('LITELLM_LISTEN must be an IP address');
    const checkHost = listen === '0.0.0.0' ? '127.0.0.1' : listen === '::' ? '::1' : listen;
    await mkdir(path.dirname(directory), { recursive: true });
    await mkdir(directory, { mode: 0o700 });
    await mkdir(path.join(directory, 'auths'), { mode: 0o700 });
    const key = `sk-${randomBytes(32).toString('hex')}`;
    const models = ['gpt-5.6-terra', 'gpt-5.6-sol', 'gpt-5.6-luna', 'gpt-6-astra'];
    const config = { model_list: models.map(model => ({ model_name: model, model_info: { mode: 'responses' }, litellm_params: { model: `chatgpt/${model}` } })),
      general_settings: { master_key: 'os.environ/LITELLM_MASTER_KEY', disable_spend_logs: true },
      litellm_settings: { telemetry: false, set_verbose: false, request_timeout: 600, num_retries: 0 },
    };
    for (const [name, value] of Object.entries({
      'config.yaml': JSON.stringify(config, null, 2),
      'proxy.env': `LITELLM_MASTER_KEY=${key}\n`,
      'settings.json': JSON.stringify({ baseUrl: url.href, checkUrl: `http://${isIP(checkHost) === 6 ? `[${checkHost}]` : checkHost}:8317/v1` }),
      'swarm-hive.env': `CODEX_PROXY_KIND=litellm\nOPENAI_BASE_URL=${url.href}\nCODEX_API_KEY=${key}\nLITELLM_LISTEN=${listen}\nLITELLM_UID=${process.getuid()}\nLITELLM_GID=${process.getgid()}\nLITELLM_DATA_DIR=${directory}\n`,
    })) await writeFile(path.join(directory, name), value, { mode: 0o600, flag: 'wx' });
    console.log(`Initialized ${directory}; image ${image}. Run activate, auth-sync.mjs --install, then up.`);
    return;
  }
  if (command === 'up') return compose(['up', '-d', '--no-deps', 'litellm']);
  if (command === 'down') return compose(['stop', 'litellm']);
  if (command === 'status') return compose(['ps', 'litellm']);
  if (command === 'activate') {
    const source = await readFile(path.join(directory, 'swarm-hive.env'), 'utf8');
    const envPath = path.join(root, '.env');
    const previous = await readFile(envPath, 'utf8');
    const backup = path.join(directory, `service-env-before-${Date.now()}.env`);
    await writeFile(backup, previous, { mode: 0o600, flag: 'wx' });
    let next = previous;
    for (const line of source.trim().split('\n')) {
      const name = line.split('=')[0];
      if (!['CODEX_PROXY_KIND', 'OPENAI_BASE_URL', 'CODEX_API_KEY', 'LITELLM_LISTEN', 'LITELLM_UID', 'LITELLM_GID', 'LITELLM_DATA_DIR'].includes(name)) throw new Error('Unexpected generated environment key');
      const pattern = new RegExp(`^${name}=.*$`, 'm');
      next = pattern.test(next) ? next.replace(pattern, () => line) : `${next.trimEnd()}\n${line}\n`;
    }
    const profiles = parseEnv(next).COMPOSE_PROFILES?.split(',').map(value => value.trim()).filter(Boolean) ?? [];
    if (!profiles.includes('litellm')) profiles.push('litellm');
    const profileLine = `COMPOSE_PROFILES=${profiles.join(',')}`;
    next = /^COMPOSE_PROFILES=/m.test(next) ? next.replace(/^COMPOSE_PROFILES=.*$/m, profileLine) : `${next.trimEnd()}\n${profileLine}\n`;
    await writeFile(envPath, next, { mode: 0o600 });
    console.log(`Application environment updated; backup: ${backup}. Recreate the Web container after checking active turns.`);
    return;
  }
  if (command === 'check') {
    const settings = JSON.parse(await readFile(path.join(directory, 'settings.json'), 'utf8'));
    const key = (await readFile(path.join(directory, 'proxy.env'), 'utf8')).match(/^LITELLM_MASTER_KEY=(.+)$/m)?.[1];
    const response = await fetch(`${settings.checkUrl}/models`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`Model inventory returned HTTP ${response.status}`);
    const result = await response.json();
    console.log(`Authenticated model inventory: ${result.data.map(model => model.id).join(', ')}. Upstream generation still needs verification.`);
    return;
  }
  console.log('Usage: node scripts/litellm/manage.mjs init [Sandbox_BASE_URL] | up | down | status | check | activate\nLITELLM_LISTEN controls the bind address at init; default 127.0.0.1. Credentials are generated under data/litellm.');
}
main().catch(error => { console.error(error.code === 'EEXIST' ? 'Already initialized; existing configuration preserved.' : error.message); process.exitCode = 1; });
