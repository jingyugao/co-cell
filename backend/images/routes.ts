import type { Hono } from 'hono';
import { z } from 'zod';
import type { ImageCatalog } from './service.js';
import { HttpError } from '../../util/errors.js';
import { CellboxError } from '../../packages/sandbox/src/providers/cellbox/client.js';

const auth = z.object({ username: z.string().min(1).max(1024), password: z.string().min(1).max(8192) }).strict();
const text = (max: number) => z.string().trim().min(1).max(max);
const importSchema = z.object({ imageId: text(200).optional(), name: text(100).optional(), category: text(100).optional(),
  version: text(100), url: text(4096).refine(value => !/\s|\0|:\/\//.test(value), '请输入 Docker 镜像引用，例如 registry/team/image:v1'),
  buildCommand: z.string().refine(value => !value.includes('\0') && Buffer.byteLength(value) <= 65536, '构建命令最多 64 KiB，不能包含 NUL').optional(),
  registryAuth: auth.optional() }).strict();

export function installImageRoutes(app: Hono, images?: ImageCatalog) {
  const requireImages = () => { if (!images) throw new HttpError(503, '镜像管理尚未初始化'); return images; };
  app.get('/api/images', async c => {
    try { return c.json(await requireImages().list()); }
    catch (error) { if (error instanceof CellboxError) throw new HttpError(502, '无法读取 Cellbox 镜像，请稍后重试'); throw error; }
  });
  app.post('/api/images/import', async c => c.json(await requireImages().import(importSchema.parse(await c.req.json())), 202));
  app.post('/api/images/:id/versions/:versionId/retry', async c => {
    const input = z.object({ registryAuth: auth.optional() }).strict().parse(await c.req.json());
    return c.json(await requireImages().retry(c.req.param('id'), c.req.param('versionId'), input.registryAuth), 202);
  });
}
