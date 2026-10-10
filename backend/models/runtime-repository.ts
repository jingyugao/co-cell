import type { Pool, RowDataPacket } from 'mysql2/promise';

export interface ModelRuntimeRepository {
  init(): Promise<void>;
  save(sessionId: string, sealed: string): Promise<void>;
  load(sessionId: string): Promise<string | undefined>;
  delete(sessionId: string): Promise<void>;
}

export class MySqlModelRuntimeRepository implements ModelRuntimeRepository {
  constructor(private readonly pool: Pool) {}

  async init() {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS model_runtime_routes (
      session_id CHAR(36) NOT NULL PRIMARY KEY,
      encrypted_snapshot MEDIUMTEXT NOT NULL,
      CONSTRAINT model_runtime_routes_session_fk FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
  }

  async save(sessionId: string, sealed: string): Promise<void> {
    await this.pool.query(
      'INSERT INTO model_runtime_routes(session_id,encrypted_snapshot) VALUES(?,?) ON DUPLICATE KEY UPDATE encrypted_snapshot=VALUES(encrypted_snapshot)',
      [sessionId, sealed]);
  }

  async load(sessionId: string): Promise<string | undefined> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      'SELECT encrypted_snapshot FROM model_runtime_routes WHERE session_id=?', [sessionId]);
    return rows[0]?.encrypted_snapshot as string | undefined;
  }

  async delete(sessionId: string): Promise<void> {
    await this.pool.query('DELETE FROM model_runtime_routes WHERE session_id=?', [sessionId]);
  }
}
