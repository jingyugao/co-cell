import type { Hono } from 'hono';
import { z } from 'zod';
import { posix } from 'node:path';
import type { SessionManager } from '../sessions/manager.js';
import type { FileFavoriteRepository } from './repository.js';
import { workspaceFilePath } from '../sandboxes/cellbox-files.js';
import { HttpError } from '../../util/errors.js';

export function installFileFavoriteRoutes(app: Hono, manager: Pick<SessionManager, 'readProject'>, repository?: FileFavoriteRepository) {
  const store = () => {
    if (!repository) throw new HttpError(503, '文件收藏尚未初始化');
    return repository;
  };
  app.get('/api/file-favorites', async c => c.json({ favorites: await store().list() }));
  app.post('/api/file-favorites', async c => {
    const input = z.object({ projectId: z.string().uuid(), path: z.string().min(1).max(4096) }).strict().parse(await c.req.json());
    const project = await manager.readProject(input.projectId);
    if (project.status === 'deleting') throw new HttpError(409, '项目正在删除');
    if (project.executionMode !== 'sandbox') throw new HttpError(400, '仅支持收藏 Sandbox 项目文件');
    const path = workspaceFilePath(project.workingDirectory, input.path);
    if (path === posix.normalize(project.workingDirectory)) throw new HttpError(400, '请选择文件');
    return c.json(await store().save(project.id, path), 201);
  });
  app.delete('/api/file-favorites/:id', async c => {
    await store().remove(z.string().uuid().parse(c.req.param('id')));
    return c.json({ ok: true });
  });
}
