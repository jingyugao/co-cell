import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { createDecipheriv, pbkdf2 } from 'node:crypto';
import { homedir, hostname as machineHostname } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const deriveKey = promisify(pbkdf2);
const failure = () => new Error('无法导出 Meegle 访问凭据，请检查本机登录状态及凭据存储');
export interface MeegleCredentialOptions {
  home?: string;
  command: (command: string, args: string[]) => Promise<string>;
  hostname?: string;
  username?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}
export interface MeegleCredentials {
  /** Private: persist in the credential store or send through a sandbox file API only. */
  configText: string;
  metadata: { profile: string; host: string; authenticated: true; expiresAt?: string };
}
async function readPrivate(path: string): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 1024 * 1024) throw failure();
    return await file.readFile('utf8');
  } finally { await file.close(); }
}
function hostName(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 253) throw failure();
  const url = new URL(value.includes('://') ? value : `https://${value}`);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash || !/^[a-zA-Z0-9][a-zA-Z0-9.-]*(?::\d+)?$/.test(url.host)) throw failure();
  return url.host;
}
function hex(value: unknown, bytes?: number): Buffer {
  if (typeof value !== 'string' || !/^(?:[a-fA-F0-9]{2})+$/.test(value) || (bytes !== undefined && value.length !== bytes * 2)) throw failure();
  return Buffer.from(value, 'hex');
}
function expanded(value: unknown, env: NodeJS.ProcessEnv): string {
  if (value === undefined || value === '') return '';
  if (typeof value !== 'string') throw failure();
  const variable = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(value)?.[1];
  if (!variable) return value;
  if (!env[variable]) throw failure();
  return env[variable]!;
}

/**
 * Refresh only on the host, then export only its access token. Meegle 1.0.20 has
 * no auth-export command. Its public FileStore format is PBKDF2-SHA256 followed
 * by AES-256-GCM, bound to hostname + USER + .machine-key:
 * https://github.com/larksuite/meegle-cli/blob/v1.0.20/internal/products/meegle/auth/file_store.go
 * Never copy credentials.enc, refresh_token, client_id or .machine-key to a VM.
 */
export async function readMeegleCredentials(options: MeegleCredentialOptions): Promise<MeegleCredentials | null> {
  const root = join(options.home ?? homedir(), '.meegle');
  let configText: string;
  try { configText = await readPrivate(join(root, 'config.json')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw failure(); }
  try {
    const config = JSON.parse(configText);
    const profile = config.current || 'default';
    if (typeof profile !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(profile)) throw failure();
    const source = config.profiles?.[profile];
    if (!source || typeof source !== 'object') throw failure();
    const env = options.env ?? process.env;
    const host = hostName(env.MEEGLE_HOST || expanded(source.host, env));
    // Official auth status resolves expiration, refreshes under the CLI's file
    // lock and validates the token server-side. Read the credential file AFTER it.
    const status = JSON.parse(await options.command('meegle', ['--profile', profile, 'auth', 'status', '--format', 'json']));
    if (status.authenticated !== true) {
      throw new MeegleAuthenticationError('Meegle 登录已失效，请重新登录；使用 OAuth 自动刷新时请移除 MEEGLE_USER_ACCESS_TOKEN 和配置中的 user_access_token');
    }
    if (hostName(status.host) !== host) throw failure();
    let accessToken = env.MEEGLE_USER_ACCESS_TOKEN || expanded(source.user_access_token, env);
    let expiresAt: string | undefined;
    if (!accessToken) {
      const encryptedName = profile === 'default' ? 'credentials.enc' : `credentials-${profile}.enc`;
      const encrypted = JSON.parse(await readPrivate(join(root, encryptedName)));
      const machineKey = await readPrivate(join(root, '.machine-key'));
      if (!/^[a-fA-F0-9]{64}$/.test(machineKey)) throw failure();
      const material = `${options.hostname ?? machineHostname()}:${options.username ?? (env.USER || 'unknown')}:${machineKey}:meegle-cli`;
      const key = await deriveKey(material, hex(encrypted.salt, 16), 100_000, 32, 'sha256');
      const decipher = createDecipheriv('aes-256-gcm', key, hex(encrypted.iv, 12));
      decipher.setAuthTag(hex(encrypted.tag, 16));
      const plaintext = Buffer.concat([decipher.update(hex(encrypted.data)), decipher.final()]);
      let data: { access_token?: unknown; expires_at?: unknown };
      try { data = JSON.parse(plaintext.toString('utf8')); } finally { plaintext.fill(0); key.fill(0); }
      if (typeof data.access_token !== 'string') throw failure();
      accessToken = data.access_token;
      if (data.expires_at !== undefined && data.expires_at !== 0) {
        if (typeof data.expires_at !== 'number' || !Number.isSafeInteger(data.expires_at) || data.expires_at <= (options.now ?? Date.now)()) throw failure();
        expiresAt = new Date(data.expires_at).toISOString();
      }
    }
    if (!accessToken || accessToken.length > 64 * 1024 || /[\r\n\0]/.test(accessToken)) throw failure();
    const accessTokenHeader = env.MEEGLE_ACCESS_TOKEN_HEADER || expanded(source.access_token_header, env);
    if (accessTokenHeader && !/^[!#$%&'*+.^_`|~a-zA-Z0-9-]+$/.test(accessTokenHeader)) throw failure();
    const exported = { host, user_access_token: accessToken, ...(accessTokenHeader ? { access_token_header: accessTokenHeader } : {}) };
    return {
      configText: JSON.stringify({ current: profile, profiles: { [profile]: exported } }, null, 2),
      metadata: { profile, host, authenticated: true, ...(expiresAt ? { expiresAt } : {}) },
    };
  } catch (error) { if (error instanceof MeegleAuthenticationError) throw error; throw failure(); }
}

class MeegleAuthenticationError extends Error {}
