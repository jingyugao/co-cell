import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { setCookie } from 'hono/cookie';
import { parseServiceHost } from '../projects/service-host.js';

const COOKIE = 'cocell_operator';
const PREVIEW_COOKIE = 'cocell_preview';
const MAX_LOGIN_BYTES = 4096;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const REQUEST_ID = /^[A-Za-z0-9_-]{1,200}$/;

interface AccessRequest {
  id: string;
  boxId: string;
  callbackUrl: string;
  expiresAt: string;
  approved: boolean;
  consumed: boolean;
}

export interface OperatorAccessOptions {
  token: string;
  publicUrl: string;
  previewSubdomains?: boolean;
  serviceProxy?: (projectId: string, port: number, path: string, request: Request) => Promise<Response>;
  provider: {
    getAccessRequest(id: string): Promise<AccessRequest>;
    approveAccessRequest(id: string, subject: string): Promise<{ redirectUrl: string }>;
  };
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

function validSession(value: string | undefined, token: string, scope = 'operator'): boolean {
  if (!value) return false;
  const parts = /^v1\.(\d{1,13})\.([A-Za-z0-9_-]{43})$/.exec(value);
  if (!parts) return false;
  const expires = Number(parts[1]);
  if (!Number.isSafeInteger(expires) || expires <= Date.now()) return false;
  return fixedEqual(parts[2], sessionSignature(token, parts[1], scope));
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
  return validSession(sessionCookie(header(headers, 'cookie')), token);
}

function isAuthenticatedPreviewRequest(headers: AuthHeaders, token: string): boolean {
  const authorization = header(headers, 'authorization');
  if (authorization !== undefined) {
    const bearer = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
    return fixedEqual(bearer, token);
  }
  return validSession(sessionCookie(header(headers, 'cookie'), PREVIEW_COOKIE), token, 'preview');
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
  if (url.pathname === '/api/cellbox/authorize') {
    const ids = url.searchParams.getAll('request_id');
    if (ids.length !== 1 || !REQUEST_ID.test(ids[0])) return '/';
    return `/api/cellbox/authorize?request_id=${encodeURIComponent(ids[0])}`;
  }
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

function callbackUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) return null;
    return url;
  } catch { return null; }
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
  const setPreviewCookie = (c: Context) => {
    const expires = String(Date.now() + SESSION_TTL_MS);
    setCookie(c, PREVIEW_COOKIE, `v1.${expires}.${sessionSignature(options.token, expires, 'preview')}`, {
      path: '/', domain: publicUrl.hostname, httpOnly: true, sameSite: 'Lax', secure: publicUrl.protocol === 'https:',
    });
  };

  if (options.previewSubdomains) app.use('*', bodyLimit({
    maxSize: 12 * 1024 * 1024,
    onError: c => c.text('Request too large', 413)
  }));

  app.use('*', async (c, next) => {
    const path = new URL(c.req.url).pathname;
    const requestHost = (c.req.header('host') ?? new URL(c.req.url).host).toLowerCase();
    if (c.req.method === 'POST' && path === '/mcp/user-input') {
      const authorization = c.req.header('authorization') ?? '';
      if (authorization.startsWith('Bearer ') && fixedEqual(authorization.slice(7), options.token)) return next();
      return c.json({ error: 'Authentication required' }, 401);
    }
    // These two endpoints authenticate scoped Sandbox tokens in SecretService.
    // Operator cookies and the platform access token do not authorize them.
    if (c.req.method === 'POST' && (/^\/api\/tool-runtime\/(start|files)$/.test(path) || /^\/api\/tool-runtime\/[0-9a-f-]{36}\/complete$/.test(path) || path === '/mcp/user-input')) return next();
    if (requestHost !== host) {
      const target = resolvePreviewHost?.(requestHost);
      if (!target || !options.serviceProxy) return c.text('Invalid host', 403);
      const serviceOrigin = `${publicUrl.protocol}//${requestHost}`;
      if (!isAuthenticatedPreviewRequest(c.req.raw.headers, options.token)) {
        const returnUrl = `${serviceOrigin}${path}${new URL(c.req.url).search}`;
        return c.redirect(`${origin}/auth/preview?next=${encodeURIComponent(returnUrl)}`, 303);
      }
      const requestOrigin = c.req.header('origin');
      if (requestOrigin && requestOrigin !== serviceOrigin) return c.text('Invalid origin', 403);
      return options.serviceProxy(target.projectId, target.port, path + new URL(c.req.url).search, c.req.raw);
    }
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
      if (path.startsWith('/api/') && path !== '/api/cellbox/authorize') {
        return c.json({ error: 'Authentication required' }, 401);
      }
      const requested = new URL(c.req.url);
      const nextPath = safeReturnPath(requested.pathname + requested.search, origin);
      return c.redirect(`/auth/login?next=${encodeURIComponent(nextPath)}`, 303);
    }
    if (authorization === undefined && !['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) && c.req.header('origin') !== origin) {
      return c.json({ error: 'Invalid origin' }, 403);
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
    c.header('Content-Security-Policy', "default-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
    c.header('X-Content-Type-Options', 'nosniff');
    return c.html(`<!doctype html><html><head><meta charset="utf-8"><title>CoCell sign in</title></head><body><main><h1>CoCell sign in</h1><form method="post" action="/auth/login"><label>Access token <input type="password" name="token" autocomplete="current-password" required></label><input type="hidden" name="next" value="${escapeHtml(nextPath)}"><button type="submit">Sign in</button></form></main></body></html>`);
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
    const expires = String(Date.now() + SESSION_TTL_MS);
    setCookie(c, COOKIE, `v1.${expires}.${sessionSignature(options.token, expires)}`, {
      path: '/', httpOnly: true, sameSite: 'Lax', secure: publicUrl.protocol === 'https:',
    });
    if (options.previewSubdomains) setPreviewCookie(c);
    c.header('Cache-Control', 'no-store');
    return c.redirect(nextPath, 303);
  });

  if (options.previewSubdomains) app.get('/auth/preview', c => {
    const target = safeLoginTarget(new URL(c.req.url).searchParams.get('next'), origin, resolvePreviewHost);
    setPreviewCookie(c);
    c.header('Cache-Control', 'no-store');
    return c.redirect(target, 303);
  });

  app.use('/api/cellbox/authorize', bodyLimit({
    maxSize: MAX_LOGIN_BYTES,
    onError: c => c.text('Request too large', 413)
  }));
  const pendingAccess = async (c: Context, id: string) => {
    let access: AccessRequest;
    try { access = await options.provider.getAccessRequest(id); }
    catch { return { error: c.text('Access request unavailable', 502) }; }
    if (access.id !== id || access.approved || access.consumed ||
      !Number.isFinite(Date.parse(access.expiresAt)) || Date.parse(access.expiresAt) <= Date.now()) {
      return { error: c.text('Access request unavailable', 409) };
    }
    const project = options.projects().find(project => project.executionMode === 'sandbox' &&
      project.status !== 'archived' && project.status !== 'deleted' &&
      project.sandbox?.id === access.boxId);
    if (!project) return { error: c.text('Access request denied', 403) };
    const callback = callbackUrl(access.callbackUrl);
    if (!callback) return { error: c.text('Invalid access callback', 502) };
    return { callback, project };
  };

  app.get('/api/cellbox/authorize', async c => {
    const ids = new URL(c.req.url).searchParams.getAll('request_id');
    if (ids.length !== 1 || !REQUEST_ID.test(ids[0])) return c.text('Invalid access request', 400);
    const pending = await pendingAccess(c, ids[0]);
    if ('error' in pending) return pending.error;
    c.header('Cache-Control', 'no-store');
    c.header('Content-Security-Policy', "default-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
    return c.html(`<!doctype html><html><head><meta charset="utf-8"><title>CoCell access request</title></head><body><main><h1>Approve Sandbox access?</h1><p>Project: ${escapeHtml(pending.project.id)}</p><p>Destination: ${escapeHtml(pending.callback.host)}</p><form method="post" action="/api/cellbox/authorize"><input type="hidden" name="request_id" value="${escapeHtml(ids[0])}"><button type="submit">Approve access</button></form></main></body></html>`);
  });

  app.post('/api/cellbox/authorize', async c => {
    if (c.req.header('origin') !== origin) return c.text('Invalid origin', 403);
    if (!(c.req.header('content-type') ?? '').toLowerCase().startsWith('application/x-www-form-urlencoded')) {
      return c.text('Unsupported content type', 415);
    }
    const body = await c.req.raw.text();
    if (Buffer.byteLength(body) > MAX_LOGIN_BYTES) return c.text('Request too large', 413);
    const ids = new URLSearchParams(body).getAll('request_id');
    if (ids.length !== 1 || !REQUEST_ID.test(ids[0])) return c.text('Invalid access request', 400);
    const pending = await pendingAccess(c, ids[0]);
    if ('error' in pending) return pending.error;
    let approved: { redirectUrl: string };
    try { approved = await options.provider.approveAccessRequest(ids[0], 'operator'); }
    catch { return c.text('Access approval failed', 502); }
    const redirect = callbackUrl(approved.redirectUrl);
    if (!redirect || redirect.origin !== pending.callback.origin || redirect.pathname !== pending.callback.pathname) {
      return c.text('Invalid access callback', 502);
    }
    c.header('Cache-Control', 'no-store');
    return c.redirect(redirect.href, 303);
  });
}
