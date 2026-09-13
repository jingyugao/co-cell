import { installImprovementRoutes } from './improvements/routes.js';
import type { ImprovementStore } from './improvements/store.js';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import type { AppConfig } from '../protocol/types.js';
import { SessionManager } from './sessions/manager.js';
import { HttpError } from '../util/errors.js';
import { RawToolReader } from './execution/raw-tools.js';
import type { SandboxInventoryReader } from './sandboxes/inventory.js';
import { SharedFiles } from './shared-files/service.js';
import type { ConnectionStore } from './connections/store.js';

import { installProjectsRoutes } from './projects/routes.js';
import { installConnectionsRoutes } from './connections/routes.js';
import { installSharedFilesRoutes } from './shared-files/routes.js';
import { installSandboxesRoutes } from './sandboxes/routes.js';
import { installSessionsRoutes } from './sessions/routes.js';

export function createApp(manager: SessionManager, config: AppConfig, allowedHosts: string[], rawTools: RawToolReader = new RawToolReader(), sandboxes: SandboxInventoryReader, sharedFiles = new SharedFiles(), connections?: ConnectionStore, improvements?: ImprovementStore) {
  const app = new Hono();
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
  installSessionsRoutes(app, manager, config, rawTools);
  installSandboxesRoutes(app, sandboxes, manager);
  installConnectionsRoutes(app, connections);
  installSharedFilesRoutes(app, sharedFiles);
  app.all('/api/*', c => c.json({ error: '接口不存在' }, 404));
  return app;
}
