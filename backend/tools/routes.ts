import type { Hono } from 'hono';
import { z } from 'zod';
import { TOOL_NAME_PATTERN } from '../../util/tool-secrets.js';
import { HttpError } from '../../util/errors.js';
import type { DynamicTools } from './service.js';
import type { SecretService } from '../secrets/service.js';

const name = z.string().regex(TOOL_NAME_PATTERN);
const version = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const scriptId = z.string().uuid().nullish().transform(value => value ?? undefined);
const input = z.object({
  name, description: z.string().max(1000), instructions: z.string().max(16000), enabled: z.boolean(),
  executable: z.string().min(1).max(1024), packageVersion: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  args: z.array(z.string().max(8192)).max(32), env: z.record(z.string().max(128), z.string().max(8192)).refine(value => Object.keys(value).length <= 64, '环境变量最多 64 项'),
  credentialPath: z.string().min(1).max(256).optional(), permissionScript: z.string().min(1).max(16000).optional(),
  credentialPaths: z.array(z.string().min(1).max(256)).max(16).optional(),
  permissionScriptId: scriptId, credentialParseScriptId: scriptId, credentialSaveScriptId: scriptId,
  timeoutMs: z.number().int().min(100).max(20000),
}).strict();
const createInput = input.partial().extend({ name });

export function installToolRoutes(app: Hono, tools: DynamicTools, secrets?: SecretService) {
  app.get('/api/tool-definitions', async c => c.json(await tools.list()));
  app.post('/api/tool-definitions', async c => c.json(await tools.create(createInput.parse(await c.req.json())), 201));
  app.put('/api/tool-definitions/:name', async c => {
    const body = input.extend({ version }).parse(await c.req.json());
    if (body.name !== name.parse(c.req.param('name'))) throw new HttpError(400, '工具名不能修改');
    const { version: expected, ...definition } = body;
    return c.json(await tools.save(definition, expected));
  });
  app.delete('/api/tool-definitions/:name', async c => {
    const body = z.object({ version }).strict().parse(await c.req.json());
    return c.json(await tools.delete(name.parse(c.req.param('name')), body.version));
  });
  app.get('/api/tool-packages', async c => c.json(await tools.packages.list()));
  app.post('/api/tool-packages', async c => {
    const body = z.object({ files: z.array(z.object({ path: z.string().min(1).max(512), content: z.string().max(45 * 1024 * 1024),
      encoding: z.enum(['utf8', 'base64']), executable: z.boolean() }).strict()).min(1).max(128) }).strict().parse(await c.req.json());
    return c.json(await tools.packages.upload(body), 201);
  });
  if (!secrets) return;
  const scriptInput = z.object({ name: z.string().trim().min(1).max(100), language: z.enum(['typescript', 'bash']), source: z.string().min(1).max(16000) }).strict();
  app.get('/api/tool-scripts', async c => c.json(await secrets.scripts.list()));
  app.post('/api/tool-scripts', async c => c.json(await secrets.scripts.save(scriptInput.parse(await c.req.json())), 201));
  app.put('/api/tool-scripts/:id', async c => {
    const { version: expected, ...body } = scriptInput.extend({ version }).parse(await c.req.json());
    return c.json(await secrets.scripts.save(body, z.string().uuid().parse(c.req.param('id')), expected));
  });
  app.delete('/api/tool-scripts/:id', async c => c.json(await secrets.scripts.delete(z.string().uuid().parse(c.req.param('id')),
    z.object({ version }).strict().parse(await c.req.json()).version)));
  const files = () => { if (!secrets.credentialFiles) throw new HttpError(503, '凭据目录尚未初始化'); return secrets.credentialFiles; };
  const path = z.string().min(1).max(256);
  app.get('/api/tools/:name/credentials', async c => c.json(await files().tree(name.parse(c.req.param('name')))));
  app.get('/api/tools/:name/credentials/file', async c => c.json(await files().read(name.parse(c.req.param('name')), path.parse(c.req.query('path')))));
  app.put('/api/tools/:name/credentials/file', async c => {
    const body = z.object({ path, content: z.string().max(1500000), encoding: z.enum(['utf8', 'base64', 'parsed']),
      version: z.string().regex(/^[a-f0-9]{64}$/), scriptVersion: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) }).strict().parse(await c.req.json());
    if (body.path !== path.parse(c.req.query('path'))) throw new HttpError(400, '文件路径不一致');
    return c.json(await files().write(name.parse(c.req.param('name')), body));
  });
}
