import { randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { AppNotification, NotificationType } from '../../protocol/notification-types.js';
import type { NotificationRepository } from './repository.js';

export class NotificationStore {
  private readonly path: string;
  private readonly pending = new Set<Promise<unknown>>();
  private closed = false;

  constructor(private readonly repository: NotificationRepository, legacyPath?: string) {
    this.path = resolve(legacyPath ?? 'data/notifications.json');
  }

  /** Import both legacy snapshots before removing them; never write local files. */
  async init() {
    const notifications = new Map<string, AppNotification>();
    const paths: string[] = [];
    for (const path of [this.path, `${this.path}.tmp`]) {
      let raw: string;
      try { raw = await readFile(path, 'utf8'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      const list: unknown = JSON.parse(raw);
      if (!Array.isArray(list) || !list.every(isNotification)) throw new Error(`Invalid legacy notification file: ${path}`);
      paths.push(path);
      for (const item of list) {
        const existing = notifications.get(item.id);
        notifications.set(item.id, existing ? { ...existing, ...(existing.readAt || item.readAt ? { readAt: existing.readAt ?? item.readAt } : {}) } : item);
      }
    }
    if (!paths.length) return;
    await this.repository.importLegacy([...notifications.values()]);
    for (const path of paths) await rm(path, { force: true });
  }

  async add(opts: { type: NotificationType; title: string; body: string; sessionId: string; sessionTitle: string; projectName?: string; turnId?: string }) {
    const notification: AppNotification = { id: randomUUID(), ...opts, createdAt: new Date().toISOString() };
    await this.track(() => this.repository.save(notification));
    return notification;
  }

  async markRead(id: string) { await this.track(() => this.repository.markRead(id, new Date().toISOString())); }

  list(limit = 100) { return this.repository.list(limit); }

  private track<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error('Notification store is closed'));
    const pending = Promise.resolve().then(operation);
    this.pending.add(pending);
    void pending.finally(() => this.pending.delete(pending)).catch(() => {});
    return pending;
  }

  async close() { this.closed = true; await Promise.allSettled([...this.pending]); }
}

function isNotification(value: unknown): value is AppNotification {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return typeof item.id === 'string' && item.id.length > 0 && item.id.length <= 36
    && typeof item.type === 'string' && ['turn_completed', 'turn_failed', 'turn_cancelled'].includes(item.type)
    && ['title', 'body', 'sessionId', 'sessionTitle'].every(key => typeof item[key] === 'string')
    && typeof item.createdAt === 'string' && Number.isFinite(Date.parse(item.createdAt))
    && (item.readAt === undefined || (typeof item.readAt === 'string' && Number.isFinite(Date.parse(item.readAt))))
    && ['projectName', 'turnId'].every(key => item[key] === undefined || typeof item[key] === 'string');
}
