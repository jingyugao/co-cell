import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { Hono } from 'hono';
import { installOperatorAccess, isAuthenticatedDevRequest, type OperatorAccessOptions } from './operator.js';

const origin = 'https://cocell.example.test';
const token = 'operator-test-token-with-at-least-32-characters';

function setup(overrides: Partial<OperatorAccessOptions> = {}) {
  const calls: string[] = [];
  const access = { id: 'request-1', boxId: 'box-1', callbackUrl: 'https://gateway.example.test/access/callback?state=one',
    expiresAt: new Date(Date.now() + 60_000).toISOString(), approved: false, consumed: false };
  const options: OperatorAccessOptions = {
    token, publicUrl: origin,
    provider: {
      async getAccessRequest(id) { calls.push(`get:${id}`); return access; },
      async approveAccessRequest(id, subject) {
        calls.push(`approve:${id}:${subject}`);
        return { redirectUrl: 'https://gateway.example.test/access/callback?state=two' };
      },
    },
    projects: () => [{ id: 'project-1', executionMode: 'sandbox', sandbox: { id: 'box-1' }, status: 'active' }],
    ...overrides,
  };
  const app = new Hono();
  installOperatorAccess(app, options);
  app.get('/', c => c.text('home'));
  app.get('/page', c => c.html('<!doctype html><title>CoCell</title>'));
  app.get('/api/data', c => c.json({ ok: true }));
  app.post('/api/write', c => c.json({ ok: true }));
  return { app, calls, access };
}

function login(app: Hono, next = '/') {
  return app.request(`${origin}/auth/login`, { method: 'POST',
    headers: { origin, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: 'operator', token, next }).toString(),
  });
}

test('protects UI and API, then issues a signed HttpOnly session', async () => {
  const { app } = setup();
  const ui = await app.request(`${origin}/`);
  assert.equal(ui.status, 303);
  assert.equal(ui.headers.get('location'), '/auth/login?next=%2F');
  const api = await app.request(`${origin}/api/data`);
  assert.equal(api.status, 401);
  assert.deepEqual(await api.json(), { error: 'Authentication required' });
  assert.equal((await app.request(`${origin}/auth/login`)).status, 200);
  const loginPage = await app.request(`${origin}/auth/login`);
  assert.equal(loginPage.headers.get('strict-transport-security'), 'max-age=86400');
  assert.equal(loginPage.headers.get('x-frame-options'), 'DENY');
  assert.equal(loginPage.headers.get('referrer-policy'), 'same-origin');
  assert.match(loginPage.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
  const signedIn = await login(app);
  assert.equal(signedIn.status, 303);
  assert.equal(signedIn.headers.get('location'), '/');
  const cookie = signedIn.headers.get('set-cookie')!;
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /Max-Age=2592000/);
  assert.doesNotMatch(cookie, /Domain=/);
  assert.doesNotMatch(cookie, new RegExp(token));
  const signedExpiry = /^cocell_operator=v1\.(\d+)\./.exec(cookie)?.[1];
  assert.ok(signedExpiry && Number(signedExpiry) > Date.now());
  assert.ok(Number(signedExpiry) <= Date.now() + 30 * 24 * 60 * 60 * 1000);
  assert.equal((await app.request(`${origin}/api/data`, { headers: { cookie } })).status, 200);
  const page = await app.request(`${origin}/page`, { headers: { cookie } });
  assert.match(page.headers.get('content-security-policy') ?? '', /script-src 'self'/);
  assert.match(page.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
  assert.equal((await app.request(`${origin}/api/data`, { headers: { authorization: `Bearer ${token}` } })).status, 200);
  assert.equal((await app.request(`${origin}/api/data`, { headers: {
    cookie, authorization: 'Bearer wrong',
  } })).status, 401);
});

test('renews active sessions daily, accepts legacy sessions, and expires inactive or revoked sessions', async t => {
  const day = 24 * 60 * 60 * 1000;
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const { app } = setup();
  const initialCookie = (await login(app)).headers.get('set-cookie')!.split(';')[0];
  const initialExpiry = Number(initialCookie.split('.')[1]);
  const fresh = await app.request(`${origin}/api/data`, { headers: { cookie: initialCookie } });
  assert.equal(fresh.headers.get('set-cookie'), null);

  now += day;
  const denied = await app.request(`${origin}/api/write`, { method: 'POST', headers: { cookie: initialCookie } });
  assert.equal(denied.status, 403);
  assert.equal(denied.headers.get('set-cookie'), null);
  const bearer = await app.request(`${origin}/api/data`, { headers: { authorization: `Bearer ${token}`, cookie: initialCookie } });
  assert.equal(bearer.headers.get('set-cookie'), null);
  const active = await app.request(`${origin}/api/data`, { headers: { cookie: initialCookie } });
  assert.equal(active.status, 200);
  assert.equal(active.headers.get('cache-control'), 'no-store');
  const renewedCookie = active.headers.get('set-cookie')!.split(';')[0];
  assert.match(active.headers.get('set-cookie')!, /Max-Age=2592000/);
  assert.equal(Number(renewedCookie.split('.')[1]), now + 30 * day);

  const legacyExpiry = String(now + 12 * 60 * 60 * 1000);
  const legacySignature = createHmac('sha256', token).update(`cocell-operator-v1\0${legacyExpiry}`).digest('base64url');
  const legacy = await app.request(`${origin}/api/data`, { headers: { cookie: `cocell_operator=v1.${legacyExpiry}.${legacySignature}` } });
  assert.equal(legacy.status, 200);
  assert.match(legacy.headers.get('set-cookie')!, /Max-Age=2592000/);

  now = initialExpiry;
  const expired = await app.request(`${origin}/api/data`, { headers: { cookie: initialCookie } });
  assert.equal(expired.status, 401);
  assert.equal(expired.headers.get('set-cookie'), null);
  assert.equal((await app.request(`${origin}/api/data`, { headers: { cookie: renewedCookie } })).status, 200);
  const rotated = setup({ token: 'rotated-operator-token-with-at-least-32-characters' });
  const revoked = await rotated.app.request(`${origin}/api/data`, { headers: { cookie: renewedCookie } });
  assert.equal(revoked.status, 401);
  assert.equal(revoked.headers.get('set-cookie'), null);
});

test('an authenticated browser skips the login form and keeps a safe return target', async () => {
  const { app } = setup();
  const cookie = (await login(app)).headers.get('set-cookie')!.split(';')[0];
  for (const [next, expected] of [['/page', '/page'], ['/auth/login', '/'], ['//evil.example/path', '/']]) {
    const response = await app.request(`${origin}/auth/login?next=${encodeURIComponent(next)}`, { headers: { cookie } });
    assert.equal(response.status, 303);
    assert.equal(response.headers.get('location'), expected);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
});

test('rejects tampered cookies, login CSRF, and cookie write CSRF', async () => {
  const { app } = setup();
  for (const requestOrigin of ['https://evil.example', 'null', undefined]) {
    assert.equal((await app.request(`${origin}/auth/login`, { method: 'POST',
      headers: { ...(requestOrigin === undefined ? {} : { origin: requestOrigin }),
        'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }).toString(),
    })).status, 403);
  }
  const cookie = (await login(app)).headers.get('set-cookie')!;
  const pair = cookie.split(';')[0];
  const tampered = pair.slice(0, -1) + (pair.endsWith('A') ? 'B' : 'A');
  assert.equal((await app.request(`${origin}/api/data`, { headers: { cookie: tampered } })).status, 401);
  for (const expires of ['0', String(Date.now() - 1)]) {
    const signature = createHmac('sha256', token).update(`cocell-operator-v1\0${expires}`).digest('base64url');
    assert.equal((await app.request(`${origin}/api/data`, { headers: {
      cookie: `cocell_operator=v1.${expires}.${signature}`,
    } })).status, 401);
  }
  assert.equal((await app.request(`${origin}/api/data`, { headers: { cookie: pair } })).status, 200);
  assert.equal((await app.request(`${origin}/api/write`, { method: 'POST', headers: { cookie: pair } })).status, 403);
  assert.equal((await app.request(`${origin}/api/write`, { method: 'POST',
    headers: { cookie: pair, origin } })).status, 200);
  assert.equal((await app.request(`${origin}/api/write`, { method: 'POST',
    headers: { authorization: `Bearer ${token}` } })).status, 200);
});

test('preserves pending Cellbox request through login and requires a same-origin approval POST', async () => {
  const { app, calls } = setup();
  const pending = await app.request(`${origin}/api/cellbox/authorize?request_id=request-1`);
  assert.equal(pending.status, 303);
  const loginUrl = new URL(pending.headers.get('location')!, origin);
  const next = loginUrl.searchParams.get('next')!;
  assert.equal(next, '/api/cellbox/authorize?request_id=request-1');
  const signedIn = await login(app, next);
  assert.equal(signedIn.headers.get('location'), next);
  const confirmation = await app.request(`${origin}${next}`, { headers: {
    cookie: signedIn.headers.get('set-cookie')!,
  } });
  assert.equal(confirmation.status, 200);
  assert.equal(confirmation.headers.get('referrer-policy'), 'same-origin');
  assert.match(await confirmation.text(), /Approve Sandbox access\?/);
  assert.deepEqual(calls, ['get:request-1']);
  const body = new URLSearchParams({ request_id: 'request-1' }).toString();
  const foreign = await app.request(`${origin}/api/cellbox/authorize`, { method: 'POST', headers: {
    cookie: signedIn.headers.get('set-cookie')!, origin: 'https://evil.example',
    'content-type': 'application/x-www-form-urlencoded',
  }, body });
  assert.equal(foreign.status, 403);
  assert.deepEqual(calls, ['get:request-1']);
  const approved = await app.request(`${origin}/api/cellbox/authorize`, { method: 'POST', headers: {
    cookie: signedIn.headers.get('set-cookie')!, origin,
    'content-type': 'application/x-www-form-urlencoded',
  }, body });
  assert.equal(approved.status, 303);
  assert.equal(approved.headers.get('location'), 'https://gateway.example.test/access/callback?state=two');
  assert.deepEqual(calls, ['get:request-1', 'get:request-1', 'approve:request-1:operator']);
});

test('denies foreign or archived boxes and unsafe callback URLs', async () => {
  const foreign = setup({ projects: () => [{ id: 'project-1', executionMode: 'sandbox',
    sandbox: { id: 'other-box' }, status: 'active' }] });
  const path = `${origin}/api/cellbox/authorize?request_id=request-1`;
  assert.equal((await foreign.app.request(path, { headers: { authorization: `Bearer ${token}` } })).status, 403);
  assert.deepEqual(foreign.calls, ['get:request-1']);
  const archived = setup({ projects: () => [{ id: 'project-1', executionMode: 'sandbox',
    sandbox: { id: 'box-1' }, status: 'archived' }] });
  assert.equal((await archived.app.request(path, { headers: { authorization: `Bearer ${token}` } })).status, 403);
  const unsafe = setup({ provider: {
    async getAccessRequest() { return { id: 'request-1', boxId: 'box-1',
      callbackUrl: 'http://gateway.example.test/access/callback',
      expiresAt: new Date(Date.now() + 60_000).toISOString(), approved: false, consumed: false }; },
    async approveAccessRequest() { throw new Error('must not approve'); },
  } });
  assert.equal((await unsafe.app.request(path, { headers: { authorization: `Bearer ${token}` } })).status, 502);
  const redirected = setup({ provider: {
    async getAccessRequest() { return { id: 'request-1', boxId: 'box-1',
      callbackUrl: 'https://gateway.example.test/access/callback',
      expiresAt: new Date(Date.now() + 60_000).toISOString(), approved: false, consumed: false }; },
    async approveAccessRequest() { return { redirectUrl: 'https://evil.example/access/callback' }; },
  } });
  assert.equal((await redirected.app.request(`${origin}/api/cellbox/authorize`, { method: 'POST',
    headers: { authorization: `Bearer ${token}`, origin, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ request_id: 'request-1' }).toString(),
  })).status, 502);
});

test('configuration and return paths cannot weaken origin checks or add open redirects', async () => {
  assert.throws(() => setup({ token: 'short' }), /at least 32 bytes/);
  assert.throws(() => setup({ publicUrl: 'http://cocell.example.test' }), /HTTPS origin/);
  const { app } = setup();
  assert.equal((await app.request(`${origin}/auth/login`, { headers: { host: 'evil.example' } })).status, 403);
  const response = await login(app, '//evil.example/path');
  assert.equal(response.headers.get('location'), '/');
  const queryToken = await login(app, '/?token=secret');
  assert.equal(queryToken.headers.get('location'), '/');
});

test('Vite receives only authenticated same-host asset reads', async () => {
  const { app } = setup();
  const cookie = (await login(app)).headers.get('set-cookie')!.split(';')[0];
  const request = (url: string, headers: Record<string, string> = {}, method = 'GET') => ({
    url, method, headers: { host: 'cocell.example.test', ...headers },
  });
  assert.equal(isAuthenticatedDevRequest(request('/src/main.ts'), 'cocell.example.test', token), false);
  assert.equal(isAuthenticatedDevRequest(request('/src/main.ts', { cookie }), 'cocell.example.test', token), true);
  assert.equal(isAuthenticatedDevRequest(request('/@vite/client', { authorization: `Bearer ${token}` }),
    'cocell.example.test', token), true);
  assert.equal(isAuthenticatedDevRequest(request('/src/main.ts', { cookie, host: 'other.example.test' }),
    'cocell.example.test', token), false);
  assert.equal(isAuthenticatedDevRequest(request('/api/data', { cookie }), 'cocell.example.test', token), false);
  assert.equal(isAuthenticatedDevRequest(request('/auth/login', { cookie }), 'cocell.example.test', token), false);
  assert.equal(isAuthenticatedDevRequest(request('/src/main.ts', { cookie }, 'POST'),
    'cocell.example.test', token), false);
  assert.equal(isAuthenticatedDevRequest(request('/src/main.ts', { cookie, upgrade: 'websocket' }),
    'cocell.example.test', token), false);
});
