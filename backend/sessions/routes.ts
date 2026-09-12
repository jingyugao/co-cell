import type { Hono } from 'hono';
import { z } from 'zod';
import { HttpError } from '../core/errors.js';
import { streamSSE } from 'hono/streaming';
import type { AppConfig, StreamMessage } from '../../protocol/types.js';
import type { SessionManager } from './manager.js';
import type { RawToolReader } from '../execution/raw-tools.js';

const settingsSchema = z.object({
  executionMode: z.enum(['local', 'e2b']),
  workingDirectory: z.string().trim().min(1).max(4096),
  model: z.string().trim().max(200),
  modelReasoningEffort: z.enum(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'persistent']),
  sandboxMode: z.enum(['read-only', 'workspace-write', 'danger-full-access']),
  webSearchMode: z.enum(['disabled', 'cached', 'live']),
  networkAccessEnabled: z.boolean(),
}).partial().strict();

export function installSessionsRoutes(app: Hono, manager: SessionManager, config: AppConfig, rawTools: RawToolReader) {
  const requireAllowedExecution = (mode: string | undefined) => {
    if (config.e2b?.enabled && mode !== 'e2b') throw new HttpError(403, '已启用 E2B 隔离执行，本机会话仅供查看历史；请在 E2B 项目中创建会话');
  };
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
  app.get('/api/sessions/:id', async c => c.json(await manager.read(c.req.param('id'))));
  app.get('/api/sessions/:id/billing', async c => c.json(await manager.billing(c.req.param('id'))));
  app.patch('/api/sessions/:id', async c => {
    const input = z.object({ title: z.string().trim().min(1).max(100).optional(), settings: settingsSchema.optional(), archived: z.boolean().optional() }).strict().parse(await c.req.json());
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
  app.post('/api/sessions/:id/turns/:turnId/approvals/:approvalId', async c => {
    return c.json(await manager.resolveApproval(c.req.param('id'), c.req.param('turnId'), c.req.param('approvalId'), await c.req.json()));
  });
  app.get('/api/sessions/:id/events', async c => {
    const id = c.req.param('id');
    await manager.read(id);
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
}
