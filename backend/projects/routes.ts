import type { ImageCatalog } from '../images/service.js';
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { HttpError } from '../../util/errors.js';
import type { SessionManager } from '../sessions/manager.js';
import { workspaceFileResponse } from '../workspaces/http-files.js';
import { serviceHost } from './service-host.js';

type ProjectRoutesManager = Pick<SessionManager, 'listProjects' | 'listProjectsWithArchives' | 'getProject' | 'readProject' | 'enterProject' | 'createProject' | 'updateProject' | 'deleteProject' | 'preview' | 'projectService' | 'projectFileResponse' | 'rebuildProjectSandbox' | 'resumeProjectSandbox' | 'checkpointProjectSandbox' | 'archiveProjectNow' | 'backupProjectNow' | 'refreshProjectSandboxRuntime'>;

export async function proxyProjectService(manager: Pick<SessionManager, 'projectService'>, projectId: string, port: number,
  path: string, request: Request, prefix: string, isolatedOrigin = false): Promise<Response> {
  const response = await manager.projectService(projectId, port, path, request);
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
  if (!isolatedOrigin) headers.set('Content-Security-Policy', 'sandbox allow-scripts allow-forms allow-popups');
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('X-Content-Type-Options', 'nosniff');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export function installProjectsRoutes(app: Hono, manager: ProjectRoutesManager,
  previewHosts?: { publicUrl: string; token: string }, images?: ImageCatalog) {
  app.post('/api/projects/:id/archive', async c => {
    const body = await c.req.text();
    let parsed: unknown;
    try { parsed = body ? JSON.parse(body) : {}; }
    catch { throw new HttpError(400, '请求 JSON 无效'); }
    const input = z.object({ useExistingBackup: z.boolean().optional() }).strict().parse(parsed);
    return c.json(await manager.archiveProjectNow(c.req.param('id'), input), 202);
  });
  app.post('/api/projects/:id/backup', async c => c.json(await manager.backupProjectNow(c.req.param('id')), 202));
  app.post('/api/projects/:id/sandbox/rebuild', async c => {
    const body = await c.req.text();
    let parsed: unknown;
    try { parsed = body ? JSON.parse(body) : {}; } catch { throw new HttpError(400, '请求 JSON 无效'); }
    const input = z.object({ imageVersionId: z.string().min(1).max(256).optional() }).strict().parse(parsed);
    return c.json(await manager.rebuildProjectSandbox(c.req.param('id'), input.imageVersionId), 202);
  });
  app.post('/api/projects/:id/open', async c => c.json(await manager.enterProject(c.req.param('id')), 202));
  app.post('/api/projects/:id/sandbox/resume', async c => c.json(await manager.resumeProjectSandbox(c.req.param('id')), 202));
  app.post('/api/projects/:id/sandbox/checkpoint', async c => c.json(await manager.checkpointProjectSandbox(c.req.param('id')), 202));
  app.post('/api/projects/:id/sandbox/refresh-runtime', async c => c.json(await manager.refreshProjectSandboxRuntime(c.req.param('id')), 202));
  const content = async (c: Context) => {
    const path = c.req.query('path');
    if (!path) throw new HttpError(400, '缺少文件路径');
    const response = await manager.projectFileResponse(c.req.param('id')!, path, c.req.raw);
    return workspaceFileResponse(response, path, c.req.query('download') === '1');
  };
  app.get('/api/projects/:id/files/content', content);
  app.get('/api/projects/:id/files', content);

  app.get('/api/projects/:id/preview', async c => {
    const href = c.req.query('url');
    if (!href || href.length > 8192) throw new HttpError(400, '预览链接无效');
    const legacyPath = await manager.preview(c.req.param('id'), href);
    if (!previewHosts) return c.redirect(legacyPath, 302);
    const target = new URL(href);
    const port = Number(target.port || (target.protocol === 'https:' ? 443 : 80));
    const host = serviceHost(c.req.param('id'), port, previewHosts.publicUrl, previewHosts.token);
    const base = new URL(previewHosts.publicUrl);
    return c.redirect(`${base.protocol}//${host}${target.pathname}${target.search}${target.hash}`, 302);
  });

  const service = async (c: Context) => {
    const projectId = c.req.param('id');
    if (!projectId) throw new HttpError(400, '项目 ID 无效');
    const port = Number(c.req.param('port'));
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new HttpError(400, '服务端口无效');
    const prefix = `/api/projects/${encodeURIComponent(projectId)}/service/${port}`;
    const url = new URL(c.req.url);
    const path = (url.pathname.slice(prefix.length) || '/') + url.search;
    return proxyProjectService(manager, projectId, port, path, c.req.raw, prefix);
  };
  app.all('/api/projects/:id/service/:port', service);
  app.all('/api/projects/:id/service/:port/*', service);

  const projectSchema = z.object({ name: z.string().trim().min(1).max(100), requirementUrl: z.string().trim().max(4096).url().refine(value => /^https?:\/\//i.test(value), '仅支持 HTTP 或 HTTPS 链接').nullable().optional() }).strict();
  app.get('/api/projects', async c => {
    c.header('Cache-Control', 'no-store');
    return c.json(await manager.listProjectsWithArchives());
  });
  const createSchema = projectSchema.extend({ imageId: z.string().min(1).max(4096).optional(), imageVersionId: z.string().min(1).max(200).optional(), name: z.string().trim().max(100).optional(), type: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional() })
    .refine(input => Boolean(input.name || input.requirementUrl), '请输入项目名称或绑定飞书需求')
    .refine(input => Boolean(input.imageId) === Boolean(input.imageVersionId), '镜像和版本必须一起选择');
  app.post('/api/projects', async c => {
    const { imageId, imageVersionId, ...input } = createSchema.parse(await c.req.json());
    if (imageId && !images) throw new HttpError(503, '镜像管理尚未初始化');
    const reservation = imageId ? await images!.acquireSelection(imageId, imageVersionId!) : undefined;
    try {
      return c.json(await manager.createProject({ ...input, ...(reservation?.selection ? { imageSelection: reservation.selection } : {}) }), 201);
    } finally { reservation?.release(); }
  });
  app.get('/api/projects/:id', async c => {
    c.header('Cache-Control', 'no-store');
    return c.json(await manager.readProject(c.req.param('id')));
  });
  app.patch('/api/projects/:id', async c => c.json(await manager.updateProject(c.req.param('id'), projectSchema.partial().extend({ status: z.enum(['active', 'completed', 'archived']).optional(), backupRetentionCount: z.number().int().min(2).max(100).optional() }).parse(await c.req.json()))));
  app.delete('/api/projects/:id', async c => { await manager.deleteProject(c.req.param('id')); return c.json({ ok: true }); });
}
