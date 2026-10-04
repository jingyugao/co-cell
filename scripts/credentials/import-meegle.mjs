import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { promisify } from 'node:util';
import { openMeegleBundle, validateFileBundle } from '../../deploy/box-wrap/credential-files.mjs';
import { loadDeployEnv } from '../config/deploy-env.mjs';
import { liveTransport } from '../integration/support/kubernetes.mjs';

const exec = promisify(execFile);
async function privateText(path) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || !info.size || info.size > 65536) throw new Error('Invalid credential file');
    const bytes = await file.readFile(), content = bytes.toString('utf8');
    if (!Buffer.from(content).equals(bytes)) throw new Error('Invalid UTF-8');
    return content;
  } finally { await file.close(); }
}
let transport;
try {
  if (process.argv.slice(2).some(arg => arg !== '--dry-run')) throw new Error('Usage: pnpm credentials:import-meegle [--dry-run]');
  const root = join(homedir(), '.meegle'), originalConfig = await privateText(join(root, 'config.json'));
  const config = JSON.parse(originalConfig), profile = config.current || 'default';
  if (typeof profile !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(profile)) throw new Error('Invalid profile');
  const env = { ...process.env };
  // Validate the native OAuth login, rather than an ambient short-term token.
  delete env.MEEGLE_USER_ACCESS_TOKEN;
  const status = JSON.parse((await exec('meegle', ['--profile', profile, 'auth', 'status', '--format', 'json'], { env, timeout: 20000, maxBuffer: 65536 })).stdout);
  if (!status.authenticated) throw new Error('Native Meegle login is unavailable');
  const credential = profile === 'default' ? 'credentials.enc' : `credentials-${profile}.enc`;
  const bundle = validateFileBundle({ adapter: 'meegle', identity: { hostname: hostname(), username: process.env.USER || 'unknown' }, files: [
    { path: '.meegle/config.json', content: await privateText(join(root, 'config.json')) },
    { path: '.meegle/.machine-key', content: await privateText(join(root, '.machine-key')) },
    { path: `.meegle/${credential}`, content: await privateText(join(root, credential)) },
  ] });
  const data = openMeegleBundle(bundle);
  if (!data.refresh_token || !data.client_id) throw new Error('The login has no refresh token or client ID');
  console.log({ profile, filePaths: bundle.files.map(file => file.path), identity: bundle.identity, refreshable: true });
  if (!process.argv.includes('--dry-run')) {
    loadDeployEnv(); transport = await liveTransport(process.env);
    const env = { ...process.env, ...transport.env };
    if (!env.COCELL_E2E_BASE_URL || !env.COCELL_E2E_ACCESS_TOKEN) throw new Error('Configure the CoCell target in deploy.env');
    const base = new URL(env.COCELL_E2E_BASE_URL), publicURL = new URL(env.COCELL_E2E_PUBLIC_URL || base.href);
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash || base.pathname !== '/') throw new Error('Invalid target origin');
    const api = (path, method = 'GET', body) => new Promise((resolve, reject) => {
      const req = (base.protocol === 'https:' ? httpsRequest : httpRequest)(new URL(path, base), { method, timeout: 15000,
        headers: { Authorization: `Bearer ${env.COCELL_E2E_ACCESS_TOKEN}`, Host: publicURL.host, Origin: publicURL.origin, ...(body ? { 'Content-Type': 'application/json' } : {}) } }, res => {
        let input = ''; res.setEncoding('utf8'); res.on('data', chunk => input += chunk);
        res.on('end', () => { if (res.statusCode >= 300) reject(new Error(`CoCell HTTP ${res.statusCode}`)); else { try { resolve(JSON.parse(input)); } catch { reject(new Error('Invalid API response')); } } });
      });
      req.on('error', () => reject(new Error('CoCell connection failed'))); req.on('timeout', () => req.destroy());
      req.end(body ? JSON.stringify(body) : undefined);
    });
    const name = '本机 Meegle（原生文件组）';
    const input = { name, tool: 'meegle', path: bundle.files[0].path, format: 'files', mutable: true, ...bundle };
    const matches = (await api('/api/secrets')).filter(secret => secret.name === name && secret.tool === 'meegle');
    if (matches.length > 1) throw new Error('Duplicate import target');
    const saved = matches.length ? await api(`/api/secrets/${matches[0].id}`, 'PATCH', { ...input, enabled: true }) : await api('/api/secrets', 'POST', input);
    const check = await api(`/api/secrets/${saved.id}/content`);
    if (check.format !== 'files' || JSON.stringify(check.files) !== JSON.stringify(bundle.files) || JSON.stringify(check.identity) !== JSON.stringify(bundle.identity)) throw new Error('Import verification failed');
    console.log({ imported: true, target: publicURL.origin, id: saved.id, name: saved.name, version: saved.version });
  }
} catch {
  // CLI/API errors can contain credential contents; never print their raw text.
  console.error('Meegle 文件组导入失败：请检查原生 OAuth 登录、来源身份及 CoCell 是否已支持文件组。');
  process.exitCode = 1;
} finally { await transport?.close(); }
