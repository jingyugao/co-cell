import type { ImageCatalog } from '../images/service.js';
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { HttpError } from '../../util/errors.js';
import type { SessionManager } from '../sessions/manager.js';
import { workspaceFileResponse } from '../workspaces/http-files.js';
import { applicationCookies, applicationSetCookie, previewLocation } from './preview-policy.js';
import { serviceHost } from './service-host.js';
import { PROJECT_OPERATION_WAIT_MS } from '../../protocol/types.js';

type ProjectRoutesManager = Pick<SessionManager, 'listProjects' | 'listProjectsWithArchives' | 'getProject' | 'readProject' | 'enterProject' | 'createProject' | 'updateProject' | 'deleteProject' | 'preview' | 'projectService' | 'projectFileResponse' | 'createProjectSandbox' | 'restoreProjectSandbox' | 'rebuildProjectSandbox' | 'resumeProjectSandbox' | 'releaseProjectSandbox' | 'checkpointProjectSandbox' | 'archiveProjectNow' | 'backupProjectNow' | 'refreshProjectSandboxRuntime'>;

function projectOperationResponse(c: Context, project: Awaited<ReturnType<ProjectRoutesManager['enterProject']>>) {
  return c.json(project, 200);
}

export async function proxyProjectService(manager: Pick<SessionManager, 'projectService'>, projectId: string, port: number,
  path: string, request: Request, prefix: string, isolatedOrigin = false): Promise<Response> {
  const requestHeaders = new Headers(request.headers);
  const cookie = isolatedOrigin ? applicationCookies(requestHeaders.get('cookie')) : undefined;
  if (cookie) requestHeaders.set('cookie', cookie); else requestHeaders.delete('cookie');
  const response = await manager.projectService(projectId, port, path, new Request(request, { headers: requestHeaders }));
  const headers = new Headers(response.headers);
  const location = headers.get('location');
  if (location) headers.set('location', previewLocation(location, port, path, prefix));
  headers.delete('set-cookie');
  if (isolatedOrigin) for (const raw of response.headers.getSetCookie()) {
    const cookie = applicationSetCookie(raw);
    if (cookie) headers.append('set-cookie', cookie);
  }
  headers.set('Cache-Control', 'no-store');
  if (!isolatedOrigin) headers.set('Content-Security-Policy', 'sandbox allow-scripts allow-forms allow-popups');
  headers.set('Referrer-Policy', isolatedOrigin ? 'same-origin' : 'no-referrer');
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
    return projectOperationResponse(c, await manager.archiveProjectNow(c.req.param('id'), input));
  });
  app.post('/api/projects/:id/backup', async c => projectOperationResponse(c, await manager.backupProjectNow(c.req.param('id'))));
  app.post('/api/projects/:id/sandbox/rebuild', async c => {
    const body = await c.req.text();
    let parsed: unknown;
    try { parsed = body ? JSON.parse(body) : {}; } catch { throw new HttpError(400, '请求 JSON 无效'); }
    const input = z.object({ imageVersionId: z.string().min(1).max(256).optional() }).strict().parse(parsed);
    return projectOperationResponse(c, await manager.rebuildProjectSandbox(c.req.param('id'), input.imageVersionId));
  });
  app.post('/api/projects/:id/sandbox/create', async c => projectOperationResponse(c,
    await manager.createProjectSandbox(c.req.param('id'))));
  app.post('/api/projects/:id/sandbox/restore', async c => {
    const body = await c.req.text();
    let parsed: unknown;
    try { parsed = body ? JSON.parse(body) : {}; } catch { throw new HttpError(400, '请求 JSON 无效'); }
    const input = z.object({ imageVersionId: z.string().min(1).max(256).optional() }).strict().parse(parsed);
    return projectOperationResponse(c, await manager.restoreProjectSandbox(c.req.param('id'), input.imageVersionId));
  });
  app.post('/api/projects/:id/open', async c => projectOperationResponse(c,
    await manager.enterProject(c.req.param('id'), c.req.raw.signal)));
  app.post('/api/projects/:id/sandbox/resume', async c => projectOperationResponse(c,
    await manager.resumeProjectSandbox(c.req.param('id'), c.req.raw.signal)));
  app.post('/api/projects/:id/sandbox/checkpoint', async c => projectOperationResponse(c, await manager.checkpointProjectSandbox(c.req.param('id'))));
  app.post('/api/projects/:id/sandbox/release', async c => projectOperationResponse(c, await manager.releaseProjectSandbox(c.req.param('id'))));
  app.post('/api/projects/:id/sandbox/refresh-runtime', async c => projectOperationResponse(c, await manager.refreshProjectSandboxRuntime(c.req.param('id'))));
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
    const reservation = imageId ? await images!.acquireSelection(imageId, imageVersionId!) : await images?.acquireLatestSelection();
    try {
      return c.json(await manager.createProject({ ...input, ...(reservation?.selection ? { imageSelection: reservation.selection } : {}) }), 201);
    } finally { await reservation?.release(); }
  });
  app.get('/api/projects/:id', async c => {
    c.header('Cache-Control', 'no-store');
    const options = z.object({
      waitForOperation: z.string().min(1).max(200).optional(),
      waitMs: z.coerce.number().int().min(0).max(PROJECT_OPERATION_WAIT_MS).optional(),
    }).refine(input => input.waitForOperation !== undefined || input.waitMs === undefined, '等待操作时须提供 operation ID')
      .parse({ waitForOperation: c.req.query('waitForOperation'), waitMs: c.req.query('waitMs') });
    return c.json(await manager.readProject(c.req.param('id'), options, c.req.raw.signal));
  });
  app.patch('/api/projects/:id', async c => c.json(await manager.updateProject(c.req.param('id'), projectSchema.partial().extend({ status: z.enum(['active', 'completed', 'archived']).optional() }).parse(await c.req.json()))));
  app.delete('/api/projects/:id', async c => { await manager.deleteProject(c.req.param('id')); return c.json({ ok: true }); });
}
