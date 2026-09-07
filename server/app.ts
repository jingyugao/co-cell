import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import type { AppConfig, StreamMessage } from '../shared/types.js';
import { HttpError, SessionManager } from './manager.js';
import { RawToolReader } from './raw-tools.js';
import { E2BSandboxInventory, type SandboxInventoryReader } from './sandboxes.js';
import { SharedFiles } from './shared-files.js';
import { templateManifestSchema, type TemplateManager } from './templates.js';
import type { ConnectionStore } from './connections.js';

const settingsSchema = z.object({
  executionMode: z.enum(['local', 'e2b']),
  workingDirectory: z.string().trim().min(1).max(4096),
  model: z.string().trim().max(200),
  modelReasoningEffort: z.enum(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'persistent']),
  sandboxMode: z.enum(['read-only', 'workspace-write', 'danger-full-access']),
  webSearchMode: z.enum(['disabled', 'cached', 'live']),
  networkAccessEnabled: z.boolean(),
}).partial().strict();

export function createApp(manager: SessionManager, config: AppConfig, allowedHosts: string[], rawTools = new RawToolReader(), sandboxes: SandboxInventoryReader = new E2BSandboxInventory(), sharedFiles = new SharedFiles(), templates?: TemplateManager, connections?: ConnectionStore) {
  const app = new Hono();
  const requireAllowedExecution = (mode: string | undefined) => {
    if (config.e2b?.enabled && mode !== 'e2b') throw new HttpError(403, '已启用 E2B 隔离执行，本机会话仅供查看历史；请在 E2B 项目中创建会话');
  };
  app.use('/api/*', async (c, next) => {
    const host = c.req.header('host');
    if (!host || !allowedHosts.includes(host)) return c.json({ error: '仅允许从本机访问' }, 403);
    const origin = c.req.header('origin');
    if (origin && !allowedHosts.some(hostname => origin === `http://${hostname}`)) {
      return c.json({ error: '不允许跨站请求' }, 403);
    }
    c.header('Cache-Control', 'no-store');
    c.header('X-Content-Type-Options', 'nosniff');
    await next();
  });
  app.use('/api/*', bodyLimit({ maxSize: 12 * 1024 * 1024, onError: c => c.json({ error: '请求过大，图片最大 10 MB' }, 413) }));
  app.onError((error, c) => {
    if (error instanceof HttpError) return c.json({ error: error.message }, error.status as 400);
    if (error instanceof z.ZodError) return c.json({ error: error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') }, 400);
    if (error instanceof SyntaxError) return c.json({ error: '请求 JSON 格式错误' }, 400);
    console.error('Request failed:', error.message);
    return c.json({ error: '服务器处理失败，请查看服务端日志' }, 500);
  });

  app.get('/api/config', c => c.json(config));
  app.get('/api/connections', async c => {
    if (!connections) throw new HttpError(503, '连接管理尚未初始化');
    return c.json(await connections.list());
  });
  app.post('/api/connections/import', async c => {
    if (!connections) throw new HttpError(503, '连接管理尚未初始化');
    try { return c.json(await connections.importLocal()); }
    catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(500, '本机凭据导入失败，原有副本保持不变'); }
  });
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
  const filePath = z.string().min(1).max(2048);
  const fileVersion = z.string().regex(/^[a-f0-9]{64}$/);
  const fileContent = z.string().max(1024 * 1024);
  app.get('/api/shared-files', async c => c.json(await sharedFiles.list()));
  app.get('/api/shared-files/content', async c => c.json(await sharedFiles.read(filePath.parse(c.req.query('path')))));
  app.post('/api/shared-files', async c => {
    const input = z.object({ path: filePath, content: fileContent }).strict().parse(await c.req.json());
    return c.json(await sharedFiles.write(input.path, input.content), 201);
  });
  app.put('/api/shared-files', async c => {
    const input = z.object({ path: filePath, content: fileContent, version: fileVersion }).strict().parse(await c.req.json());
    return c.json(await sharedFiles.write(input.path, input.content, input.version));
  });
  app.delete('/api/shared-files', async c => {
    const input = z.object({ path: filePath, version: fileVersion }).strict().parse(await c.req.json());
    return c.json(await sharedFiles.delete(input.path, input.version));
  });
  app.get('/api/sandboxes', async c => c.json(await sandboxes.read(manager.list(), manager.listProjects())));
  const projectSchema = z.object({ name: z.string().trim().min(1).max(100), requirementUrl: z.string().trim().max(4096).url().refine(value => /^https?:\/\//i.test(value), '仅支持 HTTP 或 HTTPS 链接').nullable().optional() }).strict();
  app.get('/api/projects', c => c.json(manager.listProjects()));
  app.post('/api/projects', async c => c.json(await manager.createProject(projectSchema.parse(await c.req.json())), 201));
  app.get('/api/projects/:id', c => c.json(manager.getProject(c.req.param('id'))));
  app.patch('/api/projects/:id', async c => c.json(await manager.updateProject(c.req.param('id'), projectSchema.partial().parse(await c.req.json()))));
  app.delete('/api/projects/:id', async c => { await manager.deleteProject(c.req.param('id')); return c.json({ ok: true }); });
  app.get('/api/sessions', c => c.json(manager.list()));
  app.post('/api/sessions', async c => {
    const input = z.object({
      projectId: z.string().uuid().optional(), settings: settingsSchema.optional(), threadId: z.string().uuid().optional(), title: z.string().trim().min(1).max(100).optional(),
    }).strict().parse(await c.req.json());
    // Mirror the manager's effective mode, including omitted settings and legacy
    // project defaults, before it can create or resume a host Codex thread.
    const project = input.projectId ? manager.getProject(input.projectId) : undefined;
    requireAllowedExecution(project?.executionMode ?? input.settings?.executionMode ?? config.defaults.executionMode);
    if (input.settings?.executionMode) requireAllowedExecution(input.settings.executionMode);
    return c.json(await manager.create(input), 201);
  });
  app.get('/api/sessions/:id', c => c.json(manager.get(c.req.param('id'))));
  app.patch('/api/sessions/:id', async c => {
    const input = z.object({ title: z.string().trim().min(1).max(100).optional(), settings: settingsSchema.optional() }).strict().parse(await c.req.json());
    requireAllowedExecution(manager.get(c.req.param('id')).settings.executionMode);
    if (input.settings?.executionMode) requireAllowedExecution(input.settings.executionMode);
    return c.json(await manager.update(c.req.param('id'), input));
  });
  app.delete('/api/sessions/:id', async c => {
    await manager.delete(c.req.param('id'));
    return c.json({ ok: true });
  });
  app.post('/api/sessions/:id/turns', async c => {
    const input = z.object({ prompt: z.string().trim().min(1).max(200_000), images: z.array(z.string().max(4096)).max(5).default([]) }).strict().parse(await c.req.json());
    requireAllowedExecution(manager.get(c.req.param('id')).settings.executionMode);
    const turnId = await manager.startTurn(c.req.param('id'), input.prompt, input.images);
    return c.json({ turnId }, 202);
  });
  app.post('/api/sessions/:id/stop', async c => {
    await manager.stop(c.req.param('id'));
    return c.json({ ok: true });
  });
  app.get('/api/sessions/:id/events', c => {
    const id = c.req.param('id');
    manager.get(id);
    return streamSSE(c, async stream => {
      let queue: Promise<void> = Promise.resolve();
      let closed = false;
      let finish!: () => void;
      const disconnected = new Promise<void>(resolve => { finish = resolve; });
      const send = (message: StreamMessage) => {
        queue = queue.then(async () => {
          if (!closed) await stream.writeSSE({ data: JSON.stringify(message) });
        }).catch(() => { closed = true; finish(); });
      };
      const unsubscribe = manager.subscribe(id, send);
      const heartbeat = setInterval(() => {
        queue = queue.then(async () => {
          if (!closed) await stream.write(': heartbeat\n\n');
        }).catch(() => { closed = true; finish(); });
      }, 15_000);
      stream.onAbort(() => { closed = true; finish(); });
      try { await disconnected; } finally { clearInterval(heartbeat); unsubscribe(); }
    });
  });
  app.get('/api/sessions/:id/changes', async c => {
    return c.json(await manager.changes(c.req.param('id')));
  });
  app.get('/api/sessions/:id/raw-tools', async c => {
    manager.get(c.req.param('id'));
    const cursor = z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).parse(c.req.query('cursor') ?? 0);
    return c.json(await manager.rawTools(c.req.param('id'), cursor, rawTools));
  });
  app.post('/api/sessions/:id/images', async c => {
    requireAllowedExecution(manager.get(c.req.param('id')).settings.executionMode);
    const form = await c.req.formData();
    const image = form.get('image');
    if (!(image instanceof File)) throw new HttpError(400, '请选择图片文件');
    if (image.size > 10 * 1024 * 1024 || image.size === 0) throw new HttpError(400, '图片大小须在 1 字节到 10 MB 之间');
    const bytes = new Uint8Array(await image.arrayBuffer());
    const header = Buffer.from(bytes);
    const extension = header.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? 'png'
      : header[0] === 255 && header[1] === 216 && header[2] === 255 ? 'jpg'
      : header.toString('ascii', 0, 4) === 'RIFF' && header.toString('ascii', 8, 12) === 'WEBP' ? 'webp'
      : null;
    if (!extension) throw new HttpError(400, '仅支持 PNG、JPEG 和 WebP 图片');
    const path = await manager.uploadImage(c.req.param('id'), bytes, extension);
    return c.json({ path, name: image.name }, 201);
  });
  app.all('/api/*', c => c.json({ error: '接口不存在' }, 404));
  return app;
}
