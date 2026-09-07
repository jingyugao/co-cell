import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createDeveloperReadonlyManifests, DEVELOPER_READONLY_RULES, validateDeveloperReadonlyRules,
  KUBERNETES_DEVELOPER_NAMESPACE, KUBERNETES_DEVELOPER_SERVICE_ACCOUNT,
  KUBERNETES_DEVELOPER_CLUSTER_ROLE, KUBERNETES_DEVELOPER_CLUSTER_ROLE_BINDING,
} from '../server/kubernetes-policy.js';

const rules = () => DEVELOPER_READONLY_RULES.map(rule => ({ apiGroups: [...rule.apiGroups], resources: [...rule.resources], verbs: [...rule.verbs] }));
const allows = (group: string, resource: string, verb: string) => DEVELOPER_READONLY_RULES.some(rule => rule.apiGroups.includes(group) && rule.resources.includes(resource) && rule.verbs.includes(verb));

test('developer manifests bind only the dedicated service account to the explicit readonly role', () => {
  assert.equal(KUBERNETES_DEVELOPER_NAMESPACE, 'codex-devtools');
  assert.equal(KUBERNETES_DEVELOPER_SERVICE_ACCOUNT, 'codex-developer-readonly');
  assert.equal(KUBERNETES_DEVELOPER_CLUSTER_ROLE, 'swarm-hive-developer-readonly');
  assert.equal(KUBERNETES_DEVELOPER_CLUSTER_ROLE_BINDING, 'swarm-hive-developer-readonly');
  const manifests = createDeveloperReadonlyManifests();
  assert.deepEqual(manifests.map(item => item.kind), ['Namespace', 'ServiceAccount', 'ClusterRole', 'ClusterRoleBinding']);
  const account = manifests.find(item => item.kind === 'ServiceAccount')!;
  assert.equal(account.metadata.namespace, KUBERNETES_DEVELOPER_NAMESPACE);
  assert.equal(account.automountServiceAccountToken, false);
  const binding = manifests.find(item => item.kind === 'ClusterRoleBinding')!;
  assert.deepEqual(binding.subjects, [{ kind: 'ServiceAccount', name: KUBERNETES_DEVELOPER_SERVICE_ACCOUNT, namespace: KUBERNETES_DEVELOPER_NAMESPACE }]);
  assert.deepEqual(binding.roleRef, { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: KUBERNETES_DEVELOPER_CLUSTER_ROLE });
  const role = manifests.find(item => item.kind === 'ClusterRole')!;
  assert.equal(validateDeveloperReadonlyRules(role.rules), true);
  assert.ok(!('aggregationRule' in role));
  assert.ok(!JSON.stringify(manifests).includes('cluster-admin'));
});

test('only the requested resources and read verbs are allowed, including pod logs and pod metrics', () => {
  const resources: Record<string, string[]> = {
    '': ['pods', 'pods/log', 'services', 'endpoints', 'events', 'namespaces', 'persistentvolumeclaims'],
    apps: ['deployments', 'replicasets', 'statefulsets', 'daemonsets'],
    batch: ['jobs', 'cronjobs'],
    'networking.k8s.io': ['ingresses', 'networkpolicies'],
    'metrics.k8s.io': ['pods'],
  };
  for (const [group, names] of Object.entries(resources)) for (const resource of names) {
    for (const verb of ['get', 'list', 'watch']) assert.equal(allows(group, resource, verb), true, `${group}/${resource}/${verb}`);
    for (const verb of ['create', 'update', 'patch', 'delete', 'deletecollection', 'impersonate', 'bind', 'escalate', '*']) assert.equal(allows(group, resource, verb), false, `${group}/${resource}/${verb}`);
  }
  for (const resource of ['secrets', 'configmaps', 'nodes', 'pods/exec', 'pods/attach', 'pods/portforward', 'pods/proxy', 'services/proxy', 'nodes/proxy', 'serviceaccounts', 'serviceaccounts/token', '*']) {
    for (const verb of ['get', 'list', 'watch', 'create']) assert.equal(allows('', resource, verb), false, `${resource}/${verb}`);
  }
  assert.equal(allows('metrics.k8s.io', 'nodes', 'get'), false);
  for (const resource of ['roles', 'clusterroles', 'rolebindings', 'clusterrolebindings']) assert.equal(allows('rbac.authorization.k8s.io', resource, 'get'), false);
});

test('rules validator accepts reordering and equivalent splitting but rejects missing or duplicate permissions', () => {
  const reordered = rules().reverse().map(rule => ({ apiGroups: rule.apiGroups, resources: rule.resources.reverse(), verbs: rule.verbs.reverse() }));
  assert.equal(validateDeveloperReadonlyRules(reordered), true);
  const split = rules().flatMap(rule => rule.resources.flatMap(resource => rule.verbs.map(verb => ({ apiGroups: rule.apiGroups, resources: [resource], verbs: [verb] }))));
  assert.equal(validateDeveloperReadonlyRules(split), true);
  assert.equal(validateDeveloperReadonlyRules(split.slice(1)), false);
  assert.equal(validateDeveloperReadonlyRules([...split, split[0]]), false);
});

test('rules validator refuses write escalation, wildcards, subresource access and non-resource grants', () => {
  for (const resource of ['secrets', 'configmaps', 'pods/exec', 'pods/attach', 'pods/portforward', 'pods/proxy', 'services/proxy', '*']) {
    const changed = rules(); changed[0]!.resources.push(resource); assert.equal(validateDeveloperReadonlyRules(changed), false, resource);
  }
  for (const verb of ['create', 'delete', 'update', 'patch', 'deletecollection', 'impersonate', 'bind', 'escalate', '*']) {
    const changed = rules(); changed[0]!.verbs.push(verb); assert.equal(validateDeveloperReadonlyRules(changed), false, verb);
  }
  const changed = rules(); changed[0]!.apiGroups.push('*'); assert.equal(validateDeveloperReadonlyRules(changed), false);
  assert.equal(validateDeveloperReadonlyRules([...rules(), { nonResourceURLs: ['*'], verbs: ['get'] }]), false);
  assert.equal(validateDeveloperReadonlyRules(rules().map(rule => ({ ...rule, resourceNames: ['limited'] }))), false);
  assert.equal(validateDeveloperReadonlyRules(rules().map(rule => ({ ...rule, nonResourceURLs: [] }))), false);
});

test('malformed policy inputs are safely rejected and generated objects cannot mutate future policies', () => {
  for (const input of [null, {}, [], [null], [{ apiGroups: '', resources: ['pods'], verbs: ['get'] }], [{ apiGroups: [''], resources: ['pods'], verbs: [null] }]]) assert.equal(validateDeveloperReadonlyRules(input), false);
  const first = createDeveloperReadonlyManifests();
  first.find(item => item.kind === 'ClusterRole')!.rules[0]!.verbs.push('create');
  first.find(item => item.kind === 'ClusterRoleBinding')!.subjects.push({ kind: 'ServiceAccount', name: 'other', namespace: 'default' });
  const second = createDeveloperReadonlyManifests();
  assert.equal(validateDeveloperReadonlyRules(second.find(item => item.kind === 'ClusterRole')!.rules), true);
  assert.equal(second.find(item => item.kind === 'ClusterRoleBinding')!.subjects.length, 1);
  assert.ok(Object.isFrozen(DEVELOPER_READONLY_RULES));
  assert.ok(Object.isFrozen(DEVELOPER_READONLY_RULES[0]!.verbs));
});
