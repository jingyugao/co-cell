import type { Hono } from 'hono';
import { z } from 'zod';
import { HttpError } from '../../util/errors.js';
import type { KnowledgeService } from './service.js';

export function installKnowledgeRoutes(app: Hono, service?: KnowledgeService) {
  const knowledge = () => {
    if (!service) throw new HttpError(503, '知识模块尚未初始化');
    return service;
  };
  const category = z.enum(['business', 'repositories', 'components', 'workflows']);
  app.get('/api/knowledge', async c => c.json(await knowledge().view()));
  app.put('/api/knowledge/settings', async c => {
    const input = z.object({ revision: z.number().int().min(0), enabled: z.boolean() }).strict().parse(await c.req.json());
    return c.json(await knowledge().update(input));
  });
  app.put('/api/knowledge/pages/:category/prompt', async c => {
    const input = z.object({ text: z.string().max(20_000).refine(text => Boolean(text.trim()), '提示词不能为空'),
      version: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(await c.req.json());
    return c.json(await knowledge().updatePagePrompt(category.parse(c.req.param('category')), input));
  });
  app.post('/api/knowledge/jobs/:id/retry', async c => {
    const { updatedAt } = z.object({ updatedAt: z.string().datetime() }).strict().parse(await c.req.json());
    await knowledge().retry(z.string().uuid().parse(c.req.param('id')), updatedAt);
    return c.json({ ok: true }, 202);
  });
  app.post('/api/knowledge/pages/:category/refresh', async c => {
    await knowledge().refreshPage(category.parse(c.req.param('category')));
    return c.json({ ok: true }, 202);
  });
}
