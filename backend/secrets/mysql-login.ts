import { HttpError } from '../../util/errors.js';
import { decodeMysqlLogin as decodeBinary, encodeMysqlLogin as encodeBinary } from '../../util/mysql-login-codec.mjs';

/** MySQL's native .mylogin.cnf wire format (obfuscation, not a security boundary).
 * https://dev.mysql.com/doc/refman/8.4/en/mysql-config-editor.html
 * CoCell restricts access to the native files in the mounted HOME.
 */
export function encodeMysqlLogin(content: string): Buffer {
  for (const line of content.split('\n').slice(0, -1))
    if (Buffer.byteLength(line + '\n') > 4000) throw new HttpError(400, 'MySQL login-path 单行选项不能超过 4000 字节');
  try { return encodeBinary(content); }
  catch { throw new HttpError(400, 'MySQL login-path 配置无效'); }
}

/** Decode MySQL's native .mylogin.cnf file without exposing malformed input. */
export function decodeMysqlLogin(content: Buffer | Uint8Array): string {
  try { return decodeBinary(content); }
  catch { throw new HttpError(400, 'MySQL login-path 配置格式无效'); }
}
