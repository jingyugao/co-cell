import type { ToolPermission } from '../../../protocol/secret-types.js';
import { HttpError } from '../../../util/errors.js';
import type { Tool } from '../interfaces.js';

export class BasicTool implements Tool {
  readonly kind: Tool['kind'] = 'tool';
  constructor(readonly name: string) {}
  authorize(permission: ToolPermission | undefined) {
    if (permission?.tool !== this.name || permission.enabled !== true ||
      (this.kind === 'tool-with-credential' && (!Array.isArray(permission.credentials) || !permission.credentials.length)))
      throw new HttpError(403, '项目未授权此工具');
  }
  validateArgs(args: readonly string[]) { return [...args]; }
}

/** A missing/empty/repeated selector is an error, never an absent credential. */
export function credentialOption(args: readonly string[], option: string): string | undefined {
  let selected: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg !== option && !arg.startsWith(option + '=')) continue;
    const value = arg === option ? args[++i] : arg.slice(option.length + 1);
    if (selected !== undefined || !value || value.startsWith('-') || /[\u0000-\u001f\u007f\[\]]/.test(value))
      throw new HttpError(400, `${option} 凭据名称缺失、重复或无效`);
    selected = value;
  }
  return selected;
}
