import { createCipheriv, randomBytes } from 'node:crypto';
import { HttpError } from '../../util/errors.js';

/** MySQL's native .mylogin.cnf wire format (obfuscation, not a security boundary).
 * https://dev.mysql.com/doc/refman/8.4/en/mysql-config-editor.html
 * CoCell separately encrypts stored sources and restricts the mounted HOME.
 */
export function encodeMysqlLogin(content: string): Buffer {
  const storedKey = randomBytes(20), aesKey = Buffer.alloc(16);
  for (let index = 0; index < storedKey.length; index++) aesKey[index % 16] ^= storedKey[index];
  const records = [Buffer.alloc(4), storedKey];
  try {
    for (const line of content.split('\n').slice(0, -1)) {
      const bytes = Buffer.from(line + '\n');
      if (bytes.length > 4000) throw new HttpError(400, 'MySQL login-path 单行选项不能超过 4000 字节');
      const cipher = createCipheriv('aes-128-ecb', aesKey, null);
      const encrypted = Buffer.concat([cipher.update(bytes), cipher.final()]);
      const length = Buffer.alloc(4); length.writeUInt32LE(encrypted.length);
      records.push(length, encrypted);
    }
    return Buffer.concat(records);
  } finally { aesKey.fill(0); }
}
