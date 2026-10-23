import type { Hono } from 'hono';
import { z } from 'zod';
import type { SecretService } from './service.js';
import { TOOL_NAME_PATTERN } from '../../util/tool-secrets.js';
import { HttpError } from '../../util/errors.js';
const id = z.string().uuid();
const tool = z.string().trim().regex(TOOL_NAME_PATTERN);
export function installSecretRoutes(app: Hono, secrets: SecretService, projectExists: (id: string) => boolean) {
  const project = (value: string) => { id.parse(value); if (!projectExists(value)) throw new HttpError(404, '项目不存在'); return value; };
  const permission = z.object({ tool, enabled: z.boolean(), credentials: z.array(z.string().min(1).max(256)).max(256).optional() }).strict();
  const roleInput = z.object({ name: z.string().trim().min(1).max(100), permissions: z.array(permission).max(256) }).strict();
  const assignment = z.object({ roleId: id.nullable() }).strict();
  app.get('/api/tool-roles', async c => c.json(await secrets.roles.catalog()));
  app.get('/api/tools', async c => c.json(await secrets.toolCatalog()));
  app.post('/api/tool-roles', async c => c.json(await secrets.roles.save(roleInput.parse(await c.req.json())), 201));
  app.put('/api/tool-roles/default', async c => c.json(await secrets.roles.setDefault(z.object({ roleId: id }).strict().parse(await c.req.json()).roleId)));
  app.put('/api/tool-roles/:id', async c => c.json(await secrets.roles.save(roleInput.parse(await c.req.json()), id.parse(c.req.param('id')))));
  app.delete('/api/tool-roles/:id', async c => c.json(await secrets.roles.delete(id.parse(c.req.param('id')))));
  app.get('/api/projects/:id/tool-role', async c => c.json(await secrets.roles.state(project(c.req.param('id')))));
  app.put('/api/projects/:id/tool-role', async c => c.json(await secrets.roles.assign(project(c.req.param('id')), assignment.parse(await c.req.json()).roleId)));
  const boxId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,54}$/);
  app.post('/api/tool-runtime/authorize', async c => {
    const input = z.object({ boxId, tool, args: z.array(z.string().max(8192)).max(32) }).strict().parse(await c.req.json());
    return c.json(await secrets.authorize(input.boxId, input.tool, input.args));
  });
}
