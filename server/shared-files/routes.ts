import type { Hono } from 'hono';
import { z } from 'zod';
import { HttpError } from '../core/errors.js';
import type { SharedFiles } from './service.js';

export function installSharedFilesRoutes(app: Hono, sharedFiles: SharedFiles) {
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
}
