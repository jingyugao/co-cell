import type { Hono } from 'hono';
import { z } from 'zod';
import { HttpError } from '../../util/errors.js';
import type { ConnectionStore } from './store.js';

export function installConnectionsRoutes(app: Hono, connections?: ConnectionStore) {
  app.get('/api/connections', async c => {
    if (!connections) throw new HttpError(503, '连接管理尚未初始化');
    return c.json(await connections.list());
  });
  app.post('/api/connections/import', async c => {
    if (!connections) throw new HttpError(503, '连接管理尚未初始化');
    try { return c.json(await connections.importLocal()); }
    catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(500, '本机凭据导入失败，原有副本保持不变'); }
  });
}
