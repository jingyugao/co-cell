import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import type { ConnectionInventory } from '../../protocol/connection-types.js';
import { HttpError } from '../../util/errors.js';
import { importLarkCredentials } from './lark-credentials.js';
import { readMeegleCredentials } from './meegle-credentials.js';
import { importKubernetesCredentials, KUBERNETES_CREDENTIAL_POLICY } from './kubernetes-credentials.js';

export interface ConnectionBundle {
  importedAt: string;
  connections: ConnectionInventory['connections'];
  mysqlLogin?: string;
  glabConfig: string;
  gitCredentials: string;
  gitConfig: string;
  cliFiles?: Record<string, string>;
  kubernetesPolicy?: string;
}
export const CONNECTION_ROOT = '/home/user/.codex-web/credentials';
export const CONNECTION_ENVS = {
  GLAB_CONFIG_DIR: `${CONNECTION_ROOT}/current/glab`,
  MYSQL_TEST_LOGIN_FILE: `${CONNECTION_ROOT}/current/.mylogin.cnf`,
  GIT_TERMINAL_PROMPT: '0',
};
export type LocalCommand = (command: string, args: string[], input?: string) => Promise<string>;
export function localCredentialEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...source, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GH_PROMPT_DISABLED: 'true' };
  // App dotenv credentials are not host-specific CLI credentials. In glab,
  // GITLAB_TOKEN even overrides `config get token --host other-host --global`.
  for (const key of ['GITLAB_TOKEN', 'GITLAB_ACCESS_TOKEN', 'GLAB_TOKEN', 'OAUTH_TOKEN', 'CI_JOB_TOKEN', 'GITLAB_HOST', 'GITLAB_BASE_URL', 'GITLAB_USERNAME', 'GLAB_CONFIG_DIR']) delete env[key];
  return env;
}
// Output stays in memory. Errors deliberately omit command stdout/stderr, which
// can include the requested token or credential-helper response.
const localCommand: LocalCommand = (command, args, input) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], env: localCredentialEnvironment(process.env) });
  let output = '', failed = false;
  const timer = setTimeout(() => { failed = true; child.kill(); }, 15_000);
  child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; if (output.length > 1024 * 1024) { failed = true; child.kill(); } });
  child.stderr.resume(); child.stdin.on('error', () => {}); child.stdin.end(input ?? '');
  child.once('error', () => { clearTimeout(timer); reject(new Error('无法读取本机认证配置')); });
  child.once('close', code => { clearTimeout(timer); code === 0 && !failed ? resolve(output.trimEnd()) : reject(new Error('本机认证配置不可用')); });
});
const safeHost = (value: string) => /^[a-zA-Z0-9][a-zA-Z0-9.-]*(?::\d{1,5})?$/.test(value);
const setting = (value: string) => JSON.stringify(value.replace(/[\r\n\0]/g, '').slice(0, 300));
export function glabHosts(text: string) {
  let active = false, indent: number | undefined;
  const hosts: string[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === 'hosts:' && !/^\s/.test(line)) { active = true; continue; }
    if (!active) continue;
    if (/^\S/.test(line)) break;
    const match = line.match(/^(\s+)([^\s]+):\s*$/);
    if (!match) continue;
    indent ??= match[1].length;
    const host = match[2].replace(/^["']|["']$/g, '');
    if (match[1].length === indent && safeHost(host)) hosts.push(host);
  }
  return [...new Set(hosts)];
}
export function mysqlProfiles(masked: string): ConnectionInventory['connections'] {
  const profiles: ConnectionInventory['connections'] = [];
  let current: ConnectionInventory['connections'][number] | undefined;
  for (const line of masked.split('\n')) {
    const section = line.match(/^\[([^\]\r\n]+)\]$/);
    if (section) { current = { id: `mysql:${section[1]}`, type: 'mysql', name: section[1] }; profiles.push(current); continue; }
    const value = line.match(/^(host|user)\s*=\s*"(.*)"$/);
    if (current && value) current[value[1] === 'host' ? 'host' : 'username'] = value[2].slice(0, 300);
  }
  return profiles;
}
function glabUser(yaml: string, host: string) {
  let indent = -1;
  for (const line of yaml.split('\n')) {
    if (line.trim().replace(/^['"]|['"](?=:)/g, '') === `${host}:`) { indent = line.length - line.trimStart().length; continue; }
    if (indent < 0 || !line.trim()) continue;
    if (line.length - line.trimStart().length <= indent) break;
    const value = line.trim().match(/^user:\s*(.*)$/)?.[1];
    if (value !== undefined) return value.replace(/^['"]|['"]$/g, '').slice(0, 300);
  }
  return '';
}
export interface ConnectionStoreOptions { directory?: string; home?: string; command?: LocalCommand }
export class ConnectionStore {
  private directory: string;
  private home: string;
  private command: LocalCommand;
  private tail: Promise<unknown> = Promise.resolve();
  private meegleRefresh?: Promise<Awaited<ReturnType<typeof readMeegleCredentials>>>;
  constructor(options: ConnectionStoreOptions = {}) {
    this.directory = options.directory ?? fileURLToPath(new URL('../../data/credentials/', import.meta.url));
    this.home = options.home ?? homedir(); this.command = options.command ?? localCommand;
  }
  async readBundle(): Promise<ConnectionBundle | null> {
    let input: string;
    try { input = await readFile(join(this.directory, '.env'), 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new HttpError(500, '无法读取凭据存储');
      try { await readFile(join(this.directory, 'store.enc')); }
      catch (legacyError) {
        if ((legacyError as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw new HttpError(500, '无法读取旧凭据存储');
      }
      throw new HttpError(500, '请在宿主机运行 pnpm credentials:migrate，将旧凭据迁移至 .env');
    }
    try {
      const json = parseEnv(input).SWARM_HIVE_CONNECTIONS_JSON;
      if (!json) throw Error('format');
      const bundle = JSON.parse(json);
      if (!bundle || typeof bundle.importedAt !== 'string' || !Array.isArray(bundle.connections)
        || ['glabConfig', 'gitCredentials', 'gitConfig'].some(key => typeof bundle[key] !== 'string')) throw Error('format');
      return bundle;
    } catch { throw new HttpError(500, '凭据 .env 格式无效'); }
  }
  async list(): Promise<ConnectionInventory> {
    await this.tail;
    const bundle = await this.readBundle();
    let verification: ConnectionInventory['verification'];
    try {
      const report = JSON.parse(await readFile(join(this.directory, 'verification.json'), 'utf8'));
      if (bundle && report.importedAt === bundle.importedAt) verification = report.verification;
    } catch { /* A verification report is optional and never blocks credential use. */ }
    return { configured: Boolean(bundle), importedAt: bundle?.importedAt ?? null, scope: 'all-projects', connections: bundle?.connections ?? [], ...(verification ? { verification } : {}) };
  }
  async readRuntimeBundle(): Promise<ConnectionBundle | null> {
    await this.tail;
    let bundle = await this.readBundle();
    if (!bundle) return null;
    if (bundle.connections.some(item => item.type === 'kubernetes') && bundle.kubernetesPolicy !== KUBERNETES_CREDENTIAL_POLICY) {
      throw new Error('请导入专用 Kubernetes 长期凭据');
    }
    if (!bundle.connections.some(item => item.type === 'meegle')) return bundle;
    if (!this.meegleRefresh) {
      this.meegleRefresh = readMeegleCredentials({ home: this.home, command: this.command }).finally(() => { this.meegleRefresh = undefined; });
    }
    const current = await this.meegleRefresh;
    if (!current) throw new Error('本机 Meegle 登录配置已移除，请重新同步凭据');
    const expected = bundle.connections.find(item => item.type === 'meegle');
    if (current.metadata.host !== expected?.host || current.metadata.profile !== expected?.username) throw new Error('本机 Meegle 身份已切换，请重新同步凭据');
    return { ...bundle, cliFiles: { ...bundle.cliFiles, 'meegle/config.json': Buffer.from(current.configText).toString('base64') } };
  }
  sandboxRuntimeDirectory() { return join(this.directory, 'sandbox-runtime'); }
  async recordVerification(importedAt: string, results: Array<{ id: string; status: 'ok' | 'auth' | 'network' | 'mysql-handshake' | 'failed' }>) {
    const operation = this.tail.then(async () => {
      const bundle = await this.readBundle();
      if (!bundle || bundle.importedAt !== importedAt) return;
      const messages = { ok: '沙箱连接检查通过', auth: '认证失败', network: '网络或 DNS 连接失败', 'mysql-handshake': '服务器在 MySQL 握手阶段断开连接，尚未验证账号', failed: '连接检查未通过' };
      const verification = { checkedAt: new Date().toISOString(), results: results.filter(result => bundle.connections.some(connection => connection.id === result.id)).map(result => ({ id: result.id, ok: result.status === 'ok', message: messages[result.status] })) };
      const path = join(this.directory, `verification-${randomUUID()}.tmp`);
      await writeFile(path, JSON.stringify({ importedAt, verification }), { mode: 0o600, flag: 'wx' });
      await rename(path, join(this.directory, 'verification.json'));
    });
    this.tail = operation.catch(() => {}); await operation;
  }
  importLocal(): Promise<ConnectionInventory> {
    const operation = this.tail.then(async () => {
      const connections: ConnectionInventory['connections'] = [];
      const kubernetes = await importKubernetesCredentials(this.home);
      if (kubernetes) connections.push(...kubernetes.connections);
      const lark = await importLarkCredentials(this.home);
      if (lark) connections.push(...lark.connections);
      const meegle = await readMeegleCredentials({ home: this.home, command: this.command });
      if (meegle) connections.push({ id: `meegle:${meegle.metadata.host}`, type: 'meegle', name: '飞书项目', host: meegle.metadata.host, username: meegle.metadata.profile, note: '使用本机已登录身份。每轮任务准备当前访问令牌，刷新凭据保留在宿主机。' });
      const optional = async (command: string, args: string[], input?: string) => this.command(command, args, input).catch(() => '');
      let mysqlLogin: string | undefined;
      try {
        mysqlLogin = (await readFile(join(this.home, '.mylogin.cnf'))).toString('base64');
        const masked = await this.command('mysql_config_editor', ['print', '--all']);
        connections.push(...mysqlProfiles(masked));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new HttpError(400, '无法读取 MySQL 命名连接，原有副本保持不变');
      }
      let yaml = '';
      try { yaml = await readFile(join(this.home, '.config/glab-cli/config.yml'), 'utf8'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new HttpError(400, '无法读取 glab 配置'); }
      const hosts: Record<string, object> = {};
      const gitHosts = new Set<string>();
      for (const host of glabHosts(yaml)) {
        const token = await optional('glab', ['config', 'get', 'token', '--host', host, '--global']);
        if (!token.trim()) continue;
        // Older glab releases read $USER even with --global; metadata must come
        // from the selected host entry, not the operating-system username.
        const username = glabUser(yaml, host);
        hosts[host] = { token: token.trim(), user: username.trim(), api_host: host, api_protocol: 'https', git_protocol: 'https' };
        gitHosts.add(host);
        connections.push({ id: `glab:${host}`, type: 'glab', name: host, host, ...(username ? { username } : {}) });
      }
      const helpers = await optional('git', ['config', '--global', '--get-regexp', '^credential\\..*\\.helper$']);
      for (const line of helpers.split('\n')) {
        const match = line.match(/^credential\.https:\/\/([^/\s]+)\.helper\s/);
        if (match && safeHost(match[1])) gitHosts.add(match[1]);
      }
      let gitCredentials = '', gitConfig = '';
      const name = await optional('git', ['config', '--global', '--get', 'user.name']);
      const email = await optional('git', ['config', '--global', '--get', 'user.email']);
      if (name || email) gitConfig += `[user]\n${name ? `\tname = ${setting(name)}\n` : ''}${email ? `\temail = ${setting(email)}\n` : ''}`;
      for (const host of gitHosts) {
        const output = await optional('git', ['credential', 'fill'], `protocol=https\nhost=${host}\n\n`);
        const values = Object.fromEntries(output.split('\n').map(line => { const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)]; }));
        if (!values.username || !values.password) continue;
        gitCredentials += `https://${encodeURIComponent(values.username)}:${encodeURIComponent(values.password)}@${host}\n`;
        gitConfig += `[credential "https://${host}"]\n\thelper =\n\thelper = store --file=${CONNECTION_ROOT}/current/git-credentials\n`;
        connections.push({ id: `git:${host}`, type: 'git', name: host, host, username: values.username });
      }
      if (!connections.length) throw new HttpError(400, '本机没有可导入的服务凭据');
      const bundle: ConnectionBundle = { importedAt: new Date().toISOString(), connections, mysqlLogin,
        glabConfig: JSON.stringify({ git_protocol: 'https', hosts }, null, 2), gitCredentials, gitConfig,
        ...(kubernetes ? { kubernetesPolicy: kubernetes.policy } : {}),
        cliFiles: { ...kubernetes?.files, ...lark?.files, ...(meegle ? { 'meegle/config.json': Buffer.from(meegle.configText).toString('base64') } : {}) } };
      this.meegleRefresh = undefined;
      await writeConnectionBundle(this.directory, bundle);
      return { configured: true, importedAt: bundle.importedAt, scope: 'all-projects' as const, connections };
    });
    this.tail = operation.catch(() => {}); return operation;
  }
}

export async function writeConnectionBundle(directory: string, bundle: ConnectionBundle) {
  await mkdir(directory, { recursive: true, mode: 0o700 }); await chmod(directory, 0o700);
  // JSON escapes newlines; escape apostrophes so dotenv single quotes are lossless.
  const json = JSON.stringify(bundle).replaceAll("'", '\\u0027');
  const temp = join(directory, `store-${randomUUID()}.tmp`);
  await writeFile(temp, `SWARM_HIVE_CONNECTIONS_JSON='${json}'\n`, { mode: 0o600, flag: 'wx' });
  await rename(temp, join(directory, '.env'));
}
