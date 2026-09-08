import type { Hono } from 'hono';
import { z } from 'zod';
import { HttpError } from '../core/errors.js';
import type { SessionManager } from '../sessions/manager.js';

export function installProjectsRoutes(app: Hono, manager: Pick<SessionManager, 'listProjects' | 'getProject' | 'createProject' | 'updateProject' | 'deleteProject' | 'preview' | 'projectFile'>) {
  app.get('/api/projects/:id/files', async c => {
    const path = c.req.query('path');
    if (!path) throw new HttpError(400, '缺少文件路径');
    const { file, data } = await manager.projectFile(c.req.param('id'), path);
    c.header('Cache-Control', 'no-store');
    c.header('X-Content-Type-Options', 'nosniff');
    if (c.req.query('raw') !== '1' && c.req.query('download') !== '1') return c.json(file);
    const inline = file.kind === 'image' && c.req.query('download') !== '1';
    c.header('Content-Type', inline ? file.mimeType : 'application/octet-stream');
    c.header('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="download"; filename*=UTF-8''${encodeURIComponent(file.name).replace(/['()*]/g, value => `%${value.charCodeAt(0).toString(16).toUpperCase()}`)}`);
    c.header('Content-Security-Policy', "default-src 'none'; sandbox");
    c.header('Content-Length', String(data.length));
    return c.body(new Uint8Array(data));
  });

  app.get('/api/projects/:id/preview', async c => {
    const href = c.req.query('url');
    if (!href || href.length > 8192) throw new HttpError(400, '预览链接无效');
    return c.redirect(await manager.preview(c.req.param('id'), href), 302);
  });

  const projectSchema = z.object({ name: z.string().trim().min(1).max(100), requirementUrl: z.string().trim().max(4096).url().refine(value => /^https?:\/\//i.test(value), '仅支持 HTTP 或 HTTPS 链接').nullable().optional() }).strict();
  app.get('/api/projects', c => c.json(manager.listProjects()));
  const createSchema = projectSchema.extend({ name: z.string().trim().max(100).optional() })
    .refine(input => Boolean(input.name || input.requirementUrl), '请输入项目名称或绑定飞书需求');
  app.post('/api/projects', async c => c.json(await manager.createProject(createSchema.parse(await c.req.json())), 201));
  app.get('/api/projects/:id', c => c.json(manager.getProject(c.req.param('id'))));
  app.patch('/api/projects/:id', async c => c.json(await manager.updateProject(c.req.param('id'), projectSchema.partial().extend({ archived: z.boolean().optional() }).parse(await c.req.json()))));
  app.delete('/api/projects/:id', async c => { await manager.deleteProject(c.req.param('id')); return c.json({ ok: true }); });
}
