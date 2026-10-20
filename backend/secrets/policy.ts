import { posix } from 'node:path';
import { getTool } from '../tool-access/index.js';
import type { ProxyTool } from '../../protocol/secret-types.js';
import { HttpError } from '../../util/errors.js';
import { TOOL_NAME_PATTERN } from '../../util/tool-secrets.js';

export function toolName(value: string) {
  if (!TOOL_NAME_PATTERN.test(value)) throw new HttpError(400, '工具名必须以字母开头，且只包含字母、数字、点、下划线或连字符');
  return value;
}
export function credentialPath(path: string) {
  if (!path || path.length > 256 || path.startsWith('/') || posix.normalize(path) !== path ||
      /[\\\u0000-\u001f\u007f]/.test(path) || path.split('/').some(part => !part || part === '.' || part === '..'))
    throw new HttpError(400, '认证文件路径必须相对于工具 HOME，不能包含路径跳转');
  return path;
}
export function validateToolArgs(tool: ProxyTool, args: string[]): string[] {
  toolName(tool);
  if (args.length > 32 || args.some(arg => arg.includes('\0')) || args.reduce((n, arg) => n + Buffer.byteLength(arg), 0) > 8192)
    throw new HttpError(400, '工具参数超出限制');
  return getTool(tool).validateArgs(args);
}
