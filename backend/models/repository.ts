import type { Pool, RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import type { ManagedModel } from '../../protocol/model-types.js';

export interface StoredModelChannel {
  id: string;
  name: string;
  endpoint: string;
  enabled: boolean;
  hasApiKey: boolean;
  apiKeyCiphertext?: string;
  models: ManagedModel[];
}

export interface StoredModelCatalog {
  revision: number;
  defaultModelId: string | null;
  channels: StoredModelChannel[];
}

export interface ModelRepository {
  init(): Promise<void>;
  load(): Promise<StoredModelCatalog | null>;
  /** Null expectedRevision inserts the singleton only when it does not exist. */
  save(expectedRevision: number | null, catalog: StoredModelCatalog): Promise<boolean>;
}

const parse = <T>(value: T | string): T => typeof value === 'string' ? JSON.parse(value) : value;

export class MySqlModelRepository implements ModelRepository {
  constructor(private readonly pool: Pool) {}

  async init() {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS model_catalog (
      id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
      revision BIGINT UNSIGNED NOT NULL,
      document JSON NOT NULL,
      CHECK (id = 1)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  }

  async load(): Promise<StoredModelCatalog | null> {
    const [rows] = await this.pool.query<RowDataPacket[]>('SELECT revision, document FROM model_catalog WHERE id=1');
    const row = rows[0];
    if (!row) return null;
    const document = parse<Omit<StoredModelCatalog, 'revision'>>(row.document);
    return { ...document, revision: Number(row.revision) };
  }

  async save(expectedRevision: number | null, catalog: StoredModelCatalog): Promise<boolean> {
    const document = JSON.stringify({ defaultModelId: catalog.defaultModelId, channels: catalog.channels });
    if (expectedRevision === null) {
      try {
        const [result] = await this.pool.query<ResultSetHeader>(
          'INSERT INTO model_catalog(id,revision,document) VALUES(1,?,CAST(? AS JSON))', [catalog.revision, document]);
        return result.affectedRows === 1;
      } catch (error) {
        if ((error as { code?: string }).code === 'ER_DUP_ENTRY') return false;
        throw error;
      }
    }
    const [result] = await this.pool.query<ResultSetHeader>(
      'UPDATE model_catalog SET revision=?,document=CAST(? AS JSON) WHERE id=1 AND revision=?',
      [catalog.revision, document, expectedRevision]);
    return result.affectedRows === 1;
  }
}
