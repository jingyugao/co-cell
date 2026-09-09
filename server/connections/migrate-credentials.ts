import { createDecipheriv } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConnectionStore, writeConnectionBundle } from './store.js';

// Only this one-time migration reads the old encryption key.
const directory = fileURLToPath(new URL('../../data/credentials/', import.meta.url));
try {
  let exists = true;
  try { await access(join(directory, '.env')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; exists = false; }
  if (exists) {
    await new ConnectionStore({ directory }).readBundle();
    console.log('凭据 .env 已存在，未覆盖。');
  } else {
    const input = await readFile(join(directory, 'store.enc'));
    const key = await readFile(join(homedir(), '.config/swarm-hive/credentials.key'));
    if (input.subarray(0, 4).toString() !== 'SWC1' || key.length !== 32) throw Error('format');
    const decipher = createDecipheriv('aes-256-gcm', key, input.subarray(4, 16));
    decipher.setAAD(Buffer.from('swarm-hive-connections-v1'));
    decipher.setAuthTag(input.subarray(16, 32));
    const bundle = JSON.parse(Buffer.concat([decipher.update(input.subarray(32)), decipher.final()]).toString());
    await writeConnectionBundle(directory, bundle);
    await new ConnectionStore({ directory }).readBundle();
    console.log('凭据已迁移至 data/credentials/.env（0600）；旧文件保留，运行服务不再需要密钥。');
  }
} catch {
  console.error('凭据迁移失败，请检查旧存储、宿主密钥及目录权限。');
  process.exitCode = 1;
}
