import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type { ConnectionInventory } from '../../protocol/connection-types.js';

export const KUBERNETES_CREDENTIAL_POLICY = 'explicit-kubeconfig-v1';

/**
 * Import an operator-provided kubeconfig once. No cluster calls or token
 * renewal occur here. Requiring an explicit path prevents the server from
 * silently distributing a developer's default kubeconfig to Sandboxes.
 */
export async function importKubernetesCredentials(_home: string) {
  const path = process.env.COCELL_KUBECONFIG;
  if (!path) return undefined;
  if (!isAbsolute(path)) throw new Error('COCELL_KUBECONFIG 必须是绝对路径');
  let text: string;
  try { text = await readFile(path, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw new Error('无法读取 Kubernetes 专用凭据'); }
  try {
    const input = JSON.parse(text);
    if (!Array.isArray(input.contexts) || !input.contexts.length) throw Error();
    const clusters = [], contexts = [], users = [];
    const connections: ConnectionInventory['connections'] = [];
    const names = new Set<string>();
    for (const entry of input.contexts) {
      if (typeof entry.name !== 'string' || !entry.name || /[\r\n\0]/.test(entry.name) || names.has(entry.name)) throw Error();
      names.add(entry.name);
      const source = input.clusters?.find((item: any) => item.name === entry.context.cluster)?.cluster;
      const user = input.users?.find((item: any) => item.name === entry.context.user)?.user;
      const url = new URL(source?.server);
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || source['insecure-skip-tls-verify'] || source['certificate-authority']) throw Error();
      if (typeof user?.token !== 'string' || !user.token || /[\r\n\0]/.test(user.token)) throw Error();
      clusters.push({ name: entry.name, cluster: { server: source.server,
        ...(source['certificate-authority-data'] ? { 'certificate-authority-data': source['certificate-authority-data'] } : {}),
        ...(source['tls-server-name'] ? { 'tls-server-name': source['tls-server-name'] } : {}) } });
      users.push({ name: entry.name, user: { token: user.token } });
      contexts.push({ name: entry.name, context: { cluster: entry.name, user: entry.name,
        ...(entry.context.namespace ? { namespace: entry.context.namespace } : {}) } });
      connections.push({ id: 'kubernetes:' + entry.name, type: 'kubernetes', name: entry.name, host: url.host,
        username: 'operator-provided',
        note: '由部署者显式提供的 kubeconfig；其权限范围由部署者管理。' });
    }
    const current = input['current-context'] || contexts[0].name;
    if (!names.has(current)) throw Error();
    const config = { apiVersion: 'v1', kind: 'Config', clusters, users, contexts, 'current-context': current };
    return { connections, policy: KUBERNETES_CREDENTIAL_POLICY,
      files: { 'kubernetes/config.json': Buffer.from(JSON.stringify(config)).toString('base64') } };
  } catch { throw new Error('COCELL_KUBECONFIG 无效或无法读取'); }
}
