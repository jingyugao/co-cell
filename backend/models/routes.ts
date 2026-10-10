import type { Hono } from 'hono';
import { z } from 'zod';
import type { ModelCatalogInput } from '../../protocol/model-types.js';
import { HttpError } from '../../util/errors.js';
import { ModelService } from './service.js';

const text = (max: number) => z.string().trim().min(1).max(max);
const model = z.object({ id: text(100), model: text(200), visible: z.boolean() }).strict();
const catalog = z.object({
  revision: z.number().int().nonnegative(),
  defaultModelId: text(100).nullable(),
  channels: z.array(z.object({
    id: text(100), name: text(100), endpoint: text(2048), enabled: z.boolean(),
    apiKey: z.string().min(1).max(4096).optional(), models: z.array(model).max(500),
  }).strict()).max(100),
}).strict();

export function installModelRoutes(app: Hono, service?: ModelService) {
  const requireService = () => { if (!service) throw new HttpError(503, '模型管理尚未初始化'); return service; };
  app.get('/api/models', async c => c.json(await requireService().catalog()));
  app.put('/api/models', async c => c.json(await requireService().update(catalog.parse(await c.req.json()) as ModelCatalogInput)));
  app.post('/api/models/channels/:id/discover', async c => c.json({ models: await requireService().discover(c.req.param('id')) }));
  app.post('/api/models/channels/:id/test', async c => {
    const input = z.object({ model: text(200).optional() }).strict().parse(await c.req.json().catch(() => ({})));
    return c.json(await requireService().test(c.req.param('id'), input.model));
  });
}
