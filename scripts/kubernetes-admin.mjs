// One-time provisioning: node scripts/kubernetes-admin.mjs
// Manual ServiceAccount token Secrets have no automatic expiry. Deleting the
// Secret/ServiceAccount or removing the binding revokes access; they are not irrevocable.
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const contexts = ['common', 'example_data', 'example_extra'];
const namespace = 'codex-devtools';
const account = 'swarm-hive-admin';
const secretName = `${account}-token`;
const ownerLabel = 'app.kubernetes.io/managed-by';
const purposeLabel = 'swarm-hive/access';
const labels = { [ownerLabel]: 'swarm-hive', [purposeLabel]: 'admin' };
const output = join(homedir(), '.kube', 'swarm-hive-admin.json');
const temporary = `${output}.${randomUUID()}.tmp`;

function kubectl(context, args, input, kubeconfig) {
  try {
    return execFileSync('kubectl', [
      ...(kubeconfig ? ['--kubeconfig', kubeconfig] : []),
      '--context', context, '--request-timeout=20s', ...args,
    ], { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'], timeout: 30_000 });
  } catch {
    // kubectl errors can contain response bodies or configuration: never echo them.
    throw new Error(`${context}: kubectl ${args[0]} ${args[1] || ''} failed`);
  }
}

function get(context, kind, name, scoped = false) {
  const raw = kubectl(context, ['get', kind, name,
    ...(scoped ? ['--namespace', namespace] : []), '--ignore-not-found', '-o', 'json']);
  return raw.trim() ? JSON.parse(raw) : null;
}

function manifests() {
  return [
    { apiVersion: 'v1', kind: 'Namespace', metadata: { name: namespace, labels: { [ownerLabel]: 'swarm-hive' } } },
    { apiVersion: 'v1', kind: 'ServiceAccount', metadata: { name: account, namespace, labels }, automountServiceAccountToken: false },
    {
      apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'ClusterRoleBinding',
      metadata: { name: account, labels },
      roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: 'cluster-admin' },
      subjects: [{ kind: 'ServiceAccount', name: account, namespace }],
    },
    {
      apiVersion: 'v1', kind: 'Secret',
      metadata: { name: secretName, namespace, labels, annotations: { 'kubernetes.io/service-account.name': account } },
      type: 'kubernetes.io/service-account-token',
    },
  ];
}

function checkExisting(context, existing, desired) {
  if (!existing) return;
  const namespaceOnly = desired.kind === 'Namespace';
  if (existing.metadata?.labels?.[ownerLabel] !== 'swarm-hive'
    || (!namespaceOnly && existing.metadata?.labels?.[purposeLabel] !== 'admin')) {
    throw new Error(`${context}: refusing to overwrite unmanaged ${desired.kind}/${desired.metadata.name}`);
  }
  if (desired.kind === 'ClusterRoleBinding'
    && (JSON.stringify(existing.roleRef) !== JSON.stringify(desired.roleRef)
      || existing.subjects?.length !== 1
      || existing.subjects[0].kind !== 'ServiceAccount'
      || existing.subjects[0].name !== account
      || existing.subjects[0].namespace !== namespace)) {
    throw new Error(`${context}: existing admin binding has unexpected permissions or subjects`);
  }
  if (desired.kind === 'Secret' && (existing.type !== desired.type
    || existing.metadata.annotations?.['kubernetes.io/service-account.name'] !== account)) {
    throw new Error(`${context}: existing token Secret belongs to a different identity`);
  }
}

async function main() {
  const plans = [];
  // Check every context and name before making changes to any cluster.
  for (const context of contexts) {
    const source = JSON.parse(kubectl(context, ['config', 'view', '--raw', '--flatten', '--minify', '-o', 'json']));
    if (source.contexts?.length !== 1 || source.clusters?.length !== 1) throw new Error(`${context}: invalid source configuration`);
    const cluster = source.clusters[0];
    if (!cluster.cluster.server || cluster.cluster['certificate-authority']) throw new Error(`${context}: configuration is not portable`);
    const resources = manifests().map(desired => {
      const existing = get(context, desired.kind, desired.metadata.name, !!desired.metadata.namespace);
      checkExisting(context, existing, desired);
      return { desired, existing };
    });
    plans.push({ context, source, resources });
  }

  const config = { apiVersion: 'v1', kind: 'Config', clusters: [], contexts: [], users: [], 'current-context': 'common' };
  for (const { context, source, resources } of plans) {
    for (const { desired, existing } of resources) {
      if (!existing) kubectl(context, ['create', '-f', '-'], JSON.stringify(desired));
    }
    let token;
    for (let attempt = 0; attempt < 30; attempt++) {
      const secret = get(context, 'Secret', secretName, true);
      if (secret?.data?.token) {
        token = Buffer.from(secret.data.token, 'base64').toString('utf8');
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 1_000));
    }
    if (!token) throw new Error(`${context}: control plane did not populate the token Secret`);
    let claims;
    try { claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')); }
    catch { throw new Error(`${context}: token payload is invalid`); }
    if (claims.exp !== undefined || claims.sub !== `system:serviceaccount:${namespace}:${account}`) {
      throw new Error(`${context}: token has expiry or unexpected identity`);
    }
    config.clusters.push({ name: context, cluster: source.clusters[0].cluster });
    config.contexts.push({ name: context, context: { ...source.contexts[0].context, cluster: context, user: `${context}-${account}` } });
    config.users.push({ name: `${context}-${account}`, user: { token } });
  }

  await mkdir(join(homedir(), '.kube'), { recursive: true, mode: 0o700 });
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  for (const context of contexts) {
    for (const args of [['auth', 'can-i', '*', '*', '--all-namespaces'], ['auth', 'can-i', '*', '/*']]) {
      if (kubectl(context, args, undefined, temporary).trim() !== 'yes') throw new Error(`${context}: admin permission verification failed`);
    }
    console.log(`${context}: resource and non-resource admin permissions verified; token has no automatic expiry`);
  }
  await rename(temporary, output);
  await chmod(output, 0o600);
  console.log(`Kubeconfig: ${output}`);
}

try { await main(); }
catch (error) { console.error(error.message); process.exitCode = 1; }
finally { await rm(temporary, { force: true }); }
