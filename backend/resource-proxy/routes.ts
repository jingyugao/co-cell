import type { Hono } from 'hono';
import { z } from 'zod';
import { RESOURCE_NAME } from '../../protocol/api-resource-types.js';
import { HttpError } from '../../util/errors.js';
import type { ApiResourceStore } from './store.js';

const settings = z.object({
  name: z.string().regex(RESOURCE_NAME), description: z.string().trim().max(500).default(''),
  endpoint: z.string().trim().min(1).max(2048), authHeader: z.string().trim().max(128).default(''),
  authScheme: z.string().regex(/^[A-Za-z0-9_-]{0,64}$/).default(''), apiKey: z.string().min(1).max(8192).optional(),
  headers: z.array(z.object({ name: z.string().trim().min(1).max(128), value: z.string().max(8192).optional() }).strict()).max(64).optional(),
}).strict();
const revision = z.string().uuid();

export function installApiResourceRoutes(app: Hono, store: ApiResourceStore) {
  const path = '/api/proxy-resources';
  app.get(path, async c => c.json(await store.list()));
  app.post(path, async c => c.json(await store.save(settings.parse(await c.req.json())), 201));
  app.put('/api/proxy-resources/:name', async c => {
    const { revision: expected, ...input } = settings.extend({ revision }).parse(await c.req.json());
    if (c.req.param('name') !== input.name) throw new HttpError(400, '资源名不能修改');
    return c.json(await store.save(input, expected));
  });
  app.delete('/api/proxy-resources/:name', async c => {
    const input = z.object({ revision }).strict().parse(await c.req.json());
    await store.remove(c.req.param('name'), input.revision);
    return c.body(null, 204);
  });
}
