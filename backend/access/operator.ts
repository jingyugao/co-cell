import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { setCookie } from 'hono/cookie';
import { parseServiceHost } from '../projects/service-host.js';
import { isPublicPwaAsset } from '../../util/pwa-assets.js';

const COOKIE = 'cocell_operator';
const PREVIEW_COOKIE = 'cocell_preview';
const MAX_LOGIN_BYTES = 4096;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SESSION_RENEW_INTERVAL_MS = 24 * 60 * 60 * 1000;
export interface OperatorAccessOptions {
  token: string;
  publicUrl: string;
  previewSubdomains?: boolean;
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
  return sessionExpiry(sessionCookie(header(headers, 'cookie')), token) !== undefined;
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
  return url.pathname;
}

function safeLoginTarget(input: string | null, publicOrigin: string,
  resolvePreviewHost?: (host: string) => unknown): string {
  if (!input || !resolvePreviewHost || input.startsWith('/')) return safeReturnPath(input, publicOrigin);
  if (input.length > 16384 || /[\\\u0000-\u001f\u007f]/.test(input)) return '/';
  try {
    const url = new URL(input);
    const root = new URL(publicOrigin);
    if (url.protocol !== root.protocol || url.username || url.password || url.hash ||
      !resolvePreviewHost(url.host)) return '/';
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
    c.header('Referrer-Policy', requestHost === host ? 'same-origin' : 'no-referrer');
    c.header('X-Content-Type-Options', 'nosniff');
    if (requestHost !== host) return;
    c.header('X-Frame-Options', 'DENY');
    if (c.res.headers.get('content-type')?.toLowerCase().includes('text/html') &&
      !c.res.headers.has('content-security-policy')) {
      c.header('Content-Security-Policy', "script-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
    }
  });
  const setSessionCookie = (c: Context, scope: 'operator' | 'preview') => {
    const expires = String(Date.now() + SESSION_TTL_MS);
    // Initialize the context response so Hono preserves these headers when a
    // downstream file or preview handler returns a raw Response.
    c.res.headers.set('Cache-Control', 'no-store');
    setCookie(c, scope === 'operator' ? COOKIE : PREVIEW_COOKIE, `v1.${expires}.${sessionSignature(options.token, expires, scope)}`, {
      path: '/', ...(scope === 'preview' ? { domain: publicUrl.hostname } : {}),
      httpOnly: true, sameSite: 'Lax', secure: publicUrl.protocol === 'https:', maxAge: SESSION_TTL_MS / 1000,
    });
  };
  const renewSessionCookie = (c: Context, scope: 'operator' | 'preview') => {
    const expires = sessionExpiry(sessionCookie(c.req.header('cookie'), scope === 'operator' ? COOKIE : PREVIEW_COOKIE), options.token, scope);
    if (expires !== undefined && expires - Date.now() <= SESSION_TTL_MS - SESSION_RENEW_INTERVAL_MS) {
      setSessionCookie(c, scope);
    }
  };

  if (options.previewSubdomains) app.use('*', bodyLimit({
    maxSize: 12 * 1024 * 1024,
    onError: c => c.text('Request too large', 413)
  }));

  app.use('*', async (c, next) => {
    const path = new URL(c.req.url).pathname;
    const requestHost = (c.req.header('host') ?? new URL(c.req.url).host).toLowerCase();
    // These two endpoints authenticate scoped Sandbox tokens in SecretService.
    // Operator cookies and the platform access token do not authorize them.
    if (c.req.method === 'POST' && (/^\/api\/tool-runtime\/(start|files)$/.test(path) || /^\/api\/tool-runtime\/[0-9a-f-]{36}\/complete$/.test(path))) return next();
    if (requestHost !== host) {
      const target = resolvePreviewHost?.(requestHost);
      if (!target || !options.serviceProxy) return c.text('Invalid host', 403);
      const serviceOrigin = `${publicUrl.protocol}//${requestHost}`;
      const authorization = c.req.header('authorization');
      const authenticated = authorization === undefined
        ? sessionExpiry(sessionCookie(c.req.header('cookie'), PREVIEW_COOKIE), options.token, 'preview') !== undefined
        : isAuthenticatedOperatorRequest(c.req.raw.headers, options.token);
      if (!authenticated) {
        const returnUrl = `${serviceOrigin}${path}${new URL(c.req.url).search}`;
        return c.redirect(`${origin}/auth/preview?next=${encodeURIComponent(returnUrl)}`, 303);
      }
      const requestOrigin = c.req.header('origin');
      if (requestOrigin && requestOrigin !== serviceOrigin) return c.text('Invalid origin', 403);
      if (authorization === undefined) renewSessionCookie(c, 'preview');
      return options.serviceProxy(target.projectId, target.port, path + new URL(c.req.url).search, c.req.raw);
    }
    if (isPublicPwaAsset(path, c.req.method)) return next();
    if (path === '/auth/login' && ['GET', 'POST'].includes(c.req.method)) {
      return next();
    }
    const authorization = c.req.header('authorization');
    const authenticated = isAuthenticatedOperatorRequest(c.req.raw.headers, options.token);
    if (!authenticated) {
      if (path === '/auth/preview' && options.previewSubdomains) {
        const target = safeLoginTarget(new URL(c.req.url).searchParams.get('next'), origin, resolvePreviewHost);
        return c.redirect(`/auth/login?next=${encodeURIComponent(target)}`, 303);
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
      renewSessionCookie(c, 'operator');
      if (options.previewSubdomains) renewSessionCookie(c, 'preview');
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
        renewSessionCookie(c, 'operator');
        if (options.previewSubdomains) renewSessionCookie(c, 'preview');
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
    if (options.previewSubdomains) setSessionCookie(c, 'preview');
    c.header('Cache-Control', 'no-store');
    return c.redirect(nextPath, 303);
  });

  if (options.previewSubdomains) app.get('/auth/preview', c => {
    const target = safeLoginTarget(new URL(c.req.url).searchParams.get('next'), origin, resolvePreviewHost);
    setSessionCookie(c, 'preview');
    c.header('Cache-Control', 'no-store');
    return c.redirect(target, 303);
  });
}
