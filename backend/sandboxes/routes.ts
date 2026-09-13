import type { Hono } from 'hono';
import type { SandboxInventoryReader } from './inventory.js';
import type { SessionManager } from '../sessions/manager.js';

export function installSandboxesRoutes(app: Hono, sandboxes: SandboxInventoryReader, manager: Pick<SessionManager, 'list' | 'listProjects' | 'deleteDanglingSandbox'>) {
  app.get('/api/sandboxes', async c => {
    const inventory = await sandboxes.read(manager.list(), manager.listProjects());
    return c.json(inventory);
  });
  app.delete('/api/sandboxes/:id', async c => {
    await manager.deleteDanglingSandbox(c.req.param('id'));
    await sandboxes.invalidate?.();
    return c.json({ ok: true });
  });
}
