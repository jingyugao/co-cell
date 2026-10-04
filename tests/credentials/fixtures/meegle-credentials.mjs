import { createCipheriv, pbkdf2Sync, randomBytes } from 'node:crypto';

export function meegleFixture(identity = { hostname: 'source-host', username: 'source-user' }, data = { access_token: 'access-original', refresh_token: 'refresh-original', client_id: 'client-original', expires_at: 1000 }) {
  const machineKey = randomBytes(32).toString('hex'), salt = randomBytes(16), iv = randomBytes(12);
  const key = pbkdf2Sync(`${identity.hostname}:${identity.username}:${machineKey}:meegle-cli`, salt, 100000, 32, 'sha256');
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(data)), cipher.final()]); key.fill(0);
  return { adapter: 'meegle', identity, files: [
    { path: '.meegle/config.json', content: JSON.stringify({ current: 'default', profiles: { default: { host: 'project.example.test' } } }) },
    { path: '.meegle/.machine-key', content: machineKey },
    { path: '.meegle/credentials.enc', content: JSON.stringify({ salt: salt.toString('hex'), iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex'), data: encrypted.toString('hex') }) },
  ] };
}
