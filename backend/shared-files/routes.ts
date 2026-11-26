import type { Hono } from 'hono';
import { z } from 'zod';
import { HttpError } from '../../util/errors.js';
import type { SharedFiles } from './service.js';

type Files = Pick<SharedFiles,'list'|'read'|'write'|'delete'>;
export function installSharedFilesRoutes(app: Hono, service: Files | ((id:string) => Files), base = '/api/shared-files') {
  const files = (id?:string) => typeof service === 'function' ? service(id!) : service;
  const filePath = z.string().min(1).max(2048);
  const fileVersion = z.string().regex(/^[a-f0-9]{64}$/);
  const fileContent = z.string().max(1024 * 1024);
  app.get(base, async c => c.json(await files(c.req.param('id')).list()));
  app.get(base+'/content', async c => c.json(await files(c.req.param('id')).read(filePath.parse(c.req.query('path')))));
  app.post(base, async c => {
    const input = z.object({ path: filePath, content: fileContent }).strict().parse(await c.req.json());
    return c.json(await files(c.req.param('id')).write(input.path, input.content), 201);
  });
  app.put(base, async c => {
    const input = z.object({ path: filePath, content: fileContent, version: fileVersion }).strict().parse(await c.req.json());
    return c.json(await files(c.req.param('id')).write(input.path, input.content, input.version));
  });
  app.delete(base, async c => {
    const input = z.object({ path: filePath, version: fileVersion }).strict().parse(await c.req.json());
    return c.json(await files(c.req.param('id')).delete(input.path, input.version));
  });
}
