import type { Hono } from 'hono';
import { z } from 'zod';
import type { SecretService } from './service.js';
import { TOOL_NAME_PATTERN } from '../../util/tool-secrets.js';
import { HttpError } from '../../util/errors.js';
const id = z.string().uuid();
const alias = z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/);
const tool = z.string().trim().regex(TOOL_NAME_PATTERN);
const content = z.string().min(1).max(90000);
const policy = z.object({ namespaces: z.array(z.string().min(1).max(100)).max(100), resources: z.array(z.string().min(1).max(100)).max(100), commandPrefixes: z.array(z.array(z.string().min(1).max(200)).min(1).max(16)).max(100) }).strict();
const path = z.string().min(1).max(256);
const fileFields = {
  format: z.enum(['text', 'files']), content: content.optional(),
  files: z.array(z.object({ path, content: z.string().max(1500000), encoding: z.literal('base64').optional() }).strict()).min(1).max(128).optional(),
  directory: path.optional(),
  adapter: z.literal('meegle').optional(),
  identity: z.object({ hostname: z.string().min(1).max(253), username: z.string().min(1).max(253) }).strict().optional(),
};
const grant = z.object({ tool, alias: alias.default('default'), enabled: z.boolean(), files: z.array(z.object({ secretId: id, path }).strict()).length(1), policy: policy.optional() }).strict();
export function installSecretRoutes(app: Hono, secrets: SecretService, projectExists: (id: string) => boolean) {
  const project = (value: string) => { id.parse(value); if (!projectExists(value)) throw new HttpError(404, '项目不存在'); return value; };
  app.get('/api/secrets', async c => c.json(await secrets.list()));
  app.post('/api/secrets', async c => c.json(await secrets.create(z.object({ name: z.string().trim().min(1).max(100), ...fileFields, format: fileFields.format.default('text'), mutable: z.boolean().default(false), tool, path }).strict().parse(await c.req.json())), 201));
  app.get('/api/secrets/:id/content', async c => c.json(await secrets.content(id.parse(c.req.param('id')))));
  app.patch('/api/secrets/:id', async c => c.json(await secrets.update(id.parse(c.req.param('id')), z.object({ name: z.string().trim().min(1).max(100).optional(), mutable: z.boolean().optional(), enabled: z.boolean().optional(), ...fileFields, format: fileFields.format.optional(), tool: tool.optional(), path: path.optional() }).strict().parse(await c.req.json()))));
  app.delete('/api/secrets/:id', async c => c.json(await secrets.delete(id.parse(c.req.param('id')))));
  app.get('/api/secrets/:id/versions', async c => c.json(await secrets.versions(id.parse(c.req.param('id')))));
  app.get('/api/projects/:id/tool-grants', async c => c.json(await secrets.grants(project(c.req.param('id')))));
  app.post('/api/projects/:id/tool-grants', async c => c.json(await secrets.saveGrant(project(c.req.param('id')), grant.parse(await c.req.json()))));
  app.put('/api/projects/:id/tool-grants', async c => {
    const input = z.object({ selections: z.array(z.object({ tool, secretId: id.nullable() }).strict()).max(256) }).strict().parse(await c.req.json());
    return c.json(await secrets.saveSelections(project(c.req.param('id')), input.selections));
  });
  app.delete('/api/projects/:id/tool-grants/:grantId', async c => { await secrets.deleteGrant(project(c.req.param('id')), id.parse(c.req.param('grantId'))); return c.json({ ok: true }); });
  const token = (header: string | undefined) => { if (!header?.startsWith('Bearer ')) throw new HttpError(401, '工具认证无效'); return header.slice(7); };
  app.post('/api/tool-runtime/files', async c => {
    const input = z.object({ tool, updates: z.array(z.object({ secretId: id, content: z.string().max(1500000), baseVersion: z.number().int().min(1), format: fileFields.format.optional() }).strict()).max(10), exitCode: z.number().int().min(-1).max(255) }).strict().parse(await c.req.json());
    return c.json(await secrets.syncFiles(token(c.req.header('authorization')), input.tool, input.updates, input.exitCode));
  });
  app.post('/api/tool-runtime/start', async c => {
    const input = z.object({ tool, alias: alias.optional(), args: z.array(z.string().max(8192)).max(32) }).strict().parse(await c.req.json());
    return c.json(await secrets.start(token(c.req.header('authorization')), input.tool, input.alias, input.args));
  });
  app.post('/api/tool-runtime/:id/complete', async c => {
    const input = z.object({ updates: z.array(z.object({ secretId: id, content: z.string().max(1500000) }).strict()).max(10), exitCode: z.number().int().min(-1).max(255) }).strict().parse(await c.req.json());
    return c.json(await secrets.complete(token(c.req.header('authorization')), id.parse(c.req.param('id')), input.updates, input.exitCode));
  });
}
