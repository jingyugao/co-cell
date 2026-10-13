import type { Hono } from 'hono';
import { z } from 'zod';
import type { SecretService } from './service.js';
import { TOOL_NAME_PATTERN } from '../../util/tool-secrets.js';
import { HttpError } from '../../util/errors.js';
const id = z.string().uuid();
const tool = z.string().trim().regex(TOOL_NAME_PATTERN);
const content = z.string().min(1).max(90000);
const path = z.string().min(1).max(256);
const fileFields = {
  format: z.enum(['text', 'files']), content: content.optional(),
  supportFiles: z.array(z.object({ path, content, encoding: z.literal('base64') }).strict()).min(2).max(3).optional(),
  files: z.array(z.object({ path, content: z.string().max(1500000), encoding: z.literal('base64').optional() }).strict()).min(1).max(128).optional(),
  directory: path.optional(),
  adapter: z.literal('meegle').optional(),
  identity: z.object({ hostname: z.string().min(1).max(253), username: z.string().min(1).max(253) }).strict().optional(),
};
export function installSecretRoutes(app: Hono, secrets: SecretService, projectExists: (id: string) => boolean) {
  const project = (value: string) => { id.parse(value); if (!projectExists(value)) throw new HttpError(404, '项目不存在'); return value; };
  const roleInput = z.object({ name: z.string().trim().min(1).max(100), connections: z.array(z.object({ tool, secretId: id }).strict()).max(256) }).strict();
  const assignment = z.object({ roleId: id.nullable() }).strict();
  app.get('/api/tool-roles', async c => c.json(await secrets.roles.catalog()));
  app.post('/api/tool-roles', async c => c.json(await secrets.roles.save(roleInput.parse(await c.req.json())), 201));
  app.put('/api/tool-roles/default', async c => c.json(await secrets.roles.setDefault(z.object({ roleId: id }).strict().parse(await c.req.json()).roleId)));
  app.put('/api/tool-roles/:id', async c => c.json(await secrets.roles.save(roleInput.parse(await c.req.json()), id.parse(c.req.param('id')))));
  app.delete('/api/tool-roles/:id', async c => c.json(await secrets.roles.delete(id.parse(c.req.param('id')))));
  app.get('/api/projects/:id/tool-role', async c => c.json(await secrets.roles.state(project(c.req.param('id')))));
  app.put('/api/projects/:id/tool-role', async c => c.json(await secrets.roles.assign(project(c.req.param('id')), assignment.parse(await c.req.json()).roleId)));
  app.get('/api/secrets', async c => c.json(await secrets.list()));
  app.post('/api/secrets', async c => c.json(await secrets.create(z.object({ name: z.string().trim().min(1).max(100), ...fileFields, format: fileFields.format.default('text'), mutable: z.boolean().default(false), tool, path }).strict().parse(await c.req.json())), 201));
  app.get('/api/secrets/:id/content', async c => c.json(await secrets.content(id.parse(c.req.param('id')))));
  app.patch('/api/secrets/:id', async c => c.json(await secrets.update(id.parse(c.req.param('id')), z.object({ name: z.string().trim().min(1).max(100).optional(), mutable: z.boolean().optional(), enabled: z.boolean().optional(), ...fileFields, format: fileFields.format.optional(), tool: tool.optional(), path: path.optional() }).strict().parse(await c.req.json()))));
  app.delete('/api/secrets/:id', async c => c.json(await secrets.delete(id.parse(c.req.param('id')))));
  app.get('/api/secrets/:id/versions', async c => c.json(await secrets.versions(id.parse(c.req.param('id')))));
  const boxId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,54}$/);
  app.post('/api/tool-runtime/authorize', async c => {
    const input = z.object({ boxId, tool, args: z.array(z.string().max(8192)).max(32) }).strict().parse(await c.req.json());
    return c.json(await secrets.authorize(input.boxId, input.tool, input.args));
  });
}
