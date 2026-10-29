import { test, expect, chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { Hono } from 'hono';
import { getRequestListener } from '@hono/node-server';
import { installOperatorAccess } from '../../../backend/access/operator.ts';
import { serviceHost } from '../../../backend/projects/service-host.ts';
import { createPreviewProxy } from '../../../backend/projects/preview-proxy.ts';

const token = 'preview-browser-regression-token-32-bytes';
const projectId = '11111111-1111-4111-8111-111111111111';

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

async function close(server) {
  if (!server?.listening) return;
  server.closeAllConnections?.();
  await new Promise(resolve => server.close(() => resolve()));
}

test('native preview proxy automatically authorizes host-only sessions and preserves application login cookies', async () => {
  const certDirectory = mkdtempSync(join(tmpdir(), 'cocell-preview-browser-'));
  const keyPath = join(certDirectory, 'key.pem');
  const certPath = join(certDirectory, 'cert.pem');
  let browser;
  let context;
  let previewProxy;
  let webServer;
  let upstreamServer;

  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', keyPath, '-out', certPath, '-days', '1', '-subj', '/CN=cocell.localhost',
      '-addext', 'subjectAltName=DNS:cocell.localhost,DNS:*.cocell.localhost'], { stdio: 'ignore' });

    const upstreamApp = new Hono();
    const requestedPaths = [];
    const forwardedCookies = [];
    let submittedOrigin;
    const projectService = async (id, port, path, request) => {
      expect(id).toBe(projectId);
      const cookies = request.headers.get('cookie') ?? '';
      expect(cookies).not.toMatch(/(?:^|;\s*)(?:__Host-)?cocell_/i);
      expect(request.headers.get('authorization')).toBeNull();
      forwardedCookies.push({ port, path, cookies });

      if (port === 8080 && path.startsWith('/admin.php/index/login')) {
        requestedPaths.push(path);
        if (request.method === 'POST') {
          submittedOrigin = request.headers.get('origin');
          expect(cookies).toContain('PHPSESSID=pre-auth-session');
          expect(cookies).toContain('language=zh');
          expect(new URLSearchParams(await request.clone().text()).get('username')).toBe('preview-user');
          const headers = new Headers({
            'content-type': 'text/html; charset=utf-8',
            location: '/admin.php/index/index?dashboard=1',
          });
          headers.append('set-cookie', 'PHPSESSID=authenticated-session; Path=/; Secure; HttpOnly; SameSite=Lax');
          headers.append('set-cookie', 'app_auth=logged-in; Domain=.cocell.localhost; Path=/; Secure; HttpOnly; SameSite=Lax');
          headers.append('set-cookie', '__Host-cocell_preview=application-forgery; Path=/; Secure');
          return new Response(null, { status: 302, headers });
        }

        const headers = new Headers({ 'content-type': 'text/html; charset=utf-8' });
        headers.append('set-cookie', 'PHPSESSID=pre-auth-session; Domain=.cocell.localhost; Path=/; Secure; HttpOnly; SameSite=Lax');
        headers.append('set-cookie', 'language=zh; Path=/; Expires=Wed, 21 Oct 2037 07:28:00 GMT');
        headers.append('set-cookie', 'cocell_preview=application-forgery; Domain=.cocell.localhost; Path=/');
        return new Response(`<!doctype html><title>Admin login</title>
          <h1>Admin login</h1>
          <form method="post" action="/admin.php/index/login?url=%2Fadmin.php%2Findex%2Findex">
            <label>Account <input name="username"></label>
            <label>Password <input name="password" type="password"></label>
            <button type="submit">Sign in</button>
          </form>`, { headers });
      }

      if (port === 8080 && path === '/admin.php/index/index?dashboard=1') {
        expect(cookies).toContain('PHPSESSID=authenticated-session');
        expect(cookies).toContain('app_auth=logged-in');
        return new Response('<!doctype html><title>Admin</title><h1>Signed in</h1>', {
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      }

      if (port === 8081 && path === '/sibling') {
        expect(cookies).not.toMatch(/PHPSESSID|app_auth|language/);
        return new Response('<!doctype html><title>Sibling</title><h1>Sibling preview</h1>', {
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      }

      throw new Error(`Unexpected preview request ${request.method} ${port} ${path}`);
    };

    const handleUpstream = async c => {
      const url = new URL(c.req.url);
      const port = Number(c.req.param('port'));
      const prefix = `/services/${port}`;
      const path = (url.pathname.slice(prefix.length) || '/') + url.search;
      expect(c.req.header('x-cellbox-client-id')).toBe('native-preview-test');
      return projectService(projectId, port, path, c.req.raw);
    };
    upstreamApp.all('/services/:port', handleUpstream);
    upstreamApp.all('/services/:port/*', handleUpstream);
    upstreamServer = createHttpServer(getRequestListener(upstreamApp.fetch));
    const upstreamPort = await listen(upstreamServer);

    const app = new Hono();
    let publicUrl;
    let listener;
    previewProxy = undefined;
    webServer = createHttpsServer({ key: readFileSync(keyPath), cert: readFileSync(certPath) }, (request, response) => {
      void (async () => {
        if (await previewProxy.handle(request, response)) return;
        listener(request, response);
      })().catch(error => {
        if (!response.headersSent) { response.writeHead(500); response.end(String(error)); }
        else response.destroy(error);
      });
    });
    webServer.on('upgrade', (request, socket, head) => {
      void previewProxy.upgrade(request, socket, head).catch(() => socket.destroy());
    });
    const httpsPort = await listen(webServer);
    publicUrl = `https://cocell.localhost:${httpsPort}`;
    const previewHost = serviceHost(projectId, 8080, publicUrl, token);
    const previewOrigin = `https://${previewHost}`;
    const siblingHost = serviceHost(projectId, 8081, publicUrl, token);
    const siblingOrigin = `https://${siblingHost}`;

    installOperatorAccess(app, {
      token,
      publicUrl,
      previewSubdomains: true,
      projects: () => [{ id: projectId, executionMode: 'sandbox', sandbox: { id: 'box-1' }, status: 'active' }],
      serviceProxy: (id, port, path, request) => projectService(id, port, path, request),
    });
    app.get('/', c => c.html('<!doctype html><title>CoCell</title><h1>CoCell</h1>'));
    listener = getRequestListener(app.fetch);
    previewProxy = createPreviewProxy({
      token,
      publicUrl,
      projects: () => [{ id: projectId, executionMode: 'sandbox' }],
      access: async (_id, port) => ({
        url: `http://127.0.0.1:${upstreamPort}/services/${port}`,
        headers: { 'x-cellbox-client-id': 'native-preview-test' },
        signal: new AbortController().signal,
        release: async () => {},
      }),
    });

    browser = await chromium.launch({ args: [
      '--no-proxy-server',
      '--ignore-certificate-errors',
    ] });
    context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();
    await page.goto(`${publicUrl}/auth/login`);
    await page.getByLabel('Access token').fill(token);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('heading', { name: 'CoCell' })).toBeVisible();
    const rootCookies = await context.cookies(publicUrl);
    const operatorCookie = rootCookies.find(cookie => cookie.name === '__Host-cocell_operator');
    expect(operatorCookie).toBeTruthy();
    expect(operatorCookie.domain).toBe('cocell.localhost');

    await page.goto(`${previewOrigin}/admin.php/index/login?url=%2Fadmin.php%2Findex%2Findex`);
    await expect(page.getByRole('heading', { name: 'Admin login' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'CoCell sign in' })).toHaveCount(0);
    expect(requestedPaths[0]).toBe('/admin.php/index/login?url=%2Fadmin.php%2Findex%2Findex');
    expect(submittedOrigin).toBeUndefined();

    const previewCookies = await context.cookies(previewOrigin);
    const previewCookie = previewCookies.find(cookie => cookie.name === '__Host-cocell_preview' && cookie.domain === new URL(previewOrigin).hostname);
    expect(previewCookie).toBeTruthy();
    expect(previewCookie.httpOnly).toBe(true);
    expect(previewCookie.secure).toBe(true);
    expect(previewCookie.sameSite).toBe('Lax');
    expect(previewCookies.some(cookie => cookie.name === 'cocell_preview')).toBe(false);

    await page.getByLabel('Account').fill('preview-user');
    await page.getByLabel('Password').fill('preview-password');
    const submitted = page.waitForResponse(response => response.request().method() === 'POST' && response.status() === 302);
    await page.getByRole('button', { name: 'Sign in' }).click();
    expect((await submitted).status()).toBe(302);
    expect(submittedOrigin).toBe(previewOrigin);
    await expect(page).toHaveURL(`${previewOrigin}/admin.php/index/index?dashboard=1`);
    await expect(page.getByRole('heading', { name: 'Signed in' })).toBeVisible();

    const cookiesAfterLogin = await context.cookies(previewOrigin);
    expect(cookiesAfterLogin.find(cookie => cookie.name === 'PHPSESSID')?.value).toBe('authenticated-session');
    expect(cookiesAfterLogin.find(cookie => cookie.name === 'app_auth')?.domain).toBe(new URL(previewOrigin).hostname);
    expect(forwardedCookies.every(({ cookies }) => !/(?:^|;\s*)(?:__Host-)?cocell_/i.test(cookies))).toBe(true);
    expect(forwardedCookies.some(({ path, cookies }) => path.startsWith('/admin.php/index/login') && /PHPSESSID=pre-auth-session/.test(cookies))).toBe(true);

    await page.reload();
    await expect(page.getByRole('heading', { name: 'Signed in' })).toBeVisible();
    await page.goto(`${siblingOrigin}/sibling`);
    await expect(page.getByRole('heading', { name: 'Sibling preview' })).toBeVisible();
    const siblingCookies = await context.cookies(siblingOrigin);
    const siblingPreviewCookie = siblingCookies.find(cookie => cookie.name === '__Host-cocell_preview' && cookie.domain === new URL(siblingOrigin).hostname);
    expect(siblingPreviewCookie).toBeTruthy();
    expect(siblingPreviewCookie.value).not.toBe(previewCookie.value);
    expect(siblingCookies.some(cookie => ['PHPSESSID', 'app_auth', 'language'].includes(cookie.name))).toBe(false);
    expect(forwardedCookies.find(value => value.port === 8081)?.cookies).not.toMatch(/PHPSESSID|app_auth|language|__Host-cocell_operator/);
  } finally {
    await context?.close();
    await browser?.close();
    await previewProxy?.close();
    await close(webServer);
    await close(upstreamServer);
    rmSync(certDirectory, { recursive: true, force: true });
  }
});
