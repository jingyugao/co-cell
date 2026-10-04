import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { parseArgs } from 'node:util';
import { collectCredentialDirectory, FILE_BUNDLE_LIMIT, openMeegleBundle, validateFileBundle } from '../../util/credential-files.mjs';
import { loadDeployEnv } from '../config/deploy-env.mjs';
import { liveTransport } from '../integration/support/kubernetes.mjs';

async function readCredential(root, path, limit = FILE_BUNDLE_LIMIT) {
  const file = await open(resolve(root, path), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > limit) throw new Error('Invalid credential file');
    const bytes = await file.readFile();
    if (bytes.length > limit) throw new Error('Credential exceeds limit');
    return bytes;
  } finally { await file.close(); }
}
let transport;
try {
  const { values } = parseArgs({ options: {
    tool: { type: 'string' }, name: { type: 'string' }, directory: { type: 'string' },
    path: { type: 'string' }, primary: { type: 'string' }, mutable: { type: 'boolean' },
    'meegle-native': { type: 'boolean' }, 'dry-run': { type: 'boolean' }, help: { type: 'boolean' },
  } });
  if (values.help) {
    console.log('Usage: pnpm credentials:import-directory --tool CLI --name NAME --directory SOURCE --path HOME_RELATIVE_DIRECTORY --primary RELATIVE_CONFIG [--mutable] [--dry-run] [--meegle-native]');
    console.log('Imports the directory recursively, preserving binary files. Links and special files are rejected. --meegle-native enables only Meegle machine binding migration.');
  } else {
    if (!values.tool || !values.name || !values.directory || !values.path || !values.primary) throw new Error('Missing required import options');
    const source = resolve(values.directory.replace(/^~\//, homedir() + '/'));
    const sourceDirectory = basename(source), primaryPath = `${sourceDirectory}/${values.primary}`;
    // Validate destination and primary paths before touching source files.
    validateFileBundle({ directory: values.path, files: [{ path: `${values.path}/${values.primary}`, content: '' }] });
    const files = (await collectCredentialDirectory(dirname(source), sourceDirectory, primaryPath, readCredential))
      .map(file => ({ ...file, path: values.path + file.path.slice(sourceDirectory.length) }));
    const bundle = validateFileBundle({ directory: values.path, files,
      ...(values['meegle-native'] ? { adapter: 'meegle', identity: { hostname: hostname(), username: process.env.USER || 'unknown' } } : {}),
    });
    if (bundle.adapter) openMeegleBundle(bundle);
    console.log({ tool: values.tool, name: values.name, directory: bundle.directory, fileCount: files.length, machineBinding: !!bundle.adapter });
    if (!values['dry-run']) {
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
      const name = values.name;
      const input = { name, tool: values.tool, path: bundle.files[0].path, format: 'files', mutable: !!values.mutable, ...bundle };
      const matches = (await api('/api/secrets')).filter(secret => secret.name === name && secret.tool === values.tool);
      if (matches.length > 1) throw new Error('Duplicate import target');
      const saved = matches.length ? await api(`/api/secrets/${matches[0].id}`, 'PATCH', { ...input, enabled: true }) : await api('/api/secrets', 'POST', input);
      const check = await api(`/api/secrets/${saved.id}/content`);
      if (check.format !== 'files' || JSON.stringify(check.files) !== JSON.stringify(bundle.files) || check.directory !== bundle.directory || check.adapter !== bundle.adapter || JSON.stringify(check.identity) !== JSON.stringify(bundle.identity)) throw new Error('Import verification failed');
      console.log({ imported: true, target: publicURL.origin, id: saved.id, name: saved.name, version: saved.version });
    }
  }
} catch {
  // CLI/API errors can contain credential contents; never print their raw text.
  console.error('凭证目录导入失败：请检查参数、目录文件及目标 CoCell 是否已支持目录凭证。使用 --help 查看参数。');
  process.exitCode = 1;
} finally { await transport?.close(); }
