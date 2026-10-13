import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { setCookie } from 'hono/cookie';
import { parseServiceHost } from '../projects/service-host.js';
import { MemoryPreviewGrantStore, type PreviewGrantStore } from './preview-grants.js';
import { isPublicPwaAsset } from '../../util/pwa-assets.js';

const COOKIE = 'cocell_operator';
export const PREVIEW_COOKIE = '__Host-cocell_preview';
const CHALLENGE_COOKIE = '__Host-cocell_preview_challenge';
export const PREVIEW_CALLBACK = '/__cocell/preview/callback';
const PREVIEW_TTL_MS = 3 * 60 * 60 * 1000;
const MAX_LOGIN_BYTES = 4096;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SESSION_RENEW_INTERVAL_MS = 24 * 60 * 60 * 1000;
export interface OperatorAccessOptions {
  token: string;
  publicUrl: string;
  previewSubdomains?: boolean;
  previewGrants?: PreviewGrantStore;
  refreshProjects?: () => Promise<void>;
  serviceProxy?: (projectId: string, port: number, path: string, request: Request) => Promise<Response>;
  projects: () => Array<{
    id: string;
    executionMode: string;
    sandbox?: { id: string };
    status?: string;
  }>;
}

function fixedEqual(a: string, b: string): boolean {
  const left = createHash('sha256').update(a).digest();
  const right = createHash('sha256').update(b).digest();
  return timingSafeEqual(left, right);
}

function sessionSignature(token: string, expires: string, scope = 'operator'): string {
  return createHmac('sha256', token).update(`cocell-${scope}-v1\0${expires}`).digest('base64url');
}

function sessionExpiry(value: string | undefined, token: string, scope = 'operator'): number | undefined {
  if (!value) return undefined;
  const parts = /^v1\.(\d{1,13})\.([A-Za-z0-9_-]{43})$/.exec(value);
  if (!parts) return undefined;
  const expires = Number(parts[1]);
  if (!Number.isSafeInteger(expires) || expires <= Date.now()) return undefined;
  return fixedEqual(parts[2], sessionSignature(token, parts[1], scope)) ? expires : undefined;
}

type AuthHeaders = Headers | { authorization?: string | string[]; cookie?: string | string[] };

function header(headers: AuthHeaders, name: 'authorization' | 'cookie'): string | undefined {
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  const value = headers[name];
  return typeof value === 'string' ? value : undefined;
}

function sessionCookie(raw: string | undefined, name = COOKIE): string | undefined {
  const values = raw?.split(';').map(part => part.trim()).filter(part => part.startsWith(`${name}=`)) ?? [];
  return values.length === 1 ? values[0].slice(name.length + 1) : undefined;
}

/** Shared by Hono and the Vite development request gate. */
export function isAuthenticatedOperatorRequest(headers: AuthHeaders, token: string): boolean {
  const authorization = header(headers, 'authorization');
  if (authorization !== undefined) {
    const bearer = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
    return fixedEqual(bearer, token);
  }
  const raw = header(headers, 'cookie');
  const secureCookie = sessionCookie(raw, '__Host-cocell_operator');
  return sessionExpiry(secureCookie ?? sessionCookie(raw), token) !== undefined;
}

/** Application Authorization headers are independent of platform authentication. */
export function isAuthenticatedPreviewRequest(headers: AuthHeaders, host: string, token: string): boolean {
  const authorization = header(headers, 'authorization');
  if (authorization?.startsWith('Bearer ') && fixedEqual(authorization.slice(7), token)) return true;
  return sessionExpiry(sessionCookie(header(headers, 'cookie'), PREVIEW_COOKIE), token, `preview:${host.toLowerCase()}`) !== undefined;
}

/** Vite must only receive authenticated asset requests in Cellbox mode. */
export function isAuthenticatedDevRequest(request: Pick<IncomingMessage, 'url' | 'method' | 'headers'>,
  publicHost: string, token: string): boolean {
  if (!request.url?.startsWith('/') || request.url.startsWith('//') ||
    !['GET', 'HEAD'].includes(request.method ?? '') || request.headers.upgrade) return false;
  let path: string;
  try { path = new URL(request.url, 'http://unused.invalid').pathname; } catch { return false; }
  if (['/api', '/mcp', '/auth'].some(prefix => path === prefix || path.startsWith(`${prefix}/`))) return false;
  if (request.headers.host?.toLowerCase() !== publicHost.toLowerCase()) return false;
  return isAuthenticatedOperatorRequest(request.headers, token);
}

function safeReturnPath(input: string | null, publicOrigin: string): string {
  if (!input || input.length > 2048 || !input.startsWith('/') || input.startsWith('//') ||
    /[\\\u0000-\u001f\u007f]/.test(input)) return '/';
  let url: URL;
  try { url = new URL(input, publicOrigin); } catch { return '/'; }
  if (url.origin !== publicOrigin || url.hash) return '/';
  if (url.pathname === '/auth/login') return '/';
  return url.pathname + (url.pathname === '/auth/preview' ? url.search : '');
}

function safeLoginTarget(input: string | null, publicOrigin: string,
  resolvePreviewHost?: (host: string) => unknown): string {
  if (!input || !resolvePreviewHost || input.startsWith('/')) return safeReturnPath(input, publicOrigin);
  if (input.length > 16384 || /[\\\u0000-\u001f\u007f]/.test(input)) return '/';
  try {
    const url = new URL(input);
    const root = new URL(publicOrigin);
    if (url.protocol !== root.protocol || url.username || url.password || url.hash ||
      url.pathname.startsWith('//') || !resolvePreviewHost(url.host)) return '/';
    return url.href;
  } catch { return '/'; }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}

export function installOperatorAccess(app: Hono, options: OperatorAccessOptions): void {
  if (Buffer.byteLength(options.token) < 32) throw new Error('COCELL_ACCESS_TOKEN must be at least 32 bytes');
  let publicUrl: URL;
  try { publicUrl = new URL(options.publicUrl); }
  catch { throw new Error('COCELL_PUBLIC_URL must be an HTTPS origin or loopback HTTP origin'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(publicUrl.hostname);
  if ((publicUrl.protocol !== 'https:' && !(publicUrl.protocol === 'http:' && loopback)) ||
    publicUrl.username || publicUrl.password || publicUrl.pathname !== '/' ||
    publicUrl.search || publicUrl.hash) {
    throw new Error('COCELL_PUBLIC_URL must be an HTTPS origin or loopback HTTP origin');
  }
  if (options.previewSubdomains && (publicUrl.protocol !== 'https:' || !publicUrl.hostname.includes('.'))) {
    throw new Error('Preview subdomains require an HTTPS public URL with a domain name');
  }
  const grants = options.previewGrants ?? new MemoryPreviewGrantStore();
  const origin = publicUrl.origin;
  const host = publicUrl.host.toLowerCase();
  const resolvePreviewHost = options.previewSubdomains
    ? (requestHost: string) => parseServiceHost(requestHost, options.publicUrl, options.token,
      options.projects().map(project => project.id))
    : undefined;
  app.use('*', async (c, next) => {
    await next();
    if (publicUrl.protocol === 'https:') c.header('Strict-Transport-Security', 'max-age=86400');
    const requestHost = (c.req.header('host') ?? new URL(c.req.url).host).toLowerCase();
    // no-referrer makes browser form POSTs send Origin: null, breaking the CSRF checks.
    const pathname = new URL(c.req.url).pathname;
    c.header('Referrer-Policy', pathname === PREVIEW_CALLBACK || requestHost === host && pathname === '/auth/preview' ? 'no-referrer' : 'same-origin');
    c.header('X-Content-Type-Options', 'nosniff');
    if (requestHost !== host) return;
    c.header('X-Frame-Options', 'DENY');
    if (c.res.headers.get('content-type')?.toLowerCase().includes('text/html') &&
      !c.res.headers.has('content-security-policy')) {
      c.header('Content-Security-Policy', "script-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
    }
  });
  const setSessionCookie = (c: Context, scope: 'operator' | 'preview', requestHost = host) => {
    const ttl = scope === 'operator' ? SESSION_TTL_MS : PREVIEW_TTL_MS;
    const expires = String(Date.now() + ttl);
    const signatureScope = scope === 'operator' ? scope : `preview:${requestHost}`;
    c.res.headers.set('Cache-Control', 'no-store');
    setCookie(c, scope === 'operator' ? (publicUrl.protocol === 'https:' ? '__Host-cocell_operator' : COOKIE) : PREVIEW_COOKIE,
      `v1.${expires}.${sessionSignature(options.token, expires, signatureScope)}`, {
        path: '/', httpOnly: true, sameSite: 'Lax', secure: publicUrl.protocol === 'https:', maxAge: ttl / 1000,
      });
  };
  const renewSessionCookie = (c: Context) => {
    const raw = c.req.header('cookie');
    const secureCookie = sessionCookie(raw, '__Host-cocell_operator');
    const expires = sessionExpiry(secureCookie ?? sessionCookie(raw), options.token);
    if (expires !== undefined && (secureCookie === undefined && publicUrl.protocol === 'https:' ||
      expires - Date.now() <= SESSION_TTL_MS - SESSION_RENEW_INTERVAL_MS)) setSessionCookie(c, 'operator');
  };
  const clearLegacyPreviewCookie = (c: Context) => {
    if (!options.previewSubdomains) return;
    setCookie(c, 'cocell_preview', '', { domain: publicUrl.hostname, path: '/', secure: true,
      httpOnly: true, sameSite: 'Lax', maxAge: 0 });
  };

  app.use('*', async (c, next) => {
    const path = new URL(c.req.url).pathname;
    // Sandbox wrappers call these endpoints through the Kubernetes service host.
    // Runtime routes validate Box identity and project tool grants themselves.
    if (c.req.method === 'POST' && path === '/api/tool-runtime/authorize') return next();
    const requestHost = (c.req.header('host') ?? new URL(c.req.url).host).toLowerCase();
    if (requestHost !== host) {
      let target = resolvePreviewHost?.(requestHost);
      if (!target && requestHost.endsWith(`.${host}`)) {
        await options.refreshProjects?.();
        target = resolvePreviewHost?.(requestHost);
      }
      if (!target || !options.serviceProxy) return c.text('Invalid host', 403);
      const serviceOrigin = `${publicUrl.protocol}//${requestHost}`;
      if (path === PREVIEW_CALLBACK) {
        if (c.req.method !== 'GET') return c.text('Method not allowed', 405);
        c.header('Cache-Control', 'no-store');
        c.header('Referrer-Policy', 'no-referrer');
        const code = new URL(c.req.url).searchParams.get('code') ?? '';
        const challenge = sessionCookie(c.req.header('cookie'), CHALLENGE_COOKIE) ?? '';
        if (!/^[A-Za-z0-9_-]{43}$/.test(code) || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) return c.text('Invalid preview grant', 403);
        const grant = await grants.consume(code, requestHost, createHash('sha256').update(challenge).digest('hex'));
        if (!grant) return c.text('Invalid or expired preview grant', 403);
        setSessionCookie(c, 'preview', requestHost);
        return c.redirect(grant.path, 303);
      }
      if (!isAuthenticatedPreviewRequest(c.req.raw.headers, requestHost, options.token)) {
        if (!['GET', 'HEAD'].includes(c.req.method)) return c.text('Preview authentication required', 401);
        const existing = sessionCookie(c.req.header('cookie'), CHALLENGE_COOKIE);
        const challenge = existing && /^[A-Za-z0-9_-]{43}$/.test(existing) ? existing : randomBytes(32).toString('base64url');
        setCookie(c, CHALLENGE_COOKIE, challenge, { path: '/', secure: true, httpOnly: true, sameSite: 'Lax', maxAge: 300 });
        c.header('Cache-Control', 'no-store');
        const returnUrl = `${serviceOrigin}${path}${new URL(c.req.url).search}`;
        return c.redirect(`${origin}/auth/preview?next=${encodeURIComponent(returnUrl)}&challenge=${createHash('sha256').update(challenge).digest('hex')}`, 303);
      }
      const requestOrigin = c.req.header('origin');
      if (requestOrigin && requestOrigin !== serviceOrigin) return c.text('Invalid origin', 403);
      const headers = new Headers(c.req.raw.headers);
      if (headers.get('authorization') === `Bearer ${options.token}`) headers.delete('authorization');
      return options.serviceProxy(target.projectId, target.port, path + new URL(c.req.url).search, new Request(c.req.raw, { headers }));
    }
    if (isPublicPwaAsset(path, c.req.method)) return next();
    if (path === '/auth/login' && ['GET', 'POST'].includes(c.req.method)) {
      return next();
    }
    const authorization = c.req.header('authorization');
    const authenticated = isAuthenticatedOperatorRequest(c.req.raw.headers, options.token);
    if (!authenticated) {
      if (path === '/auth/preview' && options.previewSubdomains) {
        const requested = new URL(c.req.url);
        return c.redirect(`/auth/login?next=${encodeURIComponent(requested.pathname + requested.search)}`, 303);
      }
      if (path.startsWith('/api/')) {
        return c.json({ error: 'Authentication required' }, 401);
      }
      const requested = new URL(c.req.url);
      const nextPath = safeReturnPath(requested.pathname + requested.search, origin);
      return c.redirect(`/auth/login?next=${encodeURIComponent(nextPath)}`, 303);
    }
    if (authorization === undefined && !['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) && c.req.header('origin') !== origin) {
      return c.json({ error: 'Invalid origin' }, 403);
    }
    if (authorization === undefined) {
      renewSessionCookie(c);
    }
    return next();
  });

  app.use('/auth/login', bodyLimit({
    maxSize: MAX_LOGIN_BYTES,
    onError: c => c.text('Request too large', 413)
  }));
  app.get('/auth/login', c => {
    const nextPath = safeLoginTarget(new URL(c.req.url).searchParams.get('next'), origin, resolvePreviewHost);
    c.header('Cache-Control', 'no-store');
    if (isAuthenticatedOperatorRequest(c.req.raw.headers, options.token)) {
      if (c.req.header('authorization') === undefined) {
        renewSessionCookie(c);

      }
      return c.redirect(nextPath, 303);
    }
    c.header('Content-Security-Policy', "default-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
    c.header('X-Content-Type-Options', 'nosniff');
    return c.html(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><meta name="theme-color" content="#f8f8f7"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-title" content="CoCell"><link rel="manifest" href="/manifest.webmanifest"><link rel="icon" type="image/svg+xml" href="/icons/icon.svg"><link rel="apple-touch-icon" href="/icons/apple-touch-icon.png"><title>CoCell sign in</title></head>
<body><main><h1>CoCell sign in</h1>
<form id="login-form" method="post" action="/auth/login" autocomplete="on">
  <p><label for="username">Account</label> <input id="username" type="text" name="username" value="operator" autocomplete="username" autocapitalize="none" spellcheck="false" readonly></p>
  <p><label for="password">Access token</label> <input id="password" type="password" name="token" autocomplete="current-password" required></p>
  <input type="hidden" name="next" value="${escapeHtml(nextPath)}">
  <button type="submit">Sign in</button>
</form>
<p>Save this login in your browser to fill the access token next time.</p>
</main></body></html>`);
  });
  app.post('/auth/login', async c => {
    if (c.req.header('origin') !== origin) return c.text('Invalid origin', 403);
    if (!(c.req.header('content-type') ?? '').toLowerCase().startsWith('application/x-www-form-urlencoded')) {
      return c.text('Unsupported content type', 415);
    }
    const body = await c.req.raw.text();
    if (Buffer.byteLength(body) > MAX_LOGIN_BYTES) return c.text('Request too large', 413);
    const form = new URLSearchParams(body);
    const submitted = form.getAll('token');
    if (submitted.length !== 1 || !fixedEqual(submitted[0], options.token)) {
      return c.text('Invalid access token', 401);
    }
    const nextPath = safeLoginTarget(form.get('next'), origin, resolvePreviewHost);
    setSessionCookie(c, 'operator');
    clearLegacyPreviewCookie(c);
    c.header('Cache-Control', 'no-store');
    return c.redirect(nextPath, 303);
  });

  if (options.previewSubdomains) app.get('/auth/preview', async c => {
    await options.refreshProjects?.();
    const requested = new URL(c.req.url);
    const target = safeLoginTarget(requested.searchParams.get('next'), origin, resolvePreviewHost);
    const challenge = requested.searchParams.get('challenge') ?? '';
    if (target === '/' || !/^[a-f0-9]{64}$/.test(challenge)) return c.text('Invalid preview target', 400);
    const url = new URL(target);
    const project = resolvePreviewHost?.(url.host);
    if (!project || !options.projects().some(p => p.id === project.projectId && p.executionMode === 'sandbox' && p.sandbox && p.status !== 'archived'))
      return c.text('Preview project unavailable', 403);
    const code = await grants.issue({ host: url.host.toLowerCase(), path: url.pathname + url.search,
      challenge, expires: Date.now() + 60_000 });
    clearLegacyPreviewCookie(c);
    c.header('Cache-Control', 'no-store');
    c.header('Referrer-Policy', 'no-referrer');
    return c.redirect(`${url.origin}${PREVIEW_CALLBACK}?code=${encodeURIComponent(code)}`, 303);
  });
}
