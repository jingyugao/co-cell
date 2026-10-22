import { randomUUID } from 'node:crypto';
import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import type { ToolScript, ToolScriptInput } from '../../protocol/tool-script-types.js';
import { HttpError } from '../../util/errors.js';

export interface ToolScriptRepository {
  init(): Promise<void>;
  list(): Promise<ToolScript[]>;
  get(id: string): Promise<ToolScript | undefined>;
  save(input: ToolScriptInput, id?: string, version?: number): Promise<ToolScript>;
  delete(id: string, version: number): Promise<void>;
}

const fromRow = (row: RowDataPacket): ToolScript => ({
  id: row.id,
  name: row.name,
  language: row.language,
  source: row.source,
  version: Number(row.version),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export class MySqlToolScriptRepository implements ToolScriptRepository {
  constructor(private readonly pool: Pool) {}

  async init() {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS tool_scripts (
      id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
      name VARCHAR(100) NOT NULL UNIQUE,
      language VARCHAR(16) NOT NULL,
      source TEXT NOT NULL,
      version BIGINT UNSIGNED NOT NULL,
      created_at VARCHAR(30) NOT NULL,
      updated_at VARCHAR(30) NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  }

  async list() {
    const [rows] = await this.pool.query<RowDataPacket[]>('SELECT * FROM tool_scripts ORDER BY name,id');
    return rows.map(fromRow);
  }

  async get(id: string) {
    const [rows] = await this.pool.query<RowDataPacket[]>('SELECT * FROM tool_scripts WHERE id=?', [id]);
    return rows[0] ? fromRow(rows[0]) : undefined;
  }

  async save(input: ToolScriptInput, id?: string, version?: number) {
    const now = new Date().toISOString();
    const scriptId = id ?? randomUUID();
    if (id === undefined) {
      if (version !== undefined) throw new HttpError(400, '新建脚本时不能提供版本号');
      try {
        await this.pool.query(`INSERT INTO tool_scripts (id,name,language,source,version,created_at,updated_at)
          VALUES (?,?,?,?,1,?,?)`, [scriptId, input.name, input.language, input.source, now, now]);
      } catch (error) {
        if ((error as { code?: string }).code === 'ER_DUP_ENTRY') throw new HttpError(409, '脚本名称已存在');
        throw error;
      }
    } else {
      if (version === undefined) throw new HttpError(400, '更新脚本时必须提供版本号');
      try {
        const [result] = await this.pool.query<ResultSetHeader>(`UPDATE tool_scripts SET name=?,language=?,source=?,
          version=version+1,updated_at=? WHERE id=? AND version=?`, [input.name, input.language, input.source, now, id, version]);
        if (!result.affectedRows) throw new HttpError(409, '脚本已被修改或删除，请重新加载');
      } catch (error) {
        if ((error as { code?: string }).code === 'ER_DUP_ENTRY') throw new HttpError(409, '脚本名称已存在');
        throw error;
      }
    }
    return (await this.get(scriptId))!;
  }

  async delete(id: string, version: number) {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [references] = await connection.query<RowDataPacket[]>(`SELECT name FROM tool_definitions WHERE
        permission_script_id=? OR credential_parse_script_id=? OR credential_save_script_id=? FOR UPDATE`, [id, id, id]);
      if (references.length) throw new HttpError(409, '脚本仍被工具引用');
      const [result] = await connection.query<ResultSetHeader>('DELETE FROM tool_scripts WHERE id=? AND version=?', [id, version]);
      if (!result.affectedRows) throw new HttpError(409, '脚本已被修改或删除，请重新加载');
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }
}
