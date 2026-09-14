import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { AppNotification, NotificationType } from '../../protocol/notification-types.js';

export class NotificationStore {
  private items = new Map<string, AppNotification>();
  private dirty = false;
  private saving?: Promise<void>;
  private readonly path: string;

  constructor(basePath?: string) {
    this.path = resolve(basePath ?? 'data/notifications.json');
  }

  async init() {
    try {
      const raw = await readFile(this.path, 'utf8');
      const list = JSON.parse(raw) as AppNotification[];
      for (const item of list) this.items.set(item.id, item);
    } catch { /* file doesn't exist yet */ }
  }

  add(opts: { type: NotificationType; title: string; body: string; sessionId: string; sessionTitle: string; projectName?: string; turnId?: string }) {
    const now = new Date().toISOString();
    const id = randomUUID();
    const notification: AppNotification = { id, ...opts, createdAt: now };
    this.items.set(id, notification);
    // prune to 500
    if (this.items.size > 500) {
      const sorted = [...this.items.values()].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
      this.items = new Map(sorted.slice(0, 500).map(n => [n.id, n]));
    }
    this.flush();
    return notification;
  }

  markRead(id: string) {
    const notification = this.items.get(id);
    if (notification && !notification.readAt) {
      notification.readAt = new Date().toISOString();
      this.flush();
    }
  }

  list(limit = 100): AppNotification[] {
    return [...this.items.values()]
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .slice(0, limit);
  }

  private flush() {
    this.dirty = true;
    if (this.saving) return;
    this.saving = (async () => {
      await new Promise(resolve => setTimeout(resolve, 500)); // debounce
      while (this.dirty) {
        this.dirty = false;
        const list = this.list(500);
        await mkdir(dirname(this.path), { recursive: true });
        await writeFile(this.path + '.tmp', JSON.stringify(list, null, 2), 'utf8');
        await writeFile(this.path, JSON.stringify(list, null, 2), 'utf8');
      }
      this.saving = undefined;
    })().catch(() => { this.saving = undefined; });
  }

  close() { /* noop — flush is fire-and-forget */ }
}