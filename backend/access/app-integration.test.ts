import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
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

test('preview subdomain routes a signed project and port and grants browser access without exposing the operator cookie', async () => {
  const projectId = '11111111-1111-4111-8111-111111111111';
  const manager = {
    dataDirectory: '/tmp/cocell-access-test', listProjects: () => [],
    async preview() { return `/api/projects/${projectId}/service/8765/verify.txt?check=1`; },
    async projectService(id: string, port: number, path: string, request: Request) {
      assert.equal(id, projectId);
      assert.equal(port, 8765);
      assert.equal(path, '/verify.txt?check=1');
      if (!request.headers.get('authorization')) assert.equal(request.headers.get('cookie')?.includes('cocell_preview'), true);
      return new Response('verified', { headers: { location: 'http://localhost:8765/next', 'set-cookie': 'app=unsafe' } });
    },
  };
  const app = createApp(manager as never, { sandbox: { enabled: true } } as AppConfig,
    ['cocell.example.test'], { read: async () => ({ enabled: true, fetchedAt: '', sandboxes: [] }) },
    undefined, undefined, undefined, { token, publicUrl, previewSubdomains: true,
      projects: () => [{ id: projectId, executionMode: 'sandbox', sandbox: { id: 'box-1' }, status: 'active' }],
      provider: {
        async getAccessRequest() { throw new Error('unused'); },
        async approveAccessRequest() { throw new Error('unused'); },
      },
    });
  const link = await app.request(`${publicUrl}/api/projects/${projectId}/preview?url=http%3A%2F%2Flocalhost%3A8765%2Fverify.txt%3Fcheck%3D1`,
    { headers: { authorization: `Bearer ${token}` } });
  assert.equal(link.status, 302);
  const serviceUrl = link.headers.get('location')!;
  assert.match(serviceUrl, /^https:\/\/p[0-9a-z]{1,4}-[0-9a-f]{12}\.cocell\.example\.test\/verify\.txt\?check=1$/);
  assert.ok(new URL(serviceUrl).hostname.split('.')[0].length <= 18);
  const bootstrap = await app.request(serviceUrl);
  assert.equal(bootstrap.status, 303);
  assert.match(bootstrap.headers.get('location') ?? '', /^https:\/\/cocell\.example\.test\/auth\/preview\?next=/);
  const signedIn = await app.request(`${publicUrl}/auth/login`, { method: 'POST',
    headers: { origin: publicUrl, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token }).toString() });
  const operatorCookie = signedIn.headers.getSetCookie().find(value => value.startsWith('cocell_operator='))!.split(';')[0];
  const previewGrant = await app.request(bootstrap.headers.get('location')!, { headers: { cookie: operatorCookie } });
  assert.equal(previewGrant.status, 303);
  assert.equal(previewGrant.headers.get('location'), serviceUrl);
  const previewCookie = previewGrant.headers.getSetCookie().find(value => value.startsWith('cocell_preview='))!;
  assert.match(previewCookie, /Domain=cocell\.example\.test/i);
  const response = await app.request(serviceUrl, { headers: { cookie: previewCookie.split(';')[0] } });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'verified');
  assert.equal(response.headers.get('location'), '/next');
  assert.equal(response.headers.get('set-cookie'), null);
  assert.equal(response.headers.get('content-security-policy'), null);
  assert.equal((await app.request(serviceUrl, { headers: { cookie: operatorCookie } })).status, 303);
  assert.equal((await app.request(serviceUrl, { headers: { cookie: previewCookie.split(';')[0], origin: 'https://evil.example' } })).status, 403);
  const tampered = new URL(serviceUrl);
  const label = tampered.hostname.split('.')[0];
  tampered.hostname = `${label.slice(0, -1)}${label.endsWith('0') ? '1' : '0'}.cocell.example.test`;
  assert.equal((await app.request(tampered.href, {
    headers: { authorization: `Bearer ${token}` },
  })).status, 403);
  const oldPayload = projectId.replaceAll('-', '') + (8765).toString(16).padStart(4, '0');
  const oldSignature = createHmac('sha256', token).update(`cocell-service-host-v1\0${oldPayload}`).digest('hex').slice(0, 12);
  const oldUrl = `https://p${oldPayload}${oldSignature}.cocell.example.test/verify.txt?check=1`;
  assert.equal((await app.request(oldUrl, { headers: { authorization: `Bearer ${token}` } })).status, 200);
});
