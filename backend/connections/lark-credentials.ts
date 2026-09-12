import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ConnectionInventory } from '../../protocol/connection-types.js';

/** Only app credentials are portable here. User refresh tokens stay on the host. */
export async function importLarkCredentials(home: string) {
  let config;
  try { config = JSON.parse(await readFile(join(home, '.lark-cli/config.json'), 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw new Error('无法读取飞书应用配置'); }
  const files: Record<string, string> = {};
  const connections: ConnectionInventory['connections'] = [];
  const apps = [];
  for (const app of config.apps ?? []) {
    if (!/^cli_[a-zA-Z0-9]+$/.test(app.appId) || !app.appSecret) continue;
    // This Linux CLI stores application secrets using a private AES master key.
    // Copy only those two file classes, never logs, caches or user token stores.
    const name = `appsecret_${app.appId}.enc`;
    files[`lark-data/lark-cli/${name}`] = (await readFile(join(home, '.local/share/lark-cli', name))).toString('base64');
    apps.push({ appId: app.appId, appSecret: app.appSecret, brand: app.brand, lang: app.lang });
    connections.push({ id: `lark:${app.appId}`, type: 'lark', name: '飞书应用', host: app.brand === 'lark' ? 'open.larksuite.com' : 'open.feishu.cn', username: app.appId, note: '应用身份：可操作已授权给应用的文档和评论。用户身份尚未接入。' });
  }
  if (!apps.length) return undefined;
  files['lark-data/lark-cli/master.key'] = (await readFile(join(home, '.local/share/lark-cli/master.key'))).toString('base64');
  files['lark-config/config.json'] = Buffer.from(JSON.stringify({ apps })).toString('base64');
  return { files, connections };
}
