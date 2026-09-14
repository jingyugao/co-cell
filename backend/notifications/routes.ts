import type { Hono } from 'hono';
import type { NotificationStore } from './store.js';

export function installNotificationRoutes(app: Hono, store?: NotificationStore) {
  if (!store) return;

  app.get('/api/notifications', c => c.json(store.list(100)));

  app.post('/api/notifications/:id/read', c => {
    const id = c.req.param('id');
    store.markRead(id);
    return c.json({ ok: true });
  });
}