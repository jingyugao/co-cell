import type { Hono } from 'hono';
import { z } from 'zod';
import { HttpError } from '../../util/errors.js';
import type { MemoryService } from './service.js';

export function installMemoryRoutes(app: Hono, service?: MemoryService) {
  const memory = () => {
    if (!service) throw new HttpError(503, '记忆模块尚未初始化');
    return service;
  };
  const id = z.string().uuid();
  const offset = z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
  app.get('/api/memory', async c => c.json(await memory().list(
    offset.parse(c.req.query('offset') ?? 0), z.coerce.number().int().min(1).max(100).parse(c.req.query('limit') ?? 50))));
  app.get('/api/memory/:id', async c => c.json(await memory().detail(id.parse(c.req.param('id')))));
  app.get('/api/memory/:id/files/:fileId', async c => c.json(await memory().content(
    id.parse(c.req.param('id')), id.parse(c.req.param('fileId')), offset.parse(c.req.query('offset') ?? 0))));
  app.post('/api/memory/:id/retry', async c => {
    const input = z.object({ updatedAt: z.string().datetime() }).strict().parse(await c.req.json());
    await memory().retry(id.parse(c.req.param('id')), input.updatedAt);
    return c.json({ ok: true }, 202);
  });
}
