import type { Hono } from 'hono';
import type { NotificationStore } from './store.js';

export function installNotificationRoutes(app: Hono, store?: NotificationStore) {
  if (!store) return;

  app.get('/api/notifications', async c => c.json(await store.list(100)));

  app.post('/api/notifications/:id/read', async c => {
    const id = c.req.param('id');
    await store.markRead(id);
    return c.json({ ok: true });
  });
}
