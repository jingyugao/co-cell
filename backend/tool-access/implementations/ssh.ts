import { HttpError } from '../../../util/errors.js';
import type { CredentialCatalog, CredentialSource, ToolWithCredential } from '../interfaces.js';
import { BasicTool } from './tool.js';

const alias = /^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$/;

/** Only literal Host aliases are selectable credentials; patterns remain native defaults. */
export function sshHosts(content: string): string[] {
  const names = new Set<string>();
  for (const line of content.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const host = /^\s*Host(?:\s*=\s*|\s+)(.*)$/i.exec(line);
    if (!host) continue;
    for (const token of host[1].matchAll(/"([^"]*)"|'([^']*)'|([^\s#]+)|(#.*$)/g)) {
      if (token[4]) break;
      const name = token[1] ?? token[2] ?? token[3];
      if (alias.test(name)) names.add(name);
    }
  }
  return [...names];
}

export class SshTool extends BasicTool implements ToolWithCredential {
  readonly kind = 'tool-with-credential' as const;
  readonly configPath = '.ssh/config';
  constructor() { super('ssh'); }
  listCredentials(sources: readonly CredentialSource[], mountedConfig?: Buffer): CredentialCatalog {
    if (mountedConfig) return { names: sshHosts(mountedConfig.toString('utf8')) };
    const names: string[] = [];
    for (const source of sources) for (const name of sshHosts(source.content)) {
      if (names.includes(name)) throw new HttpError(400, `SSH Host 别名重复：${name}`);
      names.push(name);
    }
    return { names };
  }
  resolveCredential(args: readonly string[]) {
    if (args.length === 1 && args[0] === '-V') return undefined;
    let index = 0;
    // Connection settings belong to the operator's config. In particular -o,
    // -F, -i, -l, -p and forwarding options must not override an authorized alias.
    while (index < args.length && /^-(?:v{1,3}|q|T|n|G)$/.test(args[index])) index++;
    if (args[index] === '--') index++;
    const name = args[index];
    if (!name || !alias.test(name)) throw new HttpError(400, '请用 ssh <Host别名> [远程命令] 选择凭据；连接选项请在 .ssh/config 中配置');
    return name;
  }
  override validateArgs(args: readonly string[]) {
    const name = this.resolveCredential(args);
    if (name === undefined) return [...args];
    const index = args.indexOf(name);
    // OpenSSH also accepts options AFTER the destination unless -- precedes it.
    // Keep every remote-command argument outside its local option parser.
    return [...args.slice(0, index).filter(arg => arg !== '--'), '--', ...args.slice(index)];
  }
}
