import assert from 'node:assert/strict';
import test from 'node:test';
import { authorizeCredential, describeTool, getTool, hasCredentials } from './index.js';
import { validateToolArgs } from '../secrets/policy.js';
import type { CredentialSource } from './interfaces.js';

const mysqlSource: CredentialSource = { id: 'source', name: 'Database credentials', version: 1,
  content: '[doris]\nuser=reports\npassword=synthetic-private\n[production]\nuser=production\npassword=another-private\n' };
const kubeSource: CredentialSource = { id: 'source', name: 'Cluster credentials', version: 1, content: JSON.stringify({
  apiVersion: 'v1', kind: 'Config', clusters: [{ name: 'cluster', cluster: { server: 'https://cluster.example.test' } }],
  users: [], contexts: ['test', 'production'].map(name => ({ name, context: { cluster: 'cluster' } })), 'current-context': 'test',
}) };

function credentialAdapter(name: string) {
  const adapter = getTool(name);
  assert(hasCredentials(adapter));
  return adapter;
}

test('generic tools expose an access switch and preserve native CLI arguments', () => {
  const tool = getTool('lark-cli');
  assert.deepEqual(describeTool(tool, []), { name: 'lark-cli', kind: 'tool' });
  assert.throws(() => tool.authorize({ tool: tool.name, enabled: false }), /未授权/);
  tool.authorize({ tool: tool.name, enabled: true });
  const args = ['api', '--input', 'body.json', '--profile', 'my.profile'];
  assert.deepEqual(validateToolArgs(tool.name, args), args);
  assert.throws(() => validateToolArgs(tool.name, ['x'.repeat(8193)]), /参数超出限制/);
});

test('a single MySQL file exposes independently selectable native credential names', () => {
  const tool = credentialAdapter('mysql');
  const catalog = tool.listCredentials([mysqlSource]);
  assert.deepEqual(catalog.names, ['doris', 'production']);
  assert.equal(catalog.defaultName, undefined);
  const description = describeTool(tool, [mysqlSource]);
  assert(!JSON.stringify(description).includes('synthetic-private'));
  assert(!JSON.stringify(description).includes('source'));
  const permission = { tool: tool.name, enabled: true, credentials: ['doris'] };
  tool.authorize(permission);
  assert.deepEqual(authorizeCredential(tool, permission, validateToolArgs('mysql', ['--login-path=doris', '--version'])), ['--login-path=doris', '--version']);
  assert.throws(() => authorizeCredential(tool, permission, validateToolArgs('mysql', ['--login-path=production', '--version'])), /未授权.*production/);
  assert.throws(() => authorizeCredential(tool, permission, validateToolArgs('mysql', ['--login-path=missing', '--version'])), /未授权.*missing/);
  assert.deepEqual(authorizeCredential(tool, { ...permission, credentials: ['missing'] }, ['--login-path=missing', '--version']), ['--login-path=missing', '--version'],
    'an authorized name reaches the CLI even when it is absent from the discovered catalog');
  assert.throws(() => tool.authorize({ tool: tool.name, enabled: true, credentials: [] }), /未授权/);
});

test('explicit empty or repeated credential selectors cannot become a version bypass', () => {
  for (const [name, option, args] of [['mysql', '--login-path', ['--version']], ['kubectl', '--context', ['version', '--client']]] as const) {
    const adapter = credentialAdapter(name);
    for (const selector of [[option], [option + '='], [option, '--help'], [option + '=test', option + '=production']])
      assert.throws(() => adapter.validateArgs([...args, ...selector]), /缺失、重复或无效/);
  }
});

test('kubectl discovers defaults for display but authorizes only an explicit context', () => {
  const tool = credentialAdapter('kubectl');
  const current = Buffer.from(JSON.stringify({ ...JSON.parse(kubeSource.content), 'current-context': 'production' }));
  const catalog = tool.listCredentials([kubeSource], current);
  assert.equal(catalog.defaultName, 'production');
  const permission = { tool: tool.name, enabled: true, credentials: ['test'] };
  assert.throws(() => authorizeCredential(tool, permission, ['get', 'pods']), /--context/);
  assert.throws(() => authorizeCredential(tool, permission, ['--context=production', 'version', '--client']), /未授权.*production/);
  assert.deepEqual(authorizeCredential(tool, permission, ['--context', 'test', 'get', 'pods']), ['--context=test', 'get', 'pods']);
  const allowedDefault = { ...permission, credentials: ['production'] };
  assert.throws(() => authorizeCredential(tool, allowedDefault, ['get', 'pods']), /--context/);
  assert.deepEqual(authorizeCredential(tool, { ...permission, credentials: ['missing'] }, ['--context=missing', 'get', 'pods']), ['--context=missing', 'get', 'pods']);
  const nativeEdited = JSON.parse(kubeSource.content);
  nativeEdited.contexts.push({ name: 'added-by-cli', context: { cluster: 'cluster' } });
  assert(tool.listCredentials([kubeSource], Buffer.from(JSON.stringify(nativeEdited))).names.includes('added-by-cli'));
});

test('runtime commands require a selector even if discovery reports a default', () => {
  const mysql = credentialAdapter('mysql'), kube = credentialAdapter('kubectl');
  assert.equal(mysql.listCredentials([{ ...mysqlSource, content: '[only]\nuser=synthetic' }]).defaultName, 'only');
  assert.throws(() => mysql.resolveCredential(['-e', 'SELECT 1']), /login-path/);
  const missingDefault = Buffer.from(JSON.stringify({ ...JSON.parse(kubeSource.content), 'current-context': '' }));
  const kubeCatalog = kube.listCredentials([kubeSource], missingDefault);
  assert.equal(kubeCatalog.defaultName, undefined);
  assert.throws(() => kube.resolveCredential(['get', 'pods']), /--context/);
  assert.throws(() => kube.resolveCredential(['exec', 'pod', '--', 'version', '--client']), /--context/);
  const permission = { tool: 'mysql', enabled: true, credentials: ['doris'] };
  assert.deepEqual(authorizeCredential(mysql, permission, ['--version']), ['--version']);
});
