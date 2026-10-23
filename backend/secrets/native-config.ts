import { createHash } from 'node:crypto';
import { HttpError } from '../../util/errors.js';
import type { ProvisionedToolFile } from '../../protocol/secret-types.js';
import { encodeMysqlLogin } from './mysql-login.js';
import { credentialTool } from '../tool-access/index.js';
import { mysqlProfiles } from '../tool-access/implementations/mysql.js';
import { kubeConfig, type Named } from '../tool-access/implementations/kubectl.js';
export { mysqlProfiles, kubeConfig };

export const nativeContextTool = (tool: string) => credentialTool(tool) !== undefined;
export const nativeConfigPath = (tool: string) => { const adapter = credentialTool(tool); if (!adapter) throw new Error('Tool has no native credential config'); return adapter.configPath; };
export type { CredentialSource as NativeSource } from '../tool-access/interfaces.js';
import type { CredentialSource as NativeSource } from '../tool-access/interfaces.js';
export function nativeNames(tool: string, source: NativeSource): string[] {
  return [...credentialTool(tool)!.listCredentials([source]).names];
}

export function mergedBinding(tool: string, sources: Array<Pick<NativeSource, 'id' | 'name' | 'version'> & { content?: string }>) {
  const revision = createHash('sha256').update(JSON.stringify(sources.map(source => [source.id, source.version, tool === 'mysql' ? source.name : '',
    ...(source.content === undefined ? [] : [createHash('sha256').update(source.content).digest('hex')])]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))))).digest('hex');
  return { tool, secretId: `native-${tool}`, path: nativeConfigPath(tool), version: 0, revision };
}

/** Merge enabled shared sources without changing their native context names. */
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
  } else if (tool === 'ssh') {
    credentialTool(tool)!.listCredentials(sources);
    if (sources.length > 1) for (const source of sources) {
      let scoped = false;
      for (const line of source.content.replace(/^\uFEFF/, '').split(/\r?\n/)) {
        if (/^\s*(?:#|$)/.test(line)) continue;
        if (/^\s*Host(?:\s|=)/i.test(line)) {
          // Shared defaults, patterns and includes can affect another source's
          // aliases because OpenSSH takes the first value for most options.
          if (!/^\s*Host(?:\s*=\s*|\s+)[A-Za-z0-9][A-Za-z0-9._-]*(?:\s+[A-Za-z0-9][A-Za-z0-9._-]*)*\s*(?:#.*)?$/i.test(line))
            throw new HttpError(400, '合并多份 SSH 配置时请仅使用明确的 Host 别名；共享默认值或模式请放入一份完整配置');
          scoped = true;
        } else if (!scoped || /^\s*(?:Include|Match)(?:\s|=)/i.test(line)) {
          throw new HttpError(400, '合并多份 SSH 配置时连接选项必须位于明确的 Host 块内，不能使用 Include 或 Match');
        }
      }
    }
    content = sources.map(source => source.content.replace(/^\uFEFF/, '') + '\n').join('\n');
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
    result['current-context'] = selected && contexts.has(selected) ? selected : '';
    content = JSON.stringify(result, null, 2) + '\n';
  }
  const bytes = tool === 'mysql' ? encodeMysqlLogin(content) : Buffer.from(content);
  if (!bytes.length || bytes.length > 1024 * 1024) throw new HttpError(400, '合并的原生工具配置不能超过 1 MiB');
  return { ...mergedBinding(tool, sources), content: bytes.toString('base64'), mutable: true, alias: '' };
}
