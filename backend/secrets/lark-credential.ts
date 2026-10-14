import type { SecretSupportFile } from '../../protocol/secret-types.js';
import { HttpError } from '../../util/errors.js';

export interface LarkCredential { content: string; supportFiles: SecretSupportFile[]; supportVersion: number }
const invalid = () => new HttpError(400, 'Lark 用户凭证需要一个应用、一个用户及其完整的原生密钥和令牌文件');
const safeIdentity = /^[A-Za-z0-9_-]{1,100}$/;

/** Only native Linux Lark keychain files for the selected app/user may accompany its config. */
export function larkCredential(tool: string, path: string, content: string, supportFiles: SecretSupportFile[], supportVersion = 1): LarkCredential {
  if (!Number.isSafeInteger(supportVersion) || supportVersion < 1) throw invalid();
  if (tool !== 'lark-cli' || path !== '.lark-cli/config.json') throw invalid();
  let config;
  try { config = JSON.parse(content); } catch { throw invalid(); }
  if (!Array.isArray(config?.apps) || config.apps.length !== 1) throw invalid();
  const app = config.apps[0];
  if (!safeIdentity.test(app?.appId ?? '') || app.defaultAs !== 'user' || !Array.isArray(app.users) || app.users.length !== 1 ||
      !safeIdentity.test(app.users[0]?.userOpenId ?? '')) throw invalid();
  if (config.currentApp && config.currentApp !== app.appId && config.currentApp !== app.name) throw invalid();
  const root = '.local/share/lark-cli/';
  const required = new Map<string, number>([[`${root}master.key`, 32], [`${root}${app.appId}_${app.users[0].userOpenId}.enc`, 29]]);
  if (typeof app.appSecret === 'object' && app.appSecret?.source === 'keychain' && app.appSecret.id === `appsecret:${app.appId}`) {
    required.set(`${root}appsecret_${app.appId}.enc`, 29);
  } else if (typeof app.appSecret !== 'string' || !app.appSecret) throw invalid();
  if (!Array.isArray(supportFiles) || supportFiles.length !== required.size) throw invalid();
  let bytes = Buffer.byteLength(content);
  const seen = new Set<string>();
  for (const file of supportFiles) {
    if (!required.has(file.path) || seen.has(file.path) || file.encoding !== 'base64' || typeof file.content !== 'string') throw invalid();
    const value = Buffer.from(file.content, 'base64');
    if (value.toString('base64') !== file.content || value.length < required.get(file.path)! ||
        (file.path === `${root}master.key` && value.length !== 32)) throw invalid();
    bytes += value.length; seen.add(file.path);
  }
  if (bytes > 65536) throw new HttpError(400, 'Lark 凭证最多 64 KiB');
  return { content, supportVersion, supportFiles: supportFiles.map(file => ({ ...file })) };
}
