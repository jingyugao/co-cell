import type { Hono } from 'hono';
import { z } from 'zod';
import type { ImageCatalog } from './service.js';
import { HttpError } from '../../util/errors.js';
import { CellboxError } from '../../packages/sandbox/src/providers/cellbox/client.js';

const auth = z.object({ username: z.string().min(1).max(1024), password: z.string().min(1).max(8192) }).strict();
const text = (max: number) => z.string().trim().min(1).max(max);
const repositorySchema = z.object({ name: text(100), category: text(100), repository: text(2048),
  buildCommand: z.string().refine(value => !value.includes('\0') && Buffer.byteLength(value) <= 65536, '构建命令最多 64 KiB，不能包含 NUL').optional(),
  registryAuthRequired: z.boolean().optional() }).strict();
const tag = text(128).regex(/^[\w][\w.-]{0,127}$/, '无效的上游 Tag');

export function installImageRoutes(app: Hono, images?: ImageCatalog) {
  const requireImages = () => { if (!images) throw new HttpError(503, '镜像管理尚未初始化'); return images; };
  app.get('/api/images', async c => {
    try { return c.json(await requireImages().list()); }
    catch (error) { if (error instanceof CellboxError) throw new HttpError(502, '无法读取 Cellbox 镜像，请稍后重试'); throw error; }
  });
  app.post('/api/images/repositories', async c => c.json(await requireImages().addRepository(repositorySchema.parse(await c.req.json())), 201));
  app.post('/api/images/:id/tags', async c => {
    const input = z.object({ registryAuth: auth.optional(), last: tag.optional() }).strict().parse(await c.req.json());
    return c.json(await requireImages().tags(c.req.param('id'), input.registryAuth, input.last));
  });
  app.post('/api/images/:id/versions/sync', async c => {
    const input = z.object({ tag, registryAuth: auth.optional() }).strict().parse(await c.req.json());
    return c.json(await requireImages().sync(c.req.param('id'), input), 202);
  });
  app.post('/api/images/:id/versions/:versionId/retry', async c => {
    const input = z.object({ registryAuth: auth.optional() }).strict().parse(await c.req.json());
    return c.json(await requireImages().retry(c.req.param('id'), c.req.param('versionId'), input.registryAuth), 202);
  });
  app.post('/api/images/:id/versions/:versionId/default', async c => c.json(await requireImages().setDefault(c.req.param('id'), c.req.param('versionId'))));
  app.get('/api/images/:id/versions/:versionId/usage', async c => c.json(await requireImages().usage(c.req.param('id'), c.req.param('versionId'))));
  app.delete('/api/images/:id/versions/:versionId', async c => c.json(await requireImages().removeVersion(c.req.param('id'), c.req.param('versionId')), 202));
}
