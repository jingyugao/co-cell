import type { Hono } from 'hono';
import type { SandboxInventoryReader } from './inventory.js';
import type { SessionManager } from '../sessions/manager.js';

export function installSandboxesRoutes(app: Hono, sandboxes: SandboxInventoryReader, manager: Pick<SessionManager, 'list' | 'listProjects'>) {
  app.get('/api/sandboxes', async c => c.json(await sandboxes.read(manager.list(), manager.listProjects())));
}
