import type { Hono } from 'hono';
import { z } from 'zod';
import { HttpError } from '../../util/errors.js';
import type { KnowledgeService } from './service.js';

export function installKnowledgeRoutes(app: Hono, service?: KnowledgeService) {
  const knowledge = () => {
    if (!service) throw new HttpError(503, '知识模块尚未初始化');
    return service;
  };
  const pageId = z.string().regex(/^[A-Za-z0-9_-]{1,191}$/);
  app.get('/api/knowledge', async c => c.json(await knowledge().view(pageId.optional().parse(c.req.query('pageId')))));
  app.put('/api/knowledge/pages/:id/prompt', async c => {
    const input = z.object({ text: z.string().max(20_000).refine(text => Boolean(text.trim()), '提示词不能为空'),
      version: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(await c.req.json());
    return c.json(await knowledge().updatePagePrompt(pageId.parse(c.req.param('id')), input));
  });
  app.post('/api/knowledge/pages/:id/refresh', async c => {
    await knowledge().refreshPage(pageId.parse(c.req.param('id')));
    return c.json({ ok: true }, 202);
  });
}
