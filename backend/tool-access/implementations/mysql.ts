import { HttpError } from '../../../util/errors.js';
import type { CredentialCatalog, CredentialSource, ToolWithCredential } from '../interfaces.js';
import { BasicTool, credentialOption } from './tool.js';

const validName = (value: unknown): value is string => typeof value === 'string' && !!value && value.length <= 256 && !/[\u0000-\u001f\u007f\[\]]/.test(value);

/** Accept named login profiles and existing client_<name> option groups. */
export function mysqlProfiles(content: string, name: string): Map<string, string[]> {
  const groups = new Map<string, Map<string, string>>();
  let group: Map<string, string> | undefined;
  for (const original of content.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = original.trim();
    if (!line || /^[#;]/.test(line)) continue;
    const header = line.match(/^\[([^\]]+)\]$/);
    if (header) {
      if (!validName(header[1]) || groups.has(header[1])) throw new HttpError(400, 'MySQL 凭证需要唯一的原生 login-path 选项组');
      group = new Map(); groups.set(header[1], group); continue;
    }
    const option = line.match(/^([A-Za-z][A-Za-z0-9_-]*)(?:\s*=.*)?$/);
    if (!group || !option) throw new HttpError(400, 'MySQL 原生选项文件无效；不支持外部 include');
    const separator = line.indexOf('=');
    group.set(option[1].replaceAll('_', '-'), separator < 0 ? line : `${option[1]} = ${line.slice(separator + 1).trim()}`);
  }
  const common = new Map([...groups.get('client') ?? [], ...groups.get('mysql') ?? []]);
  const named = [...groups.keys()].filter(key => !['client', 'mysql'].includes(key));
  const names = [...new Set(named.map(key => /^(?:client|mysql)_(.+)$/.exec(key)?.[1] ?? key))];
  if (!names.length) names.push(name);
  const profiles = new Map<string, string[]>();
  for (const profile of names) {
    if (!validName(profile)) throw new HttpError(400, 'MySQL 原生连接名称无效');
    const options = new Map([...common, ...groups.get(`client_${profile}`) ?? [], ...groups.get(`mysql_${profile}`) ?? [], ...groups.get(profile) ?? []]);
    if (!options.size) throw new HttpError(400, 'MySQL 凭证缺少原生连接选项');
    profiles.set(profile, [...options.values()]);
  }
  return profiles;
}

export class MysqlTool extends BasicTool implements ToolWithCredential {
  readonly kind = 'tool-with-credential' as const;
  readonly configPath = '.mylogin.cnf';
  readonly credentialOption = '--login-path';
  constructor() { super('mysql'); }
  listCredentials(sources: readonly CredentialSource[]): CredentialCatalog {
    const names: string[] = [];
    for (const source of sources) for (const name of mysqlProfiles(source.content, source.name).keys()) {
      if (names.includes(name)) throw new HttpError(400, `MySQL 原生连接名称重复：${name}`);
      names.push(name);
    }
    return { names, ...(names.length === 1 ? { defaultName: names[0] } : {}) };
  }
  resolveCredential(args: readonly string[]) {
    const explicit = credentialOption(args, '--login-path');
    if (explicit !== undefined) return explicit;
    if (args.length && args.every(arg => ['--version', '-V', '--help', '-?'].includes(arg))) return undefined;
    throw new HttpError(400, '请用 MySQL 原生 --login-path=名称 选择凭据');
  }
  override validateArgs(args: readonly string[]) {
    const loginPath = credentialOption(args, '--login-path');
    const checked = [...args];
    for (let i = 0; i < checked.length; i++) {
      if (checked[i] === '--login-path') { checked.splice(i, 2); i--; }
      else if (checked[i].startsWith('--login-path=')) { checked.splice(i, 1); i--; }
    }
    const selector = loginPath === undefined ? [] : [`--login-path=${loginPath}`];
    if (checked.length === 1 && ['--version', '-V', '--help', '-?'].includes(checked[0]))
      return [...selector, ['--help', '-?'].includes(checked[0]) ? '--help' : '--version'];
    if (checked.length !== 2 || !['-e', '--execute'].includes(checked[0]))
      throw new HttpError(400, '使用 mysql --login-path=名称 -e SQL 执行原生连接');
    return [...selector, '--binary-mode', '--local-infile=0', ...checked];
  }
}
