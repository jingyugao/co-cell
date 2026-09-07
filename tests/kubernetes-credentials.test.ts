import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, type TestContext } from 'node:test';
import { importKubernetesCredentials, isSafeInheritedKubernetesRules, KUBERNETES_CREDENTIAL_POLICY } from '../server/kubernetes-credentials.js';
import { createDeveloperReadonlyManifests, KUBERNETES_DEVELOPER_NAMESPACE as namespace, KUBERNETES_DEVELOPER_SERVICE_ACCOUNT as serviceAccount, KUBERNETES_DEVELOPER_CLUSTER_ROLE as roleName, KUBERNETES_DEVELOPER_CLUSTER_ROLE_BINDING as bindingName } from '../server/kubernetes-policy.js';
import type { LocalCommand } from '../server/connections.js';

const originalCertificate = Buffer.from('host-admin-certificate-never-export').toString('base64');
const originalKey = Buffer.from('host-admin-private-key-never-export').toString('base64');
const originalToken = 'host-admin-token-never-export';
const originalPassword = 'host-admin-password-never-export';
const ca = Buffer.from('public-cluster-ca').toString('base64');
const identity = `system:serviceaccount:${namespace}:${serviceAccount}`;
function sourceConfig() {
  return {
    apiVersion: 'v1', kind: 'Config', 'current-context': 'common',
    clusters: [{ name: 'internal', cluster: { server: 'https://cluster.example.test:6443', 'certificate-authority-data': ca, 'tls-server-name': 'cluster.example.test', extra: 'drop-cluster-extra' } }],
    users: [{ name: 'admin', user: { 'client-certificate-data': originalCertificate, 'client-key-data': originalKey, token: originalToken, password: originalPassword } }],
    contexts: [{ name: 'common', context: { cluster: 'internal', user: 'admin', namespace: 'apps' } }, { name: 'example_data', context: { cluster: 'internal', user: 'admin' } }],
  };
}
const safeFailure = (error: unknown) => error instanceof Error && /不会回退到宿主高权限凭据/.test(error.message) && [originalCertificate, originalKey, originalToken, originalPassword].every(secret => !error.message.includes(secret));
async function fixture(t: TestContext) {
  const base = fileURLToPath(new URL('../data/.tests/', import.meta.url)); await mkdir(base, { recursive: true });
  const home = await mkdtemp(join(base, 'kubernetes-credentials-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(join(home, '.kube')); const path = join(home, '.kube/config');
  await writeFile(path, 'synthetic host configuration remains unchanged\n', { mode: 0o600 });
  const manifests = createDeveloperReadonlyManifests();
  const state: {
    config: any; role: any; binding: any; clusterBindings: any[]; roleBindings: any[];
    inherited: Record<string, any>; tokens: Record<string, any>; commandFailure?: string;
  } = {
    config: sourceConfig(), role: manifests.find(item => item.kind === 'ClusterRole'), binding: manifests.find(item => item.kind === 'ClusterRoleBinding'),
    clusterBindings: [], roleBindings: [], inherited: {},
    tokens: {
      common: { status: { token: 'restricted-common-token', expirationTimestamp: new Date(Date.now() + 3_600_000).toISOString() } },
      example_data: { status: { token: 'restricted-example_data-token', expirationTimestamp: new Date(Date.now() + 1_800_000).toISOString() } },
    },
  };
  const calls: string[][] = [];
  const command: LocalCommand = async (cmd, args, input) => {
    assert.equal(cmd, 'kubectl'); assert.equal(input, undefined);
    assert.deepEqual(args.slice(0, 2), ['--kubeconfig', path]); calls.push(args);
    if (state.commandFailure) throw new Error(state.commandFailure);
    if (args.includes('view')) {
      assert.deepEqual(args, ['--kubeconfig', path, 'config', 'view', '--flatten', '--raw', '-o', 'json']);
      return JSON.stringify(state.config);
    }
    const context = args[args.indexOf('--context') + 1]!;
    assert.ok(['common', 'example_data'].includes(context));
    assert.ok(args.includes('--request-timeout=10s'));
    assert.deepEqual(args.slice(-2), ['-o', 'json']);
    if (args.includes('get')) {
      const position = args.indexOf('get'); const resource = args[position + 1], name = args[position + 2];
      if (resource === 'clusterrole' && name === roleName) return JSON.stringify(state.role);
      if (resource === 'clusterrolebinding' && name === bindingName) return JSON.stringify(state.binding);
      if (resource === 'clusterrolebindings') return JSON.stringify({ items: [state.binding, ...state.clusterBindings] });
      if (resource === 'rolebindings') { assert.ok(args.includes('--all-namespaces')); return JSON.stringify({ items: state.roleBindings }); }
      const scope = resource === 'role' ? args[args.indexOf('--namespace') + 1] : '';
      const inherited = state.inherited[`${resource}:${name}:${scope}`];
      assert.ok(inherited, `Unexpected inherited role ${resource}:${name}:${scope}`);
      return JSON.stringify(inherited);
    }
    assert.deepEqual(args.slice(args.indexOf('create')), ['create', 'token', serviceAccount, '--namespace', namespace, '--duration=1h', '-o', 'json']);
    return JSON.stringify(state.tokens[context]);
  };
  return { home, path, state, calls, command };
}
function extraBinding(subject: object, kind = 'ClusterRole', scope?: string) {
  return { metadata: { name: 'additional', ...(scope ? { namespace: scope } : {}) }, roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind, name: 'additional-role' }, subjects: [subject] };
}

test('exports only newly minted short-lived service-account tokens and public cluster certificates', async t => {
  const { home, path, state, calls, command } = await fixture(t); const before = await readFile(path);
  const result = (await importKubernetesCredentials(home, command))!;
  assert.equal(result.policy, KUBERNETES_CREDENTIAL_POLICY);
  assert.equal(result.expiresAt, Date.parse(state.tokens.example_data.status.expirationTimestamp));
  assert.deepEqual(Object.keys(result.files), ['kubernetes/config.json']);
  const text = Buffer.from(result.files['kubernetes/config.json'], 'base64').toString(); const exported = JSON.parse(text);
  assert.deepEqual(exported.users, [{ name: 'common', user: { token: 'restricted-common-token' } }, { name: 'example_data', user: { token: 'restricted-example_data-token' } }]);
  assert.equal(exported.clusters[0].cluster['certificate-authority-data'], ca);
  assert.equal(exported.contexts[0].context.namespace, 'apps'); assert.equal(exported['current-context'], 'common');
  for (const secret of [originalCertificate, originalKey, originalToken, originalPassword, 'drop-cluster-extra']) assert.ok(!text.includes(secret));
  const publicMetadata = JSON.stringify(result.connections);
  for (const secret of [originalCertificate, originalKey, originalToken, originalPassword, 'restricted-common-token', 'restricted-example_data-token']) assert.ok(!publicMetadata.includes(secret));
  assert.deepEqual(result.connections.map(item => item.username), [identity, identity]);
  assert.deepEqual(result.connections.map(item => item.host), ['cluster.example.test:6443', 'cluster.example.test:6443']);
  assert.equal(calls.filter(args => args.includes('create')).length, 2);
  assert.deepEqual(await readFile(path), before);
});

test('RBAC rule escalation, aggregation and wrong bindings fail before issuing tokens', async t => {
  for (const modify of [
    (state: any) => state.role.rules[0].verbs.push('create'),
    (state: any) => { state.role.aggregationRule = { clusterRoleSelectors: [] }; },
    (state: any) => { state.binding.roleRef.name = 'cluster-admin'; },
    (state: any) => { state.binding.roleRef.apiGroup = 'unexpected'; },
    (state: any) => { state.binding.subjects[0].namespace = 'default'; },
    (state: any) => state.binding.subjects.push({ kind: 'Group', name: 'system:authenticated' }),
  ]) {
    const { home, state, calls, command } = await fixture(t); modify(state);
    await assert.rejects(importKubernetesCredentials(home, command), safeFailure);
    assert.ok(!calls.some(args => args.includes('create')));
  }
});

test('unsafe permissions inherited through account identity or any automatic group are rejected', async t => {
  for (const subject of [
    { kind: 'ServiceAccount', name: serviceAccount, namespace },
    { kind: 'User', name: identity },
    ...['system:authenticated', 'system:serviceaccounts', `system:serviceaccounts:${namespace}`].map(name => ({ kind: 'Group', name })),
  ]) {
    const { home, state, calls, command } = await fixture(t);
    state.clusterBindings.push(extraBinding(subject));
    state.inherited['clusterrole:additional-role:'] = { rules: [{ apiGroups: [''], resources: ['secrets'], verbs: ['get'] }] };
    await assert.rejects(importKubernetesCredentials(home, command), safeFailure);
    assert.ok(!calls.some(args => args.includes('create')));
  }
});

test('namespaced RoleBindings with an omitted service-account namespace inherit the binding namespace', async t => {
  const { home, state, calls, command } = await fixture(t);
  state.roleBindings.push(extraBinding({ kind: 'ServiceAccount', name: serviceAccount }, 'Role', namespace));
  state.inherited[`role:additional-role:${namespace}`] = { rules: [{ apiGroups: [''], resources: ['pods'], verbs: ['delete'] }] };
  await assert.rejects(importKubernetesCredentials(home, command), safeFailure);
  assert.ok(!calls.some(args => args.includes('create')));
});

test('safe API discovery and self-subject review grants are allowed without allowing other writes', async t => {
  const { home, state, command } = await fixture(t);
  state.clusterBindings.push(extraBinding({ kind: 'Group', name: 'system:authenticated' }));
  state.inherited['clusterrole:additional-role:'] = { rules: [
    { nonResourceURLs: ['/api', '/api/*', '/apis', '/apis/*', '/openapi/*', '/version'], verbs: ['get'] },
    { apiGroups: ['authorization.k8s.io'], resources: ['selfsubjectaccessreviews', 'selfsubjectrulesreviews'], verbs: ['create'] },
    { apiGroups: ['authentication.k8s.io'], resources: ['selfsubjectreviews'], verbs: ['create'] },
  ] };
  assert.ok(await importKubernetesCredentials(home, command));
  assert.equal(isSafeInheritedKubernetesRules([{ nonResourceURLs: ['/*'], verbs: ['get'] }]), false);
  assert.equal(isSafeInheritedKubernetesRules([{ apiGroups: ['authorization.k8s.io'], resources: ['subjectaccessreviews'], verbs: ['create'] }]), false);
  assert.equal(isSafeInheritedKubernetesRules([{ apiGroups: [''], resources: ['pods/exec'], verbs: ['create'] }]), false);
  assert.equal(isSafeInheritedKubernetesRules([{ apiGroups: [''], resources: ['pods'], verbs: ['patch'] }]), false);
});

test('aggregated inherited roles are rejected and bindings for unrelated subjects do not grant access', async t => {
  const { home, state, command } = await fixture(t);
  state.clusterBindings.push(extraBinding({ kind: 'Group', name: 'unrelated-team' }));
  state.inherited['clusterrole:additional-role:'] = { aggregationRule: {}, rules: [{ apiGroups: ['*'], resources: ['*'], verbs: ['*'] }] };
  assert.ok(await importKubernetesCredentials(home, command));
  state.clusterBindings[0].subjects = [{ kind: 'Group', name: 'system:serviceaccounts' }];
  await assert.rejects(importKubernetesCredentials(home, command), safeFailure);
});

test('expired, nearly expired, malformed or empty tokens are rejected without a host credential fallback', async t => {
  for (const status of [
    { token: 'restricted', expirationTimestamp: new Date(Date.now() - 1000).toISOString() },
    { token: 'restricted', expirationTimestamp: new Date(Date.now() + 60_000).toISOString() },
    { token: '', expirationTimestamp: new Date(Date.now() + 3_600_000).toISOString() },
    { token: 'restricted\nmalformed', expirationTimestamp: new Date(Date.now() + 3_600_000).toISOString() },
    { token: 'restricted', expirationTimestamp: 'invalid' },
  ]) {
    const { home, state, command } = await fixture(t); state.tokens.common = { status };
    await assert.rejects(importKubernetesCredentials(home, command), safeFailure);
  }
});

test('missing config skips all commands; invalid endpoints, context references and CLI errors stay generic', async t => {
  const { home, path, state, command, calls } = await fixture(t);
  await rm(path); assert.equal(await importKubernetesCredentials(home, command), undefined); assert.equal(calls.length, 0);
  await writeFile(path, 'synthetic');
  for (const endpoint of ['http://cluster.example.test', `https://user:${originalPassword}@cluster.example.test`, 'file:///private/cluster', 'https://cluster.example.test?token=private']) {
    state.config = sourceConfig(); state.config.clusters[0].cluster.server = endpoint;
    await assert.rejects(importKubernetesCredentials(home, command), safeFailure);
  }
  state.config = sourceConfig(); state.config.contexts[0].context.cluster = 'missing';
  await assert.rejects(importKubernetesCredentials(home, command), safeFailure);
  state.config = sourceConfig(); state.commandFailure = `stderr ${originalKey} token ${originalToken}`;
  await assert.rejects(importKubernetesCredentials(home, command), safeFailure);
});
