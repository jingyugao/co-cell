import type { Hono } from 'hono';
import { z } from 'zod';
import { HttpError } from '../../util/errors.js';
import { templateManifestSchema, type TemplateManager } from './manager.js';

export function installTemplatesRoutes(app: Hono, templates?: TemplateManager) {
  const templateManager = () => {
    if (!templates) throw new HttpError(503, '模板管理尚未初始化');
    return templates;
  };
  const templateInput = z.object({ name: z.string().trim().min(1).max(100), manifest: templateManifestSchema }).strict();
  const revision = z.string().regex(/^[a-f0-9]{64}$/);
  app.get('/api/templates', async c => c.json(await templateManager().list()));
  app.post('/api/templates', async c => c.json(await templateManager().create(templateInput.parse(await c.req.json())), 201));
  app.put('/api/templates/:id', async c => {
    const input = templateInput.extend({ version: revision }).parse(await c.req.json());
    return c.json(await templateManager().update(c.req.param('id'), input));
  });
  app.delete('/api/templates/:id', async c => {
    const { version } = z.object({ version: revision }).strict().parse(await c.req.json());
    await templateManager().delete(c.req.param('id'), version);
    return c.json({ ok: true });
  });
  app.post('/api/templates/:id/builds', async c => {
    const { version } = z.object({ version: revision }).strict().parse(await c.req.json());
    return c.json(await templateManager().build(c.req.param('id'), version), 202);
  });
  app.get('/api/template-builds/:id', async c => c.json(await templateManager().job(c.req.param('id'))));
  app.post('/api/template-builds/:id/activate', async c => c.json(await templateManager().activate(c.req.param('id'))));
}
