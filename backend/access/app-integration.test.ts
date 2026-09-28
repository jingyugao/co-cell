import assert from 'node:assert/strict';
import test from 'node:test';
import type { AppConfig } from '../../protocol/types.js';
import { createApp } from '../app.js';

const token = 'operator-test-token-with-at-least-32-characters';
const publicUrl = 'https://cocell.example.test';

test('Cellbox mode protects existing API routes, accepts its HTTPS origin, and disables the Docker subdomain proxy', async () => {
  let proxyCalls = 0;
  const manager = { dataDirectory: '/tmp/cocell-access-test', sandboxProxyHost: async () => { proxyCalls++; return 'legacy-box'; },
    listProjects: () => [] };
  const app = createApp(manager as never, { sandbox: { enabled: true } } as AppConfig,
    ['localhost:3000', 'cocell.example.test'], { read: async () => ({ enabled: true, fetchedAt: '', sandboxes: [] }) },
    undefined, undefined, undefined, {
      token, publicUrl, projects: () => [],
      provider: {
        async getAccessRequest() { throw new Error('unused'); },
        async approveAccessRequest() { throw new Error('unused'); },
      },
    });
  assert.equal((await app.request(`${publicUrl}/api/config`)).status, 401);
  assert.equal((await app.request(`${publicUrl}/api/config`, { headers: {
    authorization: `Bearer ${token}`, origin: publicUrl,
  } })).status, 200);
  assert.equal((await app.request(`${publicUrl}/api/config`, { headers: {
    authorization: `Bearer ${token}`, origin: 'https://foreign.example.test',
  } })).status, 403);
  const legacyHost = '11111111-1111-4111-8111-111111111111.3000.cocell.example.test';
  assert.equal((await app.request(`https://${legacyHost}/preview`, { headers: {
    authorization: `Bearer ${token}`,
  } })).status, 403);
  assert.equal(proxyCalls, 0);
});

test('legacy mode keeps its local API host check', async () => {
  const app = createApp({ dataDirectory: '/tmp/cocell-access-test' } as never, {} as AppConfig, ['localhost:3000'],
    { read: async () => ({ enabled: true, fetchedAt: '', sandboxes: [] }) });
  assert.equal((await app.request('http://localhost:3000/api/config', { headers: {
    host: 'localhost:3000',
  } })).status, 200);
  assert.equal((await app.request('http://foreign.example/api/config', { headers: {
    host: 'foreign.example',
  } })).status, 403);
});

test('Cellbox service preview requires operator access and isolates sandbox headers', async () => {
  const projectId = '11111111-1111-4111-8111-111111111111';
  const manager = {
    dataDirectory: '/tmp/cocell-access-test', listProjects: () => [],
    async projectService(id: string, port: number, path: string, request: Request) {
      assert.equal(id, projectId);
      assert.equal(port, 8765);
      assert.equal(path, '/verify.txt?check=1');
      assert.equal(request.method, 'GET');
      return new Response('verified', { headers: { 'Content-Type': 'text/plain', 'Set-Cookie': 'sandbox=unsafe' } });
    },
  };
  const app = createApp(manager as never, { sandbox: { enabled: true } } as AppConfig,
    ['cocell.example.test'], { read: async () => ({ enabled: true, fetchedAt: '', sandboxes: [] }) },
    undefined, undefined, undefined, {
      token, publicUrl, projects: () => [],
      provider: {
        async getAccessRequest() { throw new Error('unused'); },
        async approveAccessRequest() { throw new Error('unused'); },
      },
    });
  const path = `${publicUrl}/api/projects/${projectId}/service/8765/verify.txt?check=1`;
  assert.equal((await app.request(path)).status, 401);
  const response = await app.request(path, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'verified');
  assert.equal(response.headers.get('set-cookie'), null);
  assert.match(response.headers.get('content-security-policy') ?? '', /^sandbox /);
});
