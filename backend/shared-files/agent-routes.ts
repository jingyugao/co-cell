import type { Hono } from 'hono';
import { z } from 'zod';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { AgentProfiles } from './agent-profiles.js';
import { skillName } from './github-skill.js';
import { SharedFiles } from './service.js';
import { installSharedFilesRoutes } from './routes.js';
import { HttpError } from '../../util/errors.js';

export function profileFiles(catalog: AgentProfiles, id: string) {
  return {
    list: async () => catalog.files(await catalog.get(id)).list(),
    read: async (path: string) => catalog.files(await catalog.get(id)).read(path),
    write: async (path: string, content: string, expected?: string) => {
      const profile = await catalog.edit(id, async (assets) => {
        await new SharedFiles(assets, true, undefined, true).write(path, content, expected);
      });
      return catalog.files(profile).read(path);
    },
    delete: async (path: string, expected: string) => {
      await catalog.edit(id, async (assets) => {
        await new SharedFiles(assets, true, undefined, true).delete(path, expected);
      });
      return { ok: true };
    },
  };
}
export function installAgentRoutes(app: Hono, catalog: AgentProfiles) {
  const label = z.string().trim().min(1).max(100),
    revision = z.string().regex(/^[a-f0-9]{64}$/);
  app.get('/api/agents', async (c) => c.json(await catalog.list()));
  app.post('/api/agents', async (c) => {
    const p = z
      .object({ name: label, description: z.string().trim().max(500).default(''), copyFrom: z.string().optional() })
      .strict()
      .parse(await c.req.json());
    return c.json(await catalog.create(p.name, p.description, p.copyFrom), 201);
  });
  app.patch('/api/agents/:id', async (c) => {
    const info = z
      .object({ name: label, description: z.string().trim().max(500) })
      .strict()
      .parse(await c.req.json());
    return c.json(
      await catalog.edit(c.req.param('id'), async (_, profile) => {
        Object.assign(profile, info);
      }),
    );
  });
  app.post('/api/agents/:id/remote-skills', async (c) => {
    const { expectedRevision, ...source } = z
      .object({
        name: z.string().regex(skillName),
        repository: z.string().max(300),
        ref: z.string().max(255).default('HEAD'),
        directory: z.string().max(1024).default(''),
        expectedRevision: revision,
      })
      .strict()
      .parse(await c.req.json());
    return c.json(await catalog.importSkill(c.req.param('id'), source, expectedRevision));
  });
  app.delete('/api/agents/:id/skills/:name', async (c) => {
    const name = z.string().regex(skillName).parse(c.req.param('name'));
    const { expectedRevision } = z.object({ expectedRevision: revision }).parse(await c.req.json());
    return c.json(
      await catalog.edit(c.req.param('id'), async (dir, profile) => {
        if (profile.revision !== expectedRevision) throw new HttpError(409, 'Agent 已修改，请刷新后重试');
        await rm(join(dir, 'skills', name), { recursive: true, force: true });
        profile.remoteSkills = profile.remoteSkills.filter((s) => s.name !== name);
      }),
    );
  });
  installSharedFilesRoutes(app, (id) => profileFiles(catalog, id), '/api/agents/:id/files');
}
