/** Static policy only. This module never reads credentials or calls Kubernetes. */
export const KUBERNETES_DEVELOPER_NAMESPACE = 'codex-devtools';
// Keep existing Kubernetes object names so upgrades preserve bindings and tokens.
export const KUBERNETES_DEVELOPER_SERVICE_ACCOUNT = 'codex-developer-readonly';
export const KUBERNETES_DEVELOPER_CLUSTER_ROLE = 'swarm-hive-developer-readonly';
export const KUBERNETES_DEVELOPER_CLUSTER_ROLE_BINDING = 'swarm-hive-developer-readonly';

export interface DeveloperRule {
  apiGroups: string[];
  resources: string[];
  verbs: string[];
}
type FrozenRule = { readonly [Key in keyof DeveloperRule]: readonly string[] };
const matrix: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['', ['pods', 'pods/log', 'services', 'endpoints', 'events', 'namespaces', 'persistentvolumeclaims', 'configmaps', 'secrets']],
  ['apps', ['deployments', 'replicasets', 'statefulsets', 'daemonsets']],
  ['batch', ['jobs', 'cronjobs']],
  ['networking.k8s.io', ['ingresses', 'networkpolicies']],
  ['metrics.k8s.io', ['pods']],
];
// Only connection subresources get create: never grant it on pods or services.
// Exec permits commands inside existing containers; it is not a read-only shell.
export const DEVELOPER_RULES: readonly FrozenRule[] = Object.freeze([
  ...matrix.map(([group, resources]) => Object.freeze({
    apiGroups: Object.freeze([group]), resources: Object.freeze([...resources]), verbs: Object.freeze(['get', 'list', 'watch']),
  })),
  Object.freeze({
    apiGroups: Object.freeze(['']), resources: Object.freeze(['pods/exec', 'pods/portforward']), verbs: Object.freeze(['get', 'create']),
  }),
]);
const permission = (group: string, resource: string, verb: string) => JSON.stringify([group, resource, verb]);
const expectedPermissions = new Set(DEVELOPER_RULES.flatMap(rule => rule.apiGroups.flatMap(group => rule.resources.flatMap(resource => rule.verbs.map(verb => permission(group, resource, verb))))));

/**
 * Validate the exact intended permission set, independent of rule order/grouping.
 * Additional fields (including nonResourceURLs/resourceNames), wildcards,
 * duplicate permissions and missing permissions are rejected. This checks the
 * supplied rules only; other RoleBindings can still add effective permissions.
 */
export function validateDeveloperRules(value: unknown): boolean {
  try {
    if (!Array.isArray(value) || !value.length || value.length > 128) return false;
    const actual = new Set<string>();
    for (const rule of value) {
      if (!rule || typeof rule !== 'object' || Array.isArray(rule) || Object.keys(rule).sort().join(',') !== 'apiGroups,resources,verbs') return false;
      for (const key of ['apiGroups', 'resources', 'verbs']) {
        const values = rule[key];
        if (!Array.isArray(values) || !values.length || values.length > 32 || values.some(item => typeof item !== 'string') || new Set(values).size !== values.length) return false;
      }
      for (const group of rule.apiGroups) for (const resource of rule.resources) for (const verb of rule.verbs) {
        const key = permission(group, resource, verb);
        if (!expectedPermissions.has(key) || actual.has(key)) return false;
        actual.add(key);
      }
    }
    return actual.size === expectedPermissions.size;
  } catch { return false; }
}

export type DeveloperManifest =
  | { apiVersion: 'v1'; kind: 'Namespace'; metadata: { name: string } }
  | { apiVersion: 'v1'; kind: 'ServiceAccount'; metadata: { name: string; namespace: string }; automountServiceAccountToken: false }
  | { apiVersion: 'rbac.authorization.k8s.io/v1'; kind: 'ClusterRole'; metadata: { name: string }; rules: DeveloperRule[] }
  | { apiVersion: 'rbac.authorization.k8s.io/v1'; kind: 'ClusterRoleBinding'; metadata: { name: string };
    roleRef: { apiGroup: 'rbac.authorization.k8s.io'; kind: 'ClusterRole'; name: string };
    subjects: Array<{ kind: 'ServiceAccount'; name: string; namespace: string }> };

/** Returns fresh manifest objects in dependency order, without creating them. */
export function createDeveloperManifests(): DeveloperManifest[] {
  return [
    { apiVersion: 'v1', kind: 'Namespace', metadata: { name: KUBERNETES_DEVELOPER_NAMESPACE } },
    { apiVersion: 'v1', kind: 'ServiceAccount', metadata: { name: KUBERNETES_DEVELOPER_SERVICE_ACCOUNT, namespace: KUBERNETES_DEVELOPER_NAMESPACE }, automountServiceAccountToken: false },
    { apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'ClusterRole', metadata: { name: KUBERNETES_DEVELOPER_CLUSTER_ROLE },
      rules: DEVELOPER_RULES.map(rule => ({ apiGroups: [...rule.apiGroups], resources: [...rule.resources], verbs: [...rule.verbs] })) },
    { apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'ClusterRoleBinding', metadata: { name: KUBERNETES_DEVELOPER_CLUSTER_ROLE_BINDING },
      roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: KUBERNETES_DEVELOPER_CLUSTER_ROLE },
      subjects: [{ kind: 'ServiceAccount', name: KUBERNETES_DEVELOPER_SERVICE_ACCOUNT, namespace: KUBERNETES_DEVELOPER_NAMESPACE }] },
  ];
}
