import type { Hono } from 'hono';
import { z } from 'zod';
import type { SecretService } from './service.js';
import { PROXY_TOOLS } from './policy.js';
import { HttpError } from '../../util/errors.js';
const id = z.string().uuid();
const alias = z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/);
const tool = z.enum(PROXY_TOOLS);
const content = z.string().min(1).max(90000);
const policy = z.object({ namespaces: z.array(z.string().min(1).max(100)).max(100), resources: z.array(z.string().min(1).max(100)).max(100), commandPrefixes: z.array(z.array(z.string().min(1).max(200)).min(1).max(16)).max(100) }).strict();
const grant = z.object({ tool, alias, enabled: z.boolean(), files: z.array(z.object({ secretId: id, path: z.string().min(1).max(256) }).strict()).length(1), policy: policy.optional() }).strict();
const toolConfig = { tool: tool.optional(), path: z.string().min(1).max(256).optional(), alias: alias.optional() };
export function installSecretRoutes(app: Hono, secrets: SecretService, projectExists: (id: string) => boolean) {
  const project = (value: string) => { id.parse(value); if (!projectExists(value)) throw new HttpError(404, '项目不存在'); return value; };
  app.get('/api/secrets', async c => c.json(await secrets.list()));
  app.post('/api/secrets', async c => c.json(await secrets.create(z.object({ name: z.string().trim().min(1).max(100), format: z.enum(['json', 'text', 'binary']), mutable: z.boolean(), content, ...toolConfig }).strict().parse(await c.req.json())), 201));
  app.get('/api/secrets/:id/content', async c => c.json(await secrets.content(id.parse(c.req.param('id')))));
  app.patch('/api/secrets/:id', async c => c.json(await secrets.update(id.parse(c.req.param('id')), z.object({ name: z.string().trim().min(1).max(100).optional(), mutable: z.boolean().optional(), enabled: z.boolean().optional(), content: content.optional(), ...toolConfig }).strict().parse(await c.req.json()))));
  app.get('/api/secrets/:id/versions', async c => c.json(await secrets.versions(id.parse(c.req.param('id')))));
  app.get('/api/projects/:id/tool-grants', async c => c.json(await secrets.grants(project(c.req.param('id')))));
  app.post('/api/projects/:id/tool-grants', async c => c.json(await secrets.saveGrant(project(c.req.param('id')), grant.parse(await c.req.json()))));
  app.put('/api/projects/:id/tool-grants', async c => {
    const input = z.object({ selections: z.array(z.object({ tool, secretId: id.nullable() }).strict()).length(PROXY_TOOLS.length) }).strict().parse(await c.req.json());
    return c.json(await secrets.saveSelections(project(c.req.param('id')), input.selections));
  });
  app.delete('/api/projects/:id/tool-grants/:grantId', async c => { await secrets.deleteGrant(project(c.req.param('id')), id.parse(c.req.param('grantId'))); return c.json({ ok: true }); });
  const token = (header: string | undefined) => { if (!header?.startsWith('Bearer ')) throw new HttpError(401, '工具认证无效'); return header.slice(7); };
  app.post('/api/tool-runtime/start', async c => {
    const input = z.object({ tool, alias: alias.optional(), args: z.array(z.string().max(8192)).max(32) }).strict().parse(await c.req.json());
    return c.json(await secrets.start(token(c.req.header('authorization')), input.tool, input.alias, input.args));
  });
  app.post('/api/tool-runtime/:id/complete', async c => {
    const input = z.object({ updates: z.array(z.object({ secretId: id, content: z.string().max(90000) }).strict()).max(10), exitCode: z.number().int().min(-1).max(255) }).strict().parse(await c.req.json());
    return c.json(await secrets.complete(token(c.req.header('authorization')), id.parse(c.req.param('id')), input.updates, input.exitCode));
  });
}
