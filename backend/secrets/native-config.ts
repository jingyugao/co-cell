import { createHash } from 'node:crypto';
import { parse } from 'yaml';
import { HttpError } from '../../util/errors.js';
import type { ProvisionedToolFile } from '../../protocol/secret-types.js';
import { encodeMysqlLogin } from './mysql-login.js';

export const nativeContextTool = (tool: string) => tool === 'mysql' || tool === 'kubectl';
export const nativeConfigPath = (tool: string) => tool === 'mysql' ? '.mylogin.cnf' : '.kube/config';
export interface NativeSource { id: string; name: string; version: number; content: string }
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

interface Named { name: string; [key: string]: unknown }
interface KubeConfig { clusters: Named[]; users: Named[]; contexts: Array<Named & { context: { cluster: string; user?: string; [key: string]: unknown } }>; 'current-context'?: string }
export function kubeConfig(content: string): KubeConfig {
  try {
    const value = JSON.parse(JSON.stringify(parse(content, { maxAliasCount: 50 })));
    if (!value || value.kind !== 'Config' || value.apiVersion !== 'v1') throw new Error();
    for (const key of ['clusters', 'users', 'contexts']) {
      if (key !== 'contexts' && value[key] == null) value[key] = [];
      if (!Array.isArray(value[key]) || new Set(value[key].map((item: Named) => item?.name)).size !== value[key].length || value[key].some((item: Named) => !validName(item?.name))) throw new Error();
    }
    for (const cluster of value.clusters) if (!cluster.cluster || typeof cluster.cluster.server !== 'string') throw new Error();
    for (const user of value.users) if (!user.user || typeof user.user !== 'object' || Array.isArray(user.user)) throw new Error();
    if (!value.contexts.length) throw new Error();
    for (const item of value.contexts) {
      if (!item.context || !value.clusters.some((cluster: Named) => cluster.name === item.context.cluster) || (item.context.user && !value.users.some((user: Named) => user.name === item.context.user))) throw new Error();
    }
    return value;
  } catch { throw new HttpError(400, 'Kubernetes 凭证需要有效的原生 kubeconfig 和完整的 context 引用'); }
}

export function nativeNames(tool: string, source: NativeSource): string[] {
  return tool === 'mysql' ? [...mysqlProfiles(source.content, source.name).keys()] : kubeConfig(source.content).contexts.map(item => item.name);
}

export function mergedBinding(tool: string, sources: Array<Pick<NativeSource, 'id' | 'name' | 'version'> & { content?: string }>) {
  const revision = createHash('sha256').update(JSON.stringify(sources.map(source => [source.id, source.version, tool === 'mysql' ? source.name : '',
    ...(source.content === undefined ? [] : [createHash('sha256').update(source.content).digest('hex')])]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))))).digest('hex');
  return { tool, secretId: `native-${tool}`, path: nativeConfigPath(tool), version: 0, revision };
}

/** Only role-granted sources enter the native config. Context names remain unchanged. */
export function mergeNativeConfig(tool: string, sources: NativeSource[]): ProvisionedToolFile {
  let content: string;
  if (tool === 'mysql') {
    const profiles = new Map<string, string[]>();
    for (const source of sources) for (const [name, options] of mysqlProfiles(source.content, source.name)) {
      if (profiles.has(name)) throw new HttpError(400, `MySQL 原生连接名称重复：${name}`);
      profiles.set(name, options);
    }
    const groups = [...profiles].map(([name, options]) => `[${name}]\n${options.join('\n')}\n`);
    if (profiles.size === 1 && !profiles.has('client')) groups.unshift(`[client]\n${[...profiles.values()][0].join('\n')}\n`);
    content = groups.join('\n');
  } else {
    const configs = sources.map(source => ({ source, config: kubeConfig(source.content) }));
    const contexts = new Set<string>();
    const result: { apiVersion: string; kind: string; clusters: Named[]; users: Named[]; contexts: Named[]; 'current-context': string } = { apiVersion: 'v1', kind: 'Config', clusters: [], users: [], contexts: [], 'current-context': '' };
    // Qualify internal cluster/user keys, which often collide across independent
    // accounts. The native, operator-facing context names are never renamed.
    for (const { source, config } of configs) for (const context of config.contexts) {
      if (contexts.has(context.name)) throw new HttpError(400, `Kubernetes 原生 context 名称重复：${context.name}`);
      contexts.add(context.name);
      const cluster = config.clusters.find(item => item.name === context.context.cluster)!;
      const user = config.users.find(item => item.name === context.context.user);
      const clusterName = `${source.id}/${cluster.name}`, userName = user ? `${source.id}/${user.name}` : undefined;
      if (!result.clusters.some(item => item.name === clusterName)) result.clusters.push({ ...cluster, name: clusterName });
      if (user && !result.users.some(item => item.name === userName)) result.users.push({ ...user, name: userName! });
      result.contexts.push({ ...context, context: { ...context.context, cluster: clusterName, ...(user ? { user: userName } : {}) } });
    }
    const selected = configs[0]?.config['current-context'];
    result['current-context'] = selected && contexts.has(selected) ? selected : result.contexts[0]?.name ?? '';
    content = JSON.stringify(result, null, 2) + '\n';
  }
  const bytes = tool === 'mysql' ? encodeMysqlLogin(content) : Buffer.from(content);
  if (!bytes.length || bytes.length > 1024 * 1024) throw new HttpError(400, '合并的原生工具配置不能超过 1 MiB');
  return { ...mergedBinding(tool, sources), content: bytes.toString('base64'), mutable: true, alias: '' };
}
