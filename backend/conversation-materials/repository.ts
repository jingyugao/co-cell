import type { Pool, RowDataPacket } from 'mysql2/promise';
import type { ConversationMaterials } from '../../protocol/conversation-materials-types.js';

export interface MaterialsRepository {
  get(id: string): Promise<ConversationMaterials | undefined>;
  find(sourceKey: string): Promise<ConversationMaterials | undefined>;
  insert(material: ConversationMaterials): Promise<ConversationMaterials>;
}

export class MySqlMaterialsRepository implements MaterialsRepository {
  constructor(private pool: Pool) {}
  async init() {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS conversation_materials (
      id CHAR(36) PRIMARY KEY,source_key CHAR(64) NOT NULL UNIQUE,
      session_id CHAR(36) NOT NULL,document JSON NOT NULL,created_at DATETIME(3) NOT NULL,
      INDEX material_session(session_id,created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  }
  private async read(where: string, value: string): Promise<ConversationMaterials | undefined> {
    const [rows] = await this.pool.query<RowDataPacket[]>(`SELECT document FROM conversation_materials WHERE ${where}=?`, [value]);
    const document = rows[0]?.document;
    return typeof document === 'string' ? JSON.parse(document) : document;
  }
  get(id: string) { return this.read('id', id); }
  find(key: string) { return this.read('source_key', key); }
  async insert(material: ConversationMaterials) {
    await this.pool.query(`INSERT INTO conversation_materials(id,source_key,session_id,document,created_at)
      VALUES(?,?,?,CAST(? AS JSON),?) ON DUPLICATE KEY UPDATE id=VALUES(id),document=VALUES(document),created_at=VALUES(created_at)`,
    [material.id, material.sourceKey, material.sessionId, JSON.stringify(material), new Date(material.createdAt)]);
    return (await this.find(material.sourceKey))!;
  }
}
