import { installImprovementRoutes } from './improvements/routes.js';
import type { ImprovementStore } from './improvements/store.js';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import type { AppConfig } from '../protocol/types.js';
import { SessionManager } from './sessions/manager.js';
import { HttpError } from '../util/errors.js';
import type { SandboxInventoryReader } from './sandboxes/inventory.js';
import { SharedFiles } from './shared-files/service.js';
import type { ConnectionStore } from './connections/store.js';

import { installProjectsRoutes } from './projects/routes.js';
import { installConnectionsRoutes } from './connections/routes.js';
import { installSharedFilesRoutes } from './shared-files/routes.js';
import { installSandboxesRoutes } from './sandboxes/routes.js';
import { installSessionsRoutes } from './sessions/routes.js';
import { installApprovalMcpRoutes, type ApprovalMcpService } from './approvals/mcp.js';
import { installNotificationRoutes } from './notifications/routes.js';
import type { NotificationStore } from './notifications/store.js';
import { installArchiveRoutes } from './archives/routes.js';

export function createApp(manager: SessionManager, config: AppConfig, allowedHosts: string[], sandboxes: SandboxInventoryReader, sharedFiles = new SharedFiles(), connections?: ConnectionStore, improvements?: ImprovementStore, approvalMcp?: ApprovalMcpService, notifications?: NotificationStore) {
  const app = new Hono();
  installApprovalMcpRoutes(app, approvalMcp, manager);

  // Sandbox service proxy via subdomain:
  // {projectId}.{port}.{swarm-hive-host}/path → sandbox container:port/path
  // Runs before the host-access check so remote users can reach sandbox services.
  const hopByHopHeaders = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'];
  // The sandbox runs sandbox-proxy (Go) on port 40000 for localhost-bound services.
  const sandboxProxyPort = 40000;

  async function sandboxFetch(sandboxName: string, port: number, path: string, req: Request): Promise<Response> {
    const headers = new Headers(req.headers);
    for (const h of hopByHopHeaders) headers.delete(h);
    headers.delete('host');
    const init: RequestInit = { method: req.method, headers, redirect: 'manual' };
    if (!['GET', 'HEAD'].includes(req.method)) {
      init.body = await req.arrayBuffer();
    }
    return fetch(`http://${sandboxName}:${port}${path}`, init);
  }

  app.use('*', async (c, next) => {
    const host = c.req.header('host') || '';
    // Match subdomain pattern: <uuid>.digits.<anything>
    const match = /^([a-f0-9-]+)\.(\d+)\.(.+)$/i.exec(host);
    if (!match) return next();

    const projectId = match[1];
    const port = parseInt(match[2], 10);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return next();

    // Verify the project exists and has a running sandbox, get its container name
    let sandboxHost: string;
    try {
      sandboxHost = await manager.sandboxProxyHost(projectId);
    } catch (error) {
      if (error instanceof HttpError) {
        return new Response(error.message, { status: error.status as 400 });
      }
      return next();
    }

    const url = new URL(c.req.url);
    const path = url.pathname + url.search;

    // 1) Try direct fetch to the sandbox container (works for 0.0.0.0-bound services)
    let response: Response;
    try {
      response = await sandboxFetch(sandboxHost, port, path, c.req.raw);
    } catch (error) {
      const sysErr = error as { cause?: { code?: string } };
      const code = (error as NodeJS.ErrnoException).code || sysErr.cause?.code;
      if (code === 'ECONNREFUSED' || code === 'ECONNRESET') {
        // 2) Fall back to sandbox-proxy (port 40000) for localhost-bound services.
        //    sandbox-proxy path format: /<targetPort>/<originalPath>
        try {
          response = await sandboxFetch(sandboxHost, sandboxProxyPort, `/${port}${path}`, c.req.raw);
        } catch {
          return new Response('沙箱服务未启动或端口不可达', { status: 504 });
        }
      } else {
        return new Response(`沙箱代理失败: ${(error as Error).message}`, { status: 502 });
      }
    }

    // Stream response — no base tag needed (subdomain provides isolated origin)
    const outHeaders = new Headers(response.headers);
    for (const h of hopByHopHeaders) outHeaders.delete(h);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: outHeaders,
    });
  });

  app.use('/api/*', async (c, next) => {
    const host = c.req.header('host');
    if (!host || !allowedHosts.includes(host)) return c.json({ error: '仅允许从本机访问' }, 403);
    const origin = c.req.header('origin');
    if (origin && !allowedHosts.some(hostname => origin === `http://${hostname}`)) {
      return c.json({ error: '不允许跨站请求' }, 403);
    }
    c.header('Cache-Control', 'no-store');
    c.header('X-Content-Type-Options', 'nosniff');
    await next();
  });
  app.use('/api/*', bodyLimit({ maxSize: 12 * 1024 * 1024, onError: c => c.json({ error: '请求过大，图片最大 10 MB' }, 413) }));
  app.onError((error, c) => {
    if (error instanceof HttpError) return c.json({ error: error.message }, error.status as 400);
    if (error instanceof z.ZodError) return c.json({ error: error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') }, 400);
    if (error instanceof SyntaxError) return c.json({ error: '请求 JSON 格式错误' }, 400);
    console.error('Request failed:', error.message);
    return c.json({ error: '服务器处理失败，请查看服务端日志' }, 500);
  });

  app.get('/api/config', c => c.json(config));
  installImprovementRoutes(app, improvements, manager);
  installProjectsRoutes(app, manager);
  installSessionsRoutes(app, manager, config);
  installNotificationRoutes(app, notifications);
  installArchiveRoutes(app, manager);
  installSandboxesRoutes(app, sandboxes, manager);
  installConnectionsRoutes(app, connections);
  installSharedFilesRoutes(app, sharedFiles);
  app.all('/api/*', c => c.json({ error: '接口不存在' }, 404));
  return app;
}
