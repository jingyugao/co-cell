import { parse } from 'yaml';
import { HttpError } from '../../../util/errors.js';
import type { CredentialCatalog, CredentialSource, ToolWithCredential } from '../interfaces.js';
import { BasicTool, credentialOption } from './tool.js';

const validName = (value: unknown): value is string => typeof value === 'string' && !!value && value.length <= 256 && !/[\u0000-\u001f\u007f\[\]]/.test(value);

export interface Named { name: string; [key: string]: unknown }
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

export class KubectlTool extends BasicTool implements ToolWithCredential {
  readonly kind = 'tool-with-credential' as const;
  readonly configPath = '.kube/config';
  readonly credentialOption = '--context';
  constructor() { super('kubectl'); }
  listCredentials(sources: readonly CredentialSource[], mountedConfig?: Buffer): CredentialCatalog {
    const configs = mountedConfig ? [kubeConfig(mountedConfig.toString('utf8'))] : sources.map(source => kubeConfig(source.content));
    const names = configs.flatMap(config => config.contexts.map(context => context.name));
    if (new Set(names).size !== names.length) throw new HttpError(400, 'Kubernetes 原生 context 名称重复');
    const current = configs[0]?.['current-context'];
    return { names, ...(current && names.includes(current) ? { defaultName: current } : {}) };
  }
  resolveCredential(args: readonly string[]) {
    const explicit = credentialOption(args, '--context');
    if (explicit !== undefined) return explicit;
    if ((args.length === 1 && ['--help', '-h', 'help'].includes(args[0])) ||
      (args.length === 2 && args[0] === 'version' && ['--client', '--client=true'].includes(args[1]))) return undefined;
    throw new HttpError(400, '请用 kubectl --context=名称 选择凭据');
  }
  override validateArgs(args: readonly string[]) {
    credentialOption(args, '--context');
    if (args.some(arg => /^(?:--(?:token|server|kubeconfig|user|cluster|certificate-authority|client-certificate|client-key|tls-server-name|insecure-skip-tls-verify)|-s)(?:=|$)/.test(arg)))
      throw new HttpError(403, '不能覆盖受保护连接配置');
    return [...args];
  }
}
