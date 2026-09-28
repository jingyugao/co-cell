import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { HttpError } from '../../util/errors.js';
import type { SessionManager } from '../sessions/manager.js';
import { workspaceDownload } from '../workspaces/download.js';

export function installProjectsRoutes(app: Hono, manager: Pick<SessionManager, 'listProjects' | 'listProjectsWithArchives' | 'getProject' | 'createProject' | 'updateProject' | 'deleteProject' | 'preview' | 'projectService' | 'projectFile' | 'rebuildProjectSandbox' | 'archiveProjectNow' | 'backupProjectNow' | 'refreshProjectSandboxRuntime'>) {
  app.post('/api/projects/:id/archive', async c => {
    const body = await c.req.text();
    let parsed: unknown;
    try { parsed = body ? JSON.parse(body) : {}; }
    catch { throw new HttpError(400, '请求 JSON 无效'); }
    const input = z.object({ useExistingBackup: z.boolean().optional() }).strict().parse(parsed);
    return c.json(await manager.archiveProjectNow(c.req.param('id'), input), 202);
  });
  app.post('/api/projects/:id/backup', async c => c.json(await manager.backupProjectNow(c.req.param('id')), 202));
  app.post('/api/projects/:id/sandbox/rebuild', async c => c.json(await manager.rebuildProjectSandbox(c.req.param('id')), 202));
  app.post('/api/projects/:id/sandbox/refresh-runtime', async c => c.json(await manager.refreshProjectSandboxRuntime(c.req.param('id')), 202));
  app.get('/api/projects/:id/files', async c => {
    const path = c.req.query('path');
    if (!path) throw new HttpError(400, '缺少文件路径');
    const download = () => workspaceDownload(options => manager.projectFile(c.req.param('id'), path, options), c.req.header('Range'), c.req.header('If-Range'), c.req.method === 'HEAD');
    if (c.req.query('download') === '1') return download();
    const { file, data } = await manager.projectFile(c.req.param('id'), path);
    c.header('Cache-Control', 'no-store');
    c.header('X-Content-Type-Options', 'nosniff');
    if (c.req.query('raw') !== '1') return c.json(file);
    if (file.kind !== 'image') return download();
    c.header('Content-Type', file.mimeType);
    c.header('Content-Disposition', `inline; filename="download"; filename*=UTF-8''${encodeURIComponent(file.name).replace(/['()*]/g, value => `%${value.charCodeAt(0).toString(16).toUpperCase()}`)}`);
    c.header('Content-Security-Policy', "default-src 'none'; sandbox");
    c.header('Content-Length', String(data.length));
    return c.body(new Uint8Array(data));
  });

  app.get('/api/projects/:id/preview', async c => {
    const href = c.req.query('url');
    if (!href || href.length > 8192) throw new HttpError(400, '预览链接无效');
    return c.redirect(await manager.preview(c.req.param('id'), href), 302);
  });

  const service = async (c: Context) => {
    const projectId = c.req.param('id');
    if (!projectId) throw new HttpError(400, '项目 ID 无效');
    const port = Number(c.req.param('port'));
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new HttpError(400, '服务端口无效');
    const prefix = `/api/projects/${encodeURIComponent(projectId)}/service/${port}`;
    const url = new URL(c.req.url);
    const path = (url.pathname.slice(prefix.length) || '/') + url.search;
    const response = await manager.projectService(projectId, port, path, c.req.raw);
    const headers = new Headers(response.headers);
    const location = headers.get('location');
    if (location) {
      try {
        const target = new URL(location, `http://localhost:${port}${path}`);
        if (['localhost', '127.0.0.1', '0.0.0.0'].includes(target.hostname) && Number(target.port || 80) === port)
          headers.set('location', `${prefix}${target.pathname}${target.search}${target.hash}`);
      } catch { /* Keep the upstream location. */ }
    }
    headers.delete('set-cookie');
    headers.set('Cache-Control', 'no-store');
    headers.set('Content-Security-Policy', 'sandbox allow-scripts allow-forms allow-popups');
    headers.set('Referrer-Policy', 'no-referrer');
    headers.set('X-Content-Type-Options', 'nosniff');
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  };
  app.all('/api/projects/:id/service/:port', service);
  app.all('/api/projects/:id/service/:port/*', service);

  const projectSchema = z.object({ name: z.string().trim().min(1).max(100), requirementUrl: z.string().trim().max(4096).url().refine(value => /^https?:\/\//i.test(value), '仅支持 HTTP 或 HTTPS 链接').nullable().optional() }).strict();
  app.get('/api/projects', async c => c.json(await manager.listProjectsWithArchives()));
  const createSchema = projectSchema.extend({ name: z.string().trim().max(100).optional(), type: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional() })
    .refine(input => Boolean(input.name || input.requirementUrl), '请输入项目名称或绑定飞书需求');
  app.post('/api/projects', async c => c.json(await manager.createProject(createSchema.parse(await c.req.json())), 201));
  app.get('/api/projects/:id', c => c.json(manager.getProject(c.req.param('id'))));
  app.patch('/api/projects/:id', async c => c.json(await manager.updateProject(c.req.param('id'), projectSchema.partial().extend({ status: z.enum(['active', 'completed', 'archived']).optional(), backupRetentionCount: z.number().int().min(2).max(100).optional() }).parse(await c.req.json()))));
  app.delete('/api/projects/:id', async c => { await manager.deleteProject(c.req.param('id')); return c.json({ ok: true }); });
}
