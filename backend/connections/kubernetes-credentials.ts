import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ConnectionInventory } from '../../protocol/connection-types.js';

export const KUBERNETES_CREDENTIAL_POLICY = 'static-admin-v1';

/** Import the dedicated, portable kubeconfig once. No cluster calls or token renewal. */
export async function importKubernetesCredentials(home: string) {
  let text: string;
  try { text = await readFile(join(home, '.kube/swarm-hive-admin.json'), 'utf8'); }
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
        username: 'system:serviceaccount:codex-devtools:swarm-hive-admin',
        note: '专用 cluster-admin 身份，拥有全部 Kubernetes RBAC 权限；令牌不自动到期，删除对应 Secret 或账号可撤销。' });
    }
    const current = input['current-context'] || contexts[0].name;
    if (!names.has(current)) throw Error();
    const config = { apiVersion: 'v1', kind: 'Config', clusters, users, contexts, 'current-context': current };
    return { connections, policy: KUBERNETES_CREDENTIAL_POLICY,
      files: { 'kubernetes/config.json': Buffer.from(JSON.stringify(config)).toString('base64') } };
  } catch { throw new Error('Kubernetes 专用凭据无效，请运行 node scripts/kubernetes-admin.mjs 重新签发并导入'); }
}
