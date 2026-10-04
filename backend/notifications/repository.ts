import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import type { AppNotification } from '../../protocol/notification-types.js';

export interface NotificationRepository {
  list(limit: number): Promise<AppNotification[]>;
  save(notification: AppNotification): Promise<void>;
  markRead(id: string, readAt: string): Promise<void>;
  importLegacy(notifications: AppNotification[]): Promise<void>;
}

/** Uses the web-state pool. Every read and write uses durable MySQL state. */
export class MySqlNotificationRepository implements NotificationRepository {
  constructor(private readonly pool: Pool) {}

  async init() {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS notifications (id CHAR(36) PRIMARY KEY, created_at DATETIME(3) NOT NULL, read_at DATETIME(3) NULL, document JSON NOT NULL, INDEX notifications_created (created_at,id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
    // Serialize insertion and retention across processes using the same database.
    await this.pool.query(`CREATE TABLE IF NOT EXISTS notification_store_state (id TINYINT PRIMARY KEY) ENGINE=InnoDB`);
    await this.pool.query('INSERT IGNORE INTO notification_store_state (id) VALUES (1)');
  }

  async list(limit: number): Promise<AppNotification[]> {
    const count = Math.max(0, Math.min(500, Number.isFinite(limit) ? Math.floor(limit) : 100));
    const [rows] = await this.pool.query<Array<RowDataPacket & { document: AppNotification | string; read_at: Date | string | null }>>(
      'SELECT document,read_at FROM notifications ORDER BY created_at DESC,id DESC LIMIT ?', [count]);
    return rows.map(row => {
      const notification: AppNotification = typeof row.document === 'string' ? JSON.parse(row.document) : row.document;
      return { ...notification, ...(row.read_at ? { readAt: new Date(row.read_at).toISOString() } : {}) };
    });
  }

  async save(notification: AppNotification) { await this.importLegacy([notification]); }

  async markRead(id: string, readAt: string) {
    await this.pool.query('UPDATE notifications SET read_at=COALESCE(read_at,?) WHERE id=?', [this.date(readAt), id]);
  }

  async importLegacy(notifications: AppNotification[]) {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.query('SELECT id FROM notification_store_state WHERE id=1 FOR UPDATE');
      for (const notification of notifications) await this.insert(connection, notification);
      await connection.query(`DELETE FROM notifications WHERE id NOT IN (SELECT id FROM (SELECT id FROM notifications ORDER BY created_at DESC,id DESC LIMIT 500) retained)`);
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally { connection.release(); }
  }

  private async insert(connection: PoolConnection, notification: AppNotification) {
    // Re-importing a legacy file preserves existing database content/read state.
    await connection.query(`INSERT INTO notifications (id,created_at,read_at,document) VALUES (?,?,?,CAST(? AS JSON)) ON DUPLICATE KEY UPDATE read_at=COALESCE(read_at,VALUES(read_at))`,
      [notification.id, this.date(notification.createdAt), notification.readAt ? this.date(notification.readAt) : null, JSON.stringify(notification)]);
  }

  private date(value: string) { return new Date(value).toISOString().slice(0, 23).replace('T', ' '); }
}
