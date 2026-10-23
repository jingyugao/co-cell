import type { Hono } from 'hono';
import { z } from 'zod';
import { HttpError } from '../../util/errors.js';
import type { KnowledgeService } from './service.js';

export function installKnowledgeRoutes(app: Hono, service?: KnowledgeService) {
  const knowledge = () => {
    if (!service) throw new HttpError(503, '知识模块尚未初始化');
    return service;
  };
  const prompt = z.string().trim().min(1).max(20_000);
  app.get('/api/knowledge', async c => c.json(await knowledge().view()));
  app.put('/api/knowledge/settings', async c => {
    const input = z.object({ revision: z.number().int().min(0), enabled: z.boolean(),
      prompts: z.object({ business: prompt, repositories: prompt, components: prompt, workflows: prompt }).strict() }).strict().parse(await c.req.json());
    return c.json(await knowledge().update(input));
  });
  app.post('/api/knowledge/jobs/:id/retry', async c => {
    const { updatedAt } = z.object({ updatedAt: z.string().datetime() }).strict().parse(await c.req.json());
    await knowledge().retry(z.string().uuid().parse(c.req.param('id')), updatedAt);
    return c.json({ ok: true }, 202);
  });
}
