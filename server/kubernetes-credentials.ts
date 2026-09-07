import { access } from 'node:fs/promises';
import { join } from 'node:path';
import type { LocalCommand } from './connections.js';
import type { ConnectionInventory } from '../shared/connection-types.js';
import { KUBERNETES_DEVELOPER_NAMESPACE as namespace, KUBERNETES_DEVELOPER_SERVICE_ACCOUNT as serviceAccount, KUBERNETES_DEVELOPER_CLUSTER_ROLE as roleName, KUBERNETES_DEVELOPER_CLUSTER_ROLE_BINDING as bindingName, DEVELOPER_READONLY_RULES, validateDeveloperReadonlyRules } from './kubernetes-policy.js';

export const KUBERNETES_CREDENTIAL_POLICY = 'developer-readonly-v1';
const identity = `system:serviceaccount:${namespace}:${serviceAccount}`;
const failure = () => new Error('Kubernetes 只读身份不可用：请检查专用 RBAC 配置；不会回退到宿主高权限凭据');
const groups = new Set(['system:authenticated', 'system:serviceaccounts', `system:serviceaccounts:${namespace}`]);
const discovery = new Set(['/api', '/api/*', '/apis', '/apis/*', '/healthz', '/livez', '/readyz', '/version', '/version/', '/openapi', '/openapi/*', '/.well-known/openid-configuration', '/.well-known/openid-configuration/', '/openid/v1/jwks', '/openid/v1/jwks/']);

/** RBAC is additive: reject unsafe permissions inherited from other bindings. */
export function isSafeInheritedKubernetesRules(rules: unknown): boolean {
  if (!Array.isArray(rules)) return false;
  return rules.every(rule => {
    if (!rule || !Array.isArray(rule.verbs) || !rule.verbs.length) return false;
    if (rule.nonResourceURLs) return !rule.resources && rule.verbs.every((v: string) => v === 'get') && Array.isArray(rule.nonResourceURLs) && rule.nonResourceURLs.every((url: string) => discovery.has(url));
    if (!Array.isArray(rule.apiGroups) || !Array.isArray(rule.resources)) return false;
    return rule.apiGroups.every((group: string) => rule.resources.every((resource: string) => rule.verbs.every((verb: string) => {
      if (verb === 'create' && ((group === 'authorization.k8s.io' && ['selfsubjectaccessreviews', 'selfsubjectrulesreviews'].includes(resource)) || (group === 'authentication.k8s.io' && resource === 'selfsubjectreviews'))) return true;
      return DEVELOPER_READONLY_RULES.some(allowed => (allowed.apiGroups as readonly string[]).includes(group) && (allowed.resources as readonly string[]).includes(resource) && (allowed.verbs as readonly string[]).includes(verb));
    })));
  });
}

/** Only the host uses its original kubeconfig to mint restricted, expiring tokens. */
export async function importKubernetesCredentials(home: string, command: LocalCommand) {
  const path = join(home, '.kube/config');
  try { await access(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw failure(); }
  try {
    const input = JSON.parse(await command('kubectl', ['--kubeconfig', path, 'config', 'view', '--flatten', '--raw', '-o', 'json']));
    if (!Array.isArray(input.contexts) || !input.contexts.length) return undefined;
    const clusters = [], contexts = [], users = [];
    const connections: ConnectionInventory['connections'] = [];
    let expiresAt = Infinity;
    for (const entry of input.contexts) {
      if (typeof entry.name !== 'string' || !entry.name || /[\r\n\0]/.test(entry.name)) throw failure();
      const source = input.clusters?.find((item: any) => item.name === entry.context.cluster)?.cluster;
      const url = new URL(source?.server);
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || source['insecure-skip-tls-verify'] || source['certificate-authority']) throw failure();
      const base = ['--kubeconfig', path, '--context', entry.name, '--request-timeout=10s'];
      const read = async (args: string[]) => JSON.parse(await command('kubectl', [...base, ...args, '-o', 'json']));
      const role = await read(['get', 'clusterrole', roleName]);
      if (role.aggregationRule || !validateDeveloperReadonlyRules(role.rules)) throw failure();
      const binding = await read(['get', 'clusterrolebinding', bindingName]);
      if (binding.roleRef?.kind !== 'ClusterRole' || binding.roleRef?.name !== roleName || binding.roleRef?.apiGroup !== 'rbac.authorization.k8s.io' || binding.subjects?.length !== 1 || binding.subjects[0].kind !== 'ServiceAccount' || binding.subjects[0].name !== serviceAccount || binding.subjects[0].namespace !== namespace) throw failure();
      const allBindings = [...(await read(['get', 'clusterrolebindings'])).items, ...(await read(['get', 'rolebindings', '--all-namespaces'])).items];
      const checked = new Set<string>();
      for (const candidate of allBindings) {
        if (!candidate.subjects?.some((subject: any) => (subject.kind === 'ServiceAccount' && subject.name === serviceAccount && (subject.namespace || candidate.metadata?.namespace) === namespace) || (subject.kind === 'User' && subject.name === identity) || (subject.kind === 'Group' && groups.has(subject.name)))) continue;
        const ref = candidate.roleRef;
        const key = `${ref?.kind}:${ref?.name}:${ref?.kind === 'Role' ? candidate.metadata?.namespace : ''}`;
        if (checked.has(key)) continue;
        checked.add(key);
        if (!['Role', 'ClusterRole'].includes(ref?.kind)) throw failure();
        const inherited = await read(['get', ref.kind.toLowerCase(), ref.name, ...(ref.kind === 'Role' ? ['--namespace', candidate.metadata.namespace] : [])]);
        if (inherited.aggregationRule || !isSafeInheritedKubernetesRules(inherited.rules)) throw failure();
      }
      const result = await read(['create', 'token', serviceAccount, '--namespace', namespace, '--duration=1h']);
      const expiration = Date.parse(result.status?.expirationTimestamp);
      const token = result.status?.token;
      if (typeof token !== 'string' || !token || /[\r\n\0]/.test(token) || !Number.isFinite(expiration) || expiration < Date.now() + 120_000 || expiration > Date.now() + 7_200_000) throw failure();
      expiresAt = Math.min(expiresAt, expiration);
      const cluster = { server: source.server, ...(source['certificate-authority-data'] ? { 'certificate-authority-data': source['certificate-authority-data'] } : {}), ...(source['tls-server-name'] ? { 'tls-server-name': source['tls-server-name'] } : {}) };
      clusters.push({ name: entry.name, cluster });
      users.push({ name: entry.name, user: { token } });
      contexts.push({ name: entry.name, context: { cluster: entry.name, user: entry.name, ...(entry.context.namespace ? { namespace: entry.context.namespace } : {}) } });
      connections.push({ id: `kubernetes:${entry.name}`, type: 'kubernetes', name: entry.name, host: url.host, username: identity, note: '开发者只读 · 集群 RBAC 强制执行。可读资源、日志及 ConfigMap/Secret；禁止资源增删改、exec 与端口转发。' });
    }
    const current = input['current-context'] || contexts[0].name;
    if (!contexts.some(entry => entry.name === current)) throw failure();
    const config = { apiVersion: 'v1', kind: 'Config', clusters, users, contexts, 'current-context': current };
    return { connections, expiresAt, policy: KUBERNETES_CREDENTIAL_POLICY, files: { 'kubernetes/config.json': Buffer.from(JSON.stringify(config)).toString('base64') } };
  } catch { throw failure(); }
}
