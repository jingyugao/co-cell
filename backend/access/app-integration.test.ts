import assert from 'node:assert/strict';
import test from 'node:test';
import type { AppConfig } from '../../protocol/types.js';
import { createApp } from '../app.js';
import { serviceHost } from '../projects/service-host.js';
import { HttpError } from '../../util/errors.js';

const token = 'operator-test-token-with-at-least-32-characters';
const publicUrl = 'https://cocell.example.test';

test('internal service host reaches tool authorization while preserving grant, origin, and operator checks', async () => {
  const brokerUrl = 'http://co-cell.co-cell.svc.cluster.local.:3001';
  const manager = { dataDirectory: '/tmp/cocell-access-test', listProjects: () => [] };
  let calls = 0;
  const secrets = { async authorize(boxId: string, tool: string, args: string[]) {
    calls++;
    assert.equal(boxId, 'box-one');
    assert.deepEqual(args, ['version', '--client']);
    if (tool !== 'kubectl') throw new HttpError(403, '项目未授权此工具的单文件凭证');
    return { tool, args, home: '/home/debug/11111111-1111-4111-8111-111111111111', path: '.kube/config' };
  } };
  const app = createApp(manager as never, {} as AppConfig, ['cocell.example.test'],
    { read: async () => ({ enabled: true, fetchedAt: '', sandboxes: [] }) },
    undefined, undefined, undefined, { token, publicUrl, projects: () => [] }, undefined, secrets as never);
  const authorize = (tool = 'kubectl', headers = {}, boxId = 'box-one') => app.request(`${brokerUrl}/api/tool-runtime/authorize`, {
    method: 'POST', headers: { host: new URL(brokerUrl).host, 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ boxId, tool, args: ['version', '--client'] }),
  });
  const allowed = await authorize();
  assert.equal(allowed.status, 200);
  assert.equal((await allowed.json()).path, '.kube/config');
  const denied = await authorize('mysql');
  assert.equal(denied.status, 403);
  assert.deepEqual(await denied.json(), { error: '项目未授权此工具的单文件凭证' });
  assert.equal((await authorize('kubectl', {}, 'invalid/box')).status, 400);
  assert.equal((await authorize('kubectl', { origin: 'https://foreign.example.test' })).status, 403);
  assert.equal(calls, 2, 'invalid identities and browser origins must not reach authorization');
  for (const [path, method] of [['/api/config', 'GET'], ['/api/secrets', 'GET'], ['/api/tool-runtime/authorize', 'GET'], ['/api/tool-runtime/other', 'POST']]) {
    const response = await app.request(`${brokerUrl}${path}`, { method, headers: { host: new URL(brokerUrl).host, authorization: `Bearer ${token}` } });
    assert.equal(response.status, 403);
    assert.equal(await response.text(), 'Invalid host');
  }
});

test('Cellbox mode protects existing API routes, accepts its HTTPS origin, and disables the Docker subdomain proxy', async () => {
  let proxyCalls = 0;
  const manager = { dataDirectory: '/tmp/cocell-access-test', sandboxProxyHost: async () => { proxyCalls++; return 'legacy-box'; },
    listProjects: () => [] };
  const app = createApp(manager as never, { sandbox: { enabled: true } } as AppConfig,
    ['localhost:3000', 'cocell.example.test'], { read: async () => ({ enabled: true, fetchedAt: '', sandboxes: [] }) },
    undefined, undefined, undefined, {
      token, publicUrl, projects: () => [],

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

test('project open, resume, and exact status reads use scoped refresh while other APIs keep shared refresh', async () => {
  let refreshes = 0;
  const manager = {
    dataDirectory: '/tmp/cocell-access-test', sharedStateEnabled: true,
    async refreshSharedState() { refreshes++; },
    async readProject(id: string) { return { id }; },
    async enterProject(id: string) { return { id }; },
    async resumeProjectSandbox(id: string) { return { id }; },
    listProjects: () => [],
  };
  const app = createApp(manager as never, {} as AppConfig, ['localhost:3000'],
    { read: async () => ({ enabled: true, fetchedAt: '', sandboxes: [] }) });

  assert.equal((await app.request('http://localhost:3000/api/projects/project-1', { headers: { host: 'localhost:3000' } })).status, 200);
  assert.equal((await app.request('http://localhost:3000/api/projects/project-1?waitForOperation=op-1', { headers: { host: 'localhost:3000' } })).status, 200);
  assert.equal((await app.request('http://localhost:3000/api/projects/project-1/open', { method: 'POST', headers: { host: 'localhost:3000' } })).status, 200);
  assert.equal((await app.request('http://localhost:3000/api/projects/project-1/sandbox/resume', { method: 'POST', headers: { host: 'localhost:3000' } })).status, 200);
  assert.equal(refreshes, 0);

  assert.equal((await app.request('http://localhost:3000/api/config', { headers: { host: 'localhost:3000' } })).status, 200);
  assert.equal(refreshes, 1, 'unmigrated APIs still receive shared-state refresh');
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

    });
  const path = `${publicUrl}/api/projects/${projectId}/service/8765/verify.txt?check=1`;
  assert.equal((await app.request(path)).status, 401);
  const response = await app.request(path, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'verified');
  assert.equal(response.headers.get('set-cookie'), null);
  assert.match(response.headers.get('content-security-policy') ?? '', /^sandbox /);
});

test('preview authorization automatically exchanges a one-use host-bound challenge and preserves application cookies', async () => {
  const projectId = '11111111-1111-4111-8111-111111111111';
  const serviceHostName = serviceHost(projectId, 8765, publicUrl, token);
  const serviceOrigin = `https://${serviceHostName}`;
  const serviceUrl = `${serviceOrigin}/verify.txt?check=1`;
  let proxyCalls = 0;
  const manager = {
    dataDirectory: '/tmp/cocell-access-test', listProjects: () => [],
    async projectService(id: string, port: number, path: string, request: Request) {
      proxyCalls++;
      assert.equal(id, projectId);
      assert.equal(port, 8765);
      assert.equal(path, '/verify.txt?check=1');
      assert.equal(request.headers.get('authorization'), 'Basic application-credential');
      assert.equal(request.headers.get('cookie'), 'app_session=application-cookie');
      const headers = new Headers({ location: 'http://localhost:8765/next' });
      headers.append('set-cookie', 'app_session=refreshed; Domain=cocell.example.test; Path=/; HttpOnly; Secure');
      headers.append('set-cookie', 'app_preference=dark; Path=/; SameSite=Lax');
      headers.append('set-cookie', '__Host-cocell_preview=forged; Path=/; Secure');
      return new Response('verified', { headers });
    },
  };
  const app = createApp(manager as never, { sandbox: { enabled: true } } as AppConfig,
    ['cocell.example.test'], { read: async () => ({ enabled: true, fetchedAt: '', sandboxes: [] }) },
    undefined, undefined, undefined, { token, publicUrl, previewSubdomains: true,
      projects: () => [{ id: projectId, executionMode: 'sandbox', sandbox: { id: 'box-1' }, status: 'active' }],

    });

  const bootstrap = await app.request(serviceUrl);
  assert.equal(bootstrap.status, 303);
  const challengeCookie = bootstrap.headers.getSetCookie().find(value => value.startsWith('__Host-cocell_preview_challenge='));
  assert.ok(challengeCookie);
  assert.match(challengeCookie!, /Secure/);
  assert.match(challengeCookie!, /HttpOnly/);
  assert.match(challengeCookie!, /Max-Age=300/);
  assert.doesNotMatch(challengeCookie!, /Domain=/i);
  const challengePair = challengeCookie!.split(';')[0];
  const previewAuthUrl = bootstrap.headers.get('location')!;
  assert.match(previewAuthUrl, /^https:\/\/cocell\.example\.test\/auth\/preview\?next=/);
  assert.match(previewAuthUrl, /challenge=[a-f0-9]{64}/);
  assert.equal((await app.request(serviceUrl, { method: 'POST' })).status, 401);

  const loginGate = await app.request(previewAuthUrl);
  assert.equal(loginGate.status, 303);
  assert.match(loginGate.headers.get('location') ?? '', /^\/auth\/login\?next=/);
  const authPath = new URL(previewAuthUrl).pathname + new URL(previewAuthUrl).search;
  const signedIn = await app.request(`${publicUrl}/auth/login`, { method: 'POST',
    headers: { origin: publicUrl, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token, next: authPath }).toString() });
  assert.equal(signedIn.headers.get('location'), authPath);
  const operatorCookie = signedIn.headers.getSetCookie().find(value => value.startsWith('__Host-cocell_operator='))!.split(';')[0];
  const previewGrant = await app.request(previewAuthUrl, { headers: { cookie: operatorCookie } });
  assert.equal(previewGrant.status, 303);
  const callbackUrl = previewGrant.headers.get('location')!;
  assert.match(callbackUrl, new RegExp(`^${serviceOrigin.replaceAll('.', '\\.')}\\/__cocell/preview/callback\\?code=[A-Za-z0-9_-]{43}$`));
  assert.ok(previewGrant.headers.getSetCookie().some(value => value.startsWith('cocell_preview=') && /Max-Age=0/.test(value)));
  assert.ok(signedIn.headers.getSetCookie().some(value => value.startsWith('cocell_preview=') && /Max-Age=0/.test(value)));

  const wrongHost = serviceHost(projectId, 8766, publicUrl, token);
  const wrongHostAttempt = await app.request(`https://${wrongHost}${new URL(callbackUrl).pathname}${new URL(callbackUrl).search}`,
    { headers: { cookie: challengePair } });
  assert.equal(wrongHostAttempt.status, 403);
  const missingChallenge = await app.request(callbackUrl);
  assert.equal(missingChallenge.status, 403);
  assert.equal(proxyCalls, 0);

  const callback = await app.request(callbackUrl, { headers: { cookie: challengePair } });
  assert.equal(callback.status, 303);
  assert.equal(callback.headers.get('location'), '/verify.txt?check=1');
  const previewCookie = callback.headers.getSetCookie().find(value => value.startsWith('__Host-cocell_preview='))!;
  assert.match(previewCookie, /Secure/);
  assert.match(previewCookie, /HttpOnly/);
  assert.match(previewCookie, /SameSite=Lax/);
  assert.match(previewCookie, /Max-Age=10800/);
  assert.doesNotMatch(previewCookie, /Domain=/i);
  const replay = await app.request(callbackUrl, { headers: { cookie: challengePair } });
  assert.equal(replay.status, 403);

  const response = await app.request(serviceUrl, { headers: {
    cookie: `${operatorCookie}; ${previewCookie.split(';')[0]}; app_session=application-cookie`,
    authorization: 'Basic application-credential', origin: serviceOrigin,
  } });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'verified');
  assert.equal(response.headers.get('location'), '/next');
  assert.deepEqual(response.headers.getSetCookie().map(value => value.split(';')[0]), [
    'app_session=refreshed', 'app_preference=dark',
  ]);
  assert.ok(response.headers.getSetCookie().every(value => !/Domain=/i.test(value)));
  assert.equal(response.headers.get('content-security-policy'), null);
  assert.equal(response.headers.get('x-frame-options'), null);
  assert.equal(response.headers.get('referrer-policy'), 'same-origin');
});

test('preview grants cross API instances and discover projects created on another instance', async () => {
  const { Hono } = await import('hono');
  const { installOperatorAccess, isAuthenticatedPreviewRequest } = await import('./operator.js');
  const { MemoryPreviewGrantStore } = await import('./preview-grants.js');
  const projectId = '22222222-2222-4222-8222-222222222222';
  const host = serviceHost(projectId, 8080, publicUrl, token);
  const store = new MemoryPreviewGrantStore();
  let visibleOnB = false;
  let refreshes = 0;
  const project = { id: projectId, executionMode: 'sandbox', sandbox: { id: 'box-shared' }, status: 'active' };
  const appA = new Hono(), appB = new Hono();
  const options = { token, publicUrl, previewSubdomains: true, previewGrants: store,
    serviceProxy: async () => new Response('app') };
  installOperatorAccess(appA, { ...options, projects: () => [project] });
  installOperatorAccess(appB, { ...options, projects: () => visibleOnB ? [project] : [],
    refreshProjects: async () => { refreshes++; visibleOnB = true; } });
  const start = await appB.request(`https://${host}/login?next=%2Fdashboard`);
  assert.equal(start.status, 303);
  assert.equal(refreshes, 1);
  const challenge = start.headers.getSetCookie().find(cookie => cookie.startsWith('__Host-cocell_preview_challenge='))!.split(';')[0];
  const grant = await appA.request(start.headers.get('location')!, { headers: { authorization: `Bearer ${token}` } });
  const finish = await appB.request(grant.headers.get('location')!, { headers: { cookie: challenge } });
  assert.equal(finish.status, 303);
  assert.equal(finish.headers.get('location'), '/login?next=%2Fdashboard');
  assert.equal(finish.headers.get('referrer-policy'), 'no-referrer');
  const cookie = finish.headers.getSetCookie().find(value => value.startsWith('__Host-cocell_preview='))!.split(';')[0];
  assert.equal(isAuthenticatedPreviewRequest(new Headers({ cookie }), host, token), true);
  assert.equal((await appA.request(grant.headers.get('location')!, { headers: { cookie: challenge } })).status, 403);
});
