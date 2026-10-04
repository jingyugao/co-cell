import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from 'node:crypto';
import { join, posix } from 'node:path';
import { lstat, readdir } from 'node:fs/promises';

export const FILE_BUNDLE_LIMIT = 512 * 1024;
function safePath(p) {
  return typeof p === 'string' && !!p && p.length <= 256 && !p.startsWith('/') && posix.normalize(p) === p &&
    !/[\\\u0000-\u001f\u007f]/.test(p) && p.split('/').every(part => part && part !== '.' && part !== '..');
}
export function fileBytes(file) {
  if (typeof file.content !== 'string' || (file.encoding !== undefined && file.encoding !== 'base64'))
    throw new Error('文件编码无效');
  const bytes = Buffer.from(file.content, file.encoding ?? 'utf8');
  if (bytes.toString(file.encoding ?? 'utf8') !== file.content) throw new Error('文件内容或编码无效');
  return bytes;
}
export function encodeFile(path, bytes, encoding) {
  const text = bytes.toString('utf8');
  return encoding === 'base64' || !Buffer.from(text).equals(bytes)
    ? { path, content: bytes.toString('base64'), encoding: 'base64' }
    : { path, content: text };
}
/** Snapshot only the selected directory; reject links and special files. */
export async function collectCredentialDirectory(root, directory, primaryPath, readCredential, previous = []) {
  if (!safePath(directory)) throw new Error('凭证目录路径无效');
  let parent = root;
  for (const part of directory.split('/')) {
    parent = join(parent, part);
    const info = await lstat(parent);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('凭证目录不能使用符号链接');
  }
  const files = [], encodings = new Map(previous.map(file => [file.path, file.encoding]));
  let directories = 0, bytes = 0;
  async function walk(path) {
    if (++directories > 256) throw new Error('凭证目录过大');
    for (const entry of await readdir(join(root, path), { withFileTypes: true })) {
      const child = `${path}/${entry.name}`;
      if (!safePath(child)) throw new Error('凭证文件路径无效');
      if (entry.isDirectory()) {
        const info = await lstat(join(root, child));
        if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('凭证目录不能使用符号链接');
        await walk(child);
      } else if (entry.isFile()) {
        if (files.length >= 128) throw new Error('凭证目录最多包含 128 份文件');
        const data = await readCredential(root, child, FILE_BUNDLE_LIMIT, true);
        bytes += data.length;
        if (bytes > FILE_BUNDLE_LIMIT) throw new Error('凭证目录过大');
        files.push(encodeFile(child, data, encodings.get(child)));
      } else throw new Error('凭证目录不能包含符号链接或特殊文件');
    }
  }
  await walk(directory);
  files.sort((a, b) => a.path.localeCompare(b.path));
  const index = files.findIndex(file => file.path === primaryPath);
  if (index < 0) throw new Error('凭证目录缺少主配置文件');
  files.unshift(...files.splice(index, 1));
  return files;
}
export function validateFileBundle(value) {
  if (!value || !Array.isArray(value.files) || !value.files.length || value.files.length > 128)
    throw new Error('文件组必须包含 1..128 份文件');
  if (value.directory !== undefined && !safePath(value.directory)) throw new Error('凭证目录路径无效');
  const paths = [];
  for (const file of value.files) {
    const p = file.path;
    if (!safePath(p))
      throw new Error('文件路径必须相对于工具 HOME，不能包含路径跳转');
    if (value.directory && !p.startsWith(value.directory + '/')) throw new Error('文件必须位于选定凭证目录内');
    if (paths.some(previous => previous === p || previous.startsWith(p + '/') || p.startsWith(previous + '/')))
      throw new Error('文件路径不能重复或与目录冲突');
    fileBytes(file);
    paths.push(p);
  }
  if (value.adapter !== undefined && value.adapter !== 'meegle') throw new Error('不支持的文件适配方式');
  const bundle = { files: value.files.map(({ path, content, encoding }) => ({ path, content, ...(encoding ? { encoding } : {}) })),
    ...(value.directory ? { directory: value.directory } : {}),
    ...(value.adapter ? { adapter: value.adapter, identity: validateIdentity(value.identity) } : {}) };
  if (!value.adapter && value.identity !== undefined) throw new Error('加密身份仅用于 Meegle 文件');
  if (Buffer.byteLength(JSON.stringify(bundle)) > FILE_BUNDLE_LIMIT) throw new Error('文件组总大小不能超过 512 KiB');
  if (bundle.adapter === 'meegle') meegleMaterial(bundle);
  return bundle;
}
function validateIdentity(identity) {
  if (!identity || ['hostname', 'username'].some(key => typeof identity[key] !== 'string' ||
      !identity[key].length || identity[key].length > 253 || /[\u0000-\u001f\u007f]/.test(identity[key])))
    throw new Error('请填写 Meegle 加密时的 hostname 和 USER');
  return { hostname: identity.hostname, username: identity.username };
}
function hex(value, length) {
  if (typeof value !== 'string' || !/^(?:[a-fA-F0-9]{2})+$/.test(value) || (length && value.length !== length * 2))
    throw new Error('Meegle 加密文件格式无效');
  return Buffer.from(value, 'hex');
}
function meegleMaterial(bundle) {
  try {
    const byPath = new Map(bundle.files.map(file => [file.path, file.content]));
    const config = JSON.parse(byPath.get('.meegle/config.json'));
    const profile = config.current || 'default';
    if (typeof profile !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(profile) || !config.profiles?.[profile] ||
        config.profiles[profile].user_access_token) throw new Error();
    const credentialPath = `.meegle/${profile === 'default' ? 'credentials.enc' : `credentials-${profile}.enc`}`;
    if (!byPath.has(credentialPath) || bundle.files.some(file => ['.meegle/config.json', '.meegle/.machine-key', credentialPath].includes(file.path) && file.encoding)) throw new Error();
    const machineKey = byPath.get('.meegle/.machine-key');
    hex(machineKey, 32);
    const encrypted = JSON.parse(byPath.get(credentialPath));
    hex(encrypted.salt, 16); hex(encrypted.iv, 12); hex(encrypted.tag, 16); hex(encrypted.data);
    return { machineKey, encrypted, credentialPath };
  } catch { throw new Error('Meegle 文件组需要 config.json、.machine-key 和当前 profile 的 credentials.enc；请移除固定 user_access_token'); }
}
function derive(identity, machineKey, salt) {
  return pbkdf2Sync(`${identity.hostname}:${identity.username}:${machineKey}:meegle-cli`, salt, 100000, 32, 'sha256');
}
/** The plaintext exists in memory only; native files remain encrypted. */
export function openMeegleBundle(input) {
  const bundle = validateFileBundle(input), { encrypted, machineKey } = meegleMaterial(bundle);
  const key = derive(bundle.identity, machineKey, hex(encrypted.salt, 16));
  let plaintext;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, hex(encrypted.iv, 12));
    decipher.setAuthTag(hex(encrypted.tag, 16));
    plaintext = Buffer.concat([decipher.update(hex(encrypted.data)), decipher.final()]);
    const data = JSON.parse(plaintext.toString('utf8'));
    if (!data.access_token || typeof data.access_token !== 'string') throw new Error();
    return data;
  } catch { throw new Error('无法解密 Meegle 凭证，请检查来源 hostname、USER 和机器密钥'); }
  finally { key.fill(0); plaintext?.fill(0); }
}
export function rebindMeegleBundle(input, targetIdentity) {
  const bundle = validateFileBundle(input), identity = validateIdentity(targetIdentity);
  const data = openMeegleBundle(bundle);
  if (bundle.identity.hostname === identity.hostname && bundle.identity.username === identity.username) return bundle;
  const machineKey = randomBytes(32).toString('hex'), salt = randomBytes(16), iv = randomBytes(12);
  const key = derive(identity, machineKey, salt), plaintext = Buffer.from(JSON.stringify(data));
  try {
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const content = JSON.stringify({ salt: salt.toString('hex'), iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex'), data: encrypted.toString('hex') });
    const { credentialPath } = meegleMaterial(bundle);
    return validateFileBundle({ ...bundle, identity, files: bundle.files.map(file => ({ ...file,
      content: file.path === '.meegle/.machine-key' ? machineKey : file.path === credentialPath ? content : file.content })) });
  } finally { key.fill(0); plaintext.fill(0); }
}
