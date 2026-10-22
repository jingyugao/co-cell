import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const MAX_BYTES = 1024 * 1024;
const MAX_LINE_BYTES = 4000;

function deriveKey(storedKey) {
  if (!Buffer.isBuffer(storedKey) || storedKey.length !== 20) throw new Error('invalid mysql login file');
  const key = Buffer.alloc(16);
  for (let index = 0; index < storedKey.length; index++) key[index % key.length] ^= storedKey[index];
  return key;
}

/** Encode MySQL's native .mylogin.cnf format. It is obfuscation, not encryption. */
export function encodeMysqlLogin(content) {
  if (typeof content !== 'string' || Buffer.byteLength(content) > MAX_BYTES) throw new Error('invalid mysql login content');
  const storedKey = randomBytes(20);
  const aesKey = deriveKey(storedKey);
  const records = [Buffer.alloc(4), storedKey];
  try {
    const normalized = content === '' || content.endsWith('\n') ? content : `${content}\n`;
    for (const line of normalized.split('\n').slice(0, -1)) {
      const bytes = Buffer.from(`${line}\n`);
      if (bytes.length > MAX_LINE_BYTES) throw new Error('mysql login option line is too long');
      const cipher = createCipheriv('aes-128-ecb', aesKey, null);
      const encrypted = Buffer.concat([cipher.update(bytes), cipher.final()]);
      const length = Buffer.alloc(4);
      length.writeUInt32LE(encrypted.length);
      records.push(length, encrypted);
    }
    const encoded = Buffer.concat(records);
    if (encoded.length > MAX_BYTES) throw new Error('mysql login file is too large');
    return encoded;
  } finally {
    aesKey.fill(0);
  }
}

/** Decode MySQL's native .mylogin.cnf format into its INI text. */
export function decodeMysqlLogin(binary) {
  const bytes = Buffer.isBuffer(binary) ? binary : Buffer.from(binary);
  if (bytes.length < 24 || bytes.length > MAX_BYTES || bytes.readUInt32LE(0) !== 0) throw new Error('invalid mysql login file');
  const storedKey = bytes.subarray(4, 24);
  const aesKey = deriveKey(storedKey);
  const lines = [];
  try {
    let offset = 24;
    while (offset < bytes.length) {
      if (offset + 4 > bytes.length) throw new Error('invalid mysql login file');
      const length = bytes.readUInt32LE(offset);
      offset += 4;
      if (length < 16 || length % 16 !== 0 || offset + length > bytes.length) throw new Error('invalid mysql login file');
      const decipher = createDecipheriv('aes-128-ecb', aesKey, null);
      const plain = Buffer.concat([decipher.update(bytes.subarray(offset, offset + length)), decipher.final()]);
      offset += length;
      if (!plain.length || plain.at(-1) !== 10 || plain.includes(0) || plain.length > MAX_LINE_BYTES) throw new Error('invalid mysql login file');
      // MySQL stores each option as one newline-terminated UTF-8 line.
      const line = new TextDecoder('utf-8', { fatal: true }).decode(plain);
      lines.push(line);
    }
    const result = lines.join('');
    if (Buffer.byteLength(result) > MAX_BYTES) throw new Error('mysql login file is too large');
    return result;
  } catch {
    throw new Error('invalid mysql login file');
  } finally {
    aesKey.fill(0);
  }
}
