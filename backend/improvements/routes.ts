import type { Hono } from 'hono';
import { z } from 'zod';
import { HttpError } from '../core/errors.js';
import type { SessionManager } from '../sessions/manager.js';
import type { ImprovementStore } from './store.js';
import { improvementStatusSchema } from './store.js';
import { IMPROVEMENT_STATUSES } from '../../protocol/improvement-types.js';

const querySchema = z.object({
  q: z.string().trim().max(200).optional(),
  category: z.string().trim().max(120).optional(),
  projectId: z.string().uuid().optional(),
  status: z.enum(IMPROVEMENT_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  offset: z.coerce.number().int().min(0).max(10_000_000).default(0),
});
export function installImprovementRoutes(app: Hono, store: ImprovementStore | undefined, sessions: Pick<SessionManager, 'list'>) {
  const database = () => {
    if (!store) throw new HttpError(503, '建议数据库尚未初始化');
    return store;
  };
  app.get('/api/improvements', c => {
    const query = Object.fromEntries(Object.entries(c.req.query()).filter(([, value]) => value !== ''));
    const page = database().list(querySchema.parse(query));
    const available = new Set(sessions.list().map(session => session.id));
    return c.json({ ...page, items: page.items.map(item => ({ ...item, sourceAvailable: available.has(item.sessionId) })) });
  });
  app.get('/api/improvements/:id', c => {
    const proposal = database().get(c.req.param('id'));
    return c.json({ ...proposal, sourceAvailable: sessions.list().some(session => session.id === proposal.sessionId) });
  });
  app.patch('/api/improvements/:id/status', async c => {
    const input = improvementStatusSchema.parse(await c.req.json());
    const proposal = database().updateStatus(c.req.param('id'), input);
    return c.json({ ...proposal, sourceAvailable: sessions.list().some(session => session.id === proposal.sessionId) });
  });
}
