import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import test from 'node:test';
import { DockerRegistryClient, normalizeRepository, registryImageReference } from './registry.js';

async function registry(handler: (request: IncomingMessage, response: ServerResponse, origin: string) => void) {
  let origin = '';
  const server = createServer((request, response) => handler(request, response, origin));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { origin, repository: `${origin}/team/dev`, close: async () => {
    server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  } };
}
const json = (response: ServerResponse, body: unknown) => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(body)); };

test('registry references preserve hosts and reject tagged repositories or URL credentials', () => {
  assert.equal(normalizeRepository('node'), 'docker.io/library/node');
  assert.equal(normalizeRepository('team/dev'), 'docker.io/team/dev');
  assert.equal(normalizeRepository('hub.docker.com/r/gaojingyu628/cocell-demo'), 'docker.io/gaojingyu628/cocell-demo');
  assert.equal(normalizeRepository('https://hub.docker.com/r/team/dev/tags?page=2'), 'docker.io/team/dev');
  assert.equal(normalizeRepository('https://hub.docker.com/_/node'), 'docker.io/library/node');
  assert.equal(normalizeRepository('registry:5000/team/dev'), 'registry:5000/team/dev');
  assert.equal(normalizeRepository('http://localhost:5000/team/dev'), 'http://localhost:5000/team/dev');
  assert.equal(registryImageReference('http://localhost:5000/team/dev', 'v1'), 'localhost:5000/team/dev:v1');
  for (const input of ['node:v1', 'team/dev:v1', 'team/dev@sha256:abc', 'https://u:p@registry.test/team/dev', 'registry.test/team/../dev', 'registry.test/team/dev?token=secret', 'ftp://registry.test/dev']) assert.throws(() => normalizeRepository(input));
});

test('private registry pagination and digest resolution fetch metadata only', async () => {
  const calls: string[] = [];
  const digest = `sha256:${'a'.repeat(64)}`;
  const server = await registry((request, response, origin) => {
    calls.push(`${request.method} ${request.url}`);
    if (request.headers.authorization !== `Basic ${Buffer.from('reader:token').toString('base64')}`) {
      response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="registry"' }); response.end(); return;
    }
    const url = new URL(request.url!, origin);
    if (url.pathname.endsWith('/tags/list')) {
      if (!url.searchParams.get('last')) {
        response.setHeader('Link', '</v2/team/dev/tags/list?n=2&last=v2>; rel="next"'); json(response, { tags: ['v1', 'v2'] });
      } else json(response, { tags: ['v3'] });
      return;
    }
    assert.equal(url.pathname, '/v2/team/dev/manifests/v1');
    response.setHeader('Docker-Content-Digest', digest); response.end();
  });
  try {
    const client = new DockerRegistryClient(); const auth = { username: 'reader', password: 'token' };
    assert.deepEqual(await client.listTags(server.repository, auth, { limit: 2 }), { tags: ['v1', 'v2'], next: 'v2' });
    assert.deepEqual(await client.listTags(server.repository, auth, { limit: 2, last: 'v2' }), { tags: ['v3'] });
    assert.equal(await client.resolveTag(server.repository, 'v1', auth), digest);
    assert.ok(calls.every(call => !call.includes('/blobs/')));
    assert.equal(calls.filter(call => call.startsWith('HEAD')).length, 2);
  } finally { await server.close(); }
});

test('Bearer authentication requests only repository pull scope and supports manifest fallback', async () => {
  const manifest = JSON.stringify({ schemaVersion: 2, config: { digest: `sha256:${'a'.repeat(64)}` }, layers: [] });
  const server = await registry((request, response, origin) => {
    const url = new URL(request.url!, origin);
    if (url.pathname === '/token') {
      assert.equal(url.searchParams.get('scope'), 'repository:team/dev:pull');
      assert.equal(request.headers.authorization, `Basic ${Buffer.from('user:secret').toString('base64')}`);
      json(response, { access_token: 'temporary-token' }); return;
    }
    if (request.headers.authorization !== 'Bearer temporary-token') {
      response.writeHead(401, { 'WWW-Authenticate': `Bearer realm="${origin}/token",service="registry",scope="repository:unrelated/repo:push"` }); response.end(); return;
    }
    if (request.method === 'HEAD') { response.writeHead(405); response.end(); return; }
    response.end(manifest);
  });
  try {
    assert.equal(await new DockerRegistryClient().resolveTag(server.repository, 'v1', { username: 'user', password: 'secret' }),
      `sha256:${createHash('sha256').update(manifest).digest('hex')}`);
  } finally { await server.close(); }
});

test('untrusted pagination and credential redirects are rejected without leaking credentials', async () => {
  let mode = 'link';
  const server = await registry((_request, response) => {
    if (mode === 'link') {
      response.setHeader('Link', '<https://unrelated.test/v2/team/dev/tags/list?last=v1>; rel="next"'); json(response, { tags: ['v1'] });
    } else if (mode === 'realm') {
      response.writeHead(401, { 'WWW-Authenticate': 'Bearer realm="http://unrelated.test/token",service="registry"' }); response.end();
    } else { response.writeHead(302, { Location: 'https://unrelated.test/' }); response.end(); }
  });
  try {
    const client = new DockerRegistryClient();
    await assert.rejects(client.listTags(server.repository), /无效的分页地址/);
    mode = 'realm'; await assert.rejects(client.listTags(server.repository, { username: 'user', password: 'secret' }), /不安全的认证地址/);
    mode = 'redirect'; await assert.rejects(client.listTags(server.repository, { username: 'user', password: 'secret' }), /无法查询镜像仓库/);
  } finally { await server.close(); }
});
