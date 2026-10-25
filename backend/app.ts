import { installModelRoutes } from './models/routes.js';
import type { ModelService } from './models/service.js';
import { installMemoryRoutes } from './memory/routes.js';
import type { MemoryService } from './memory/service.js';
import { installKnowledgeRoutes } from './knowledge/routes.js';
import type { KnowledgeService } from './knowledge/service.js';
import { installReportRoutes } from './reports/routes.js';
import type { ReportService } from './reports/service.js';
import { installImageRoutes } from './images/routes.js';
import type { ImageCatalog } from './images/service.js';
import { traceHttpRequest } from './infra/diagnostics/tracing.js';
import { pageLoadReportSchema, recordPageLoad, type PageLoadLogWriter } from './infra/diagnostics/page-load.js';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import type { AppConfig } from '../protocol/types.js';
import { SessionManager } from './sessions/manager.js';
import { HttpError, providerError } from '../util/errors.js';
import type { SandboxInventoryReader } from './sandboxes/inventory.js';
import { SharedFiles } from './shared-files/service.js';

import { installProjectsRoutes } from './projects/routes.js';
import { installSharedFilesRoutes } from './shared-files/routes.js';
import { installSandboxesRoutes } from './sandboxes/routes.js';
import { installSessionsRoutes } from './sessions/routes.js';
import { installNotificationRoutes } from './notifications/routes.js';
import type { NotificationStore } from './notifications/store.js';
import { installArchiveRoutes } from './routes/archives.js';
import { installOperatorAccess, type OperatorAccessOptions } from './access/operator.js';
import { proxyProjectService } from './projects/routes.js';
import type { SecretService } from './secrets/service.js';
import { installSecretRoutes } from './secrets/routes.js';
import { installToolRoutes } from './tools/routes.js';
import { installPwaAssets } from './infra/http/pwa.js';
import { installFileFavoriteRoutes } from './file-favorites/routes.js';
import type { FileFavoriteRepository } from './file-favorites/repository.js';

export function createApp(manager: SessionManager, config: AppConfig, allowedHosts: string[], sandboxes: SandboxInventoryReader, sharedFiles = new SharedFiles(), notifications?: NotificationStore, operatorAccess?: OperatorAccessOptions, images?: ImageCatalog, secrets?: SecretService, models?: ModelService, memory?: MemoryService, fileFavorites?: FileFavoriteRepository, knowledge?: KnowledgeService, runtimeLog?: PageLoadLogWriter, reports?: ReportService) {
  const app = new Hono();
  app.get('/healthz', c => c.text('ok'));
  app.use('/api/*', traceHttpRequest);
  if (operatorAccess) installOperatorAccess(app, {
    ...operatorAccess,
    serviceProxy: (projectId, port, path, request) =>
      proxyProjectService(manager, projectId, port, path, request, '', true),
  });
  if (manager.sharedStateEnabled) app.use('/api/*', async (c, next) => {
    const pathname = new URL(c.req.url).pathname;
    // These project-scoped routes refresh their own project from durable state.
    // Session reads and controls also load their own durable record.
    const projectScoped = c.req.method === 'GET' && /^\/api\/projects\/[^/]+$/.test(pathname)
      || c.req.method === 'POST' && /^\/api\/projects\/[^/]+\/(?:open|sandbox\/resume)$/.test(pathname);
    const sessionScoped = c.req.method === 'GET' && pathname === '/api/sessions'
      || /^\/api\/sessions\/[^/]+(?:\/|$)/.test(pathname);
    if (pathname === '/api/diagnostics/page-load' && c.req.method === 'POST'
      || pathname.startsWith('/api/tool-runtime/') || projectScoped || sessionScoped) return next();
    await manager.refreshSharedState();
    await next();
  });
  installPwaAssets(app);

  app.use('/api/*', async (c, next) => {
    const host = c.req.header('host');
    if (!operatorAccess && (!host || !allowedHosts.includes(host))) return c.json({ error: '仅允许从本机访问' }, 403);
    const origin = c.req.header('origin');
    const originAllowed = operatorAccess
      ? origin === new URL(operatorAccess.publicUrl).origin
      : allowedHosts.some(hostname => origin === `http://${hostname}`);
    if (origin && !originAllowed) {
      return c.json({ error: '不允许跨站请求' }, 403);
    }
    c.header('Cache-Control', 'no-store');
    c.header('X-Content-Type-Options', 'nosniff');
    await next();
  });
  const regularBodyLimit = bodyLimit({ maxSize: 12 * 1024 * 1024, onError: c => c.json({ error: '请求过大，图片最大 10 MB' }, 413) });
  const pageLoadBodyLimit = bodyLimit({ maxSize: 48 * 1024, onError: c => c.json({ error: '请求过大' }, 413) });
  const packageBodyLimit = bodyLimit({ maxSize: 48 * 1024 * 1024, onError: c => c.json({ error: '工具包请求过大，文件总量最大 32 MiB' }, 413) });
  app.use('/api/*', (c, next) => c.req.method === 'POST' && c.req.path === '/api/tool-packages'
    ? packageBodyLimit(c, next)
    : c.req.method === 'POST' && c.req.path === '/api/diagnostics/page-load'
      ? pageLoadBodyLimit(c, next) : regularBodyLimit(c, next));
  app.onError((error, c) => {
    const detail = providerError(error);
    if (detail) return c.json({ error: detail.message, code: detail.code, ...(detail.upstreamStatus ? { upstreamStatus: detail.upstreamStatus } : {}) }, detail.status as 400);
    if (error instanceof HttpError) return c.json({ error: error.message }, error.status as 400);
    if (error instanceof z.ZodError) return c.json({ error: error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') }, 400);
    if (error instanceof SyntaxError) return c.json({ error: '请求 JSON 格式错误' }, 400);
    console.error('Request failed:', error.message);
    return c.json({ error: '服务器处理失败，请查看服务端日志' }, 500);
  });

  app.get('/api/config', async c => c.json(models ? { ...config, modelOptions: await models.options(),
    defaults: { ...config.defaults, ...await models.defaultSelection() } } : config));
  app.post('/api/diagnostics/page-load', async c => {
    let payload: unknown;
    try { payload = await c.req.json(); }
    catch { return c.json({ error: '请求 JSON 格式错误' }, 400); }
    const parsed = pageLoadReportSchema.safeParse(payload);
    if (!parsed.success) return c.json({ error: '诊断数据格式错误' }, 400);
    recordPageLoad(runtimeLog, parsed.data, c.req.header('user-agent'));
    return c.body(null, 204);
  });
  if (models) installModelRoutes(app, models);
  installMemoryRoutes(app, memory);
  installKnowledgeRoutes(app, knowledge);
  installReportRoutes(app, reports);
  installFileFavoriteRoutes(app, manager, fileFavorites);
  installProjectsRoutes(app, manager, operatorAccess?.previewSubdomains
    ? { publicUrl: operatorAccess.publicUrl, token: operatorAccess.token } : undefined, images);
  installSessionsRoutes(app, manager, config);
  installNotificationRoutes(app, notifications);
  installArchiveRoutes(app, manager);
  installSandboxesRoutes(app, sandboxes, manager);
  if (secrets) installSecretRoutes(app, secrets, id => manager.listProjects().some(project => project.id === id));
  if (secrets?.tools) installToolRoutes(app, secrets.tools, secrets);
  installImageRoutes(app, images);
  installSharedFilesRoutes(app, sharedFiles);
  app.all('/api/*', c => c.json({ error: '接口不存在' }, 404));
  return app;
}
