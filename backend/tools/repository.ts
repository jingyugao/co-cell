import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import type { DynamicTool, DynamicToolInput } from '../../protocol/tool-types.js';
import type { ToolPermission } from '../../protocol/secret-types.js';
import { HttpError } from '../../util/errors.js';
import { MySqlToolScriptRepository } from './script-repository.js';
import type { ToolScriptRepository } from './script-repository.js';

export interface ToolRepository {
  readonly scripts?: ToolScriptRepository;
  init(): Promise<void>;
  list(): Promise<DynamicTool[]>;
  get(name: string): Promise<DynamicTool | undefined>;
  save(input: DynamicToolInput, version?: number): Promise<DynamicTool>;
  delete(name: string, version: number): Promise<void>;
}
const parse = <T>(value: string | T): T => typeof value === 'string' ? JSON.parse(value) : value;
const toolFromRow = (row: RowDataPacket): DynamicTool => ({
  name: row.name, description: row.description, instructions: row.instructions, enabled: Boolean(row.enabled),
  executable: row.executable, ...(row.package_version ? { packageVersion: row.package_version } : {}),
  args: parse(row.args_json), env: parse(row.env_json),
  ...(row.credential_path ? { credentialPath: row.credential_path } : {}),
  ...(row.credential_paths_json ? { credentialPaths: parse(row.credential_paths_json) } : {}),
  ...(row.credential_mode ? { credentialMode: row.credential_mode } : {}),
  ...(row.credential_excluded_paths_json ? { credentialExcludedPaths: parse(row.credential_excluded_paths_json) } : {}),
  ...(row.credential_context_json ? { credentialContext: parse(row.credential_context_json) } : {}),
  ...(row.permission_script_id ? { permissionScriptId: row.permission_script_id } : {}),
  ...(row.credential_parse_script_id ? { credentialParseScriptId: row.credential_parse_script_id } : {}),
  ...(row.credential_save_script_id ? { credentialSaveScriptId: row.credential_save_script_id } : {}),
  timeoutMs: Number(row.timeout_ms),
  version: Number(row.version), createdAt: row.created_at, updatedAt: row.updated_at,
});
const values = (input: DynamicToolInput) => [input.description, input.instructions, input.enabled, input.executable, input.packageVersion ?? null,
  JSON.stringify(input.args), JSON.stringify(input.env), input.credentialPath ?? null,
  input.credentialPaths ? JSON.stringify(input.credentialPaths) : null, input.permissionScriptId ?? null,
  input.credentialParseScriptId ?? null, input.credentialSaveScriptId ?? null, input.timeoutMs, input.credentialMode ?? null,
  input.credentialExcludedPaths ? JSON.stringify(input.credentialExcludedPaths) : null,
  input.credentialContext ? JSON.stringify(input.credentialContext) : null];
const insertSql = `INSERT INTO tool_definitions
  (name,description,instructions,enabled,executable,package_version,args_json,env_json,credential_path,credential_paths_json,
   permission_script_id,credential_parse_script_id,credential_save_script_id,timeout_ms,credential_mode,
   credential_excluded_paths_json,credential_context_json,version,created_at,updated_at)
  VALUES(?,?,?,?,?,?,CAST(? AS JSON),CAST(? AS JSON),?,CAST(? AS JSON),?,?,?,?,?,CAST(? AS JSON),CAST(? AS JSON),1,?,?)`;

/** Definitions are relational metadata; executable packages and credentials live on disk. */
export class MySqlToolRepository implements ToolRepository {
  readonly scripts: ToolScriptRepository;
  constructor(private readonly pool: Pool) { this.scripts = new MySqlToolScriptRepository(pool); }
  async init() {
    await this.scripts.init();
    await this.pool.query(`CREATE TABLE IF NOT EXISTS tool_definitions (
      name VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
      description VARCHAR(1000) NOT NULL, instructions TEXT NOT NULL, enabled BOOLEAN NOT NULL,
      executable VARCHAR(1024) NOT NULL, package_version CHAR(64) NULL,
      args_json JSON NOT NULL, env_json JSON NOT NULL, credential_path VARCHAR(256) NULL,
      credential_paths_json JSON NULL, permission_script_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
      credential_parse_script_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
      credential_save_script_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
      credential_mode VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NULL,
      credential_excluded_paths_json JSON NULL, credential_context_json JSON NULL,
      timeout_ms INT UNSIGNED NOT NULL, version BIGINT UNSIGNED NOT NULL,
      created_at VARCHAR(30) NOT NULL, updated_at VARCHAR(30) NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    const migrations = [
      ['credential_paths_json', 'JSON NULL'],
      ['permission_script_id', 'CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL'],
      ['credential_parse_script_id', 'CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL'],
      ['credential_save_script_id', 'CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL'],
      ['credential_mode', 'VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NULL'],
      ['credential_excluded_paths_json', 'JSON NULL'],
      ['credential_context_json', 'JSON NULL'],
    ] as const;
    for (const [column, definition] of migrations) {
      const [columns] = await this.pool.query<RowDataPacket[]>(`SELECT COLUMN_NAME FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='tool_definitions' AND COLUMN_NAME=?`, [column]);
      if (!columns.length) {
        try { await this.pool.query(`ALTER TABLE tool_definitions ADD COLUMN ${column} ${definition}`); }
        catch (error) { if ((error as { code?: string }).code !== 'ER_DUP_FIELDNAME') throw error; }
      }
    }
  }
  async list() {
    const [rows] = await this.pool.query<RowDataPacket[]>('SELECT * FROM tool_definitions ORDER BY name');
    return rows.map(toolFromRow);
  }
  async get(name: string) {
    const [rows] = await this.pool.query<RowDataPacket[]>('SELECT * FROM tool_definitions WHERE name=?', [name]);
    return rows[0] ? toolFromRow(rows[0]) : undefined;
  }
  async save(input: DynamicToolInput, version?: number) {
    const now = new Date().toISOString();
    if (version === undefined) {
      try {
        await this.pool.query(insertSql, [input.name, ...values(input), now, now]);
      } catch (error) {
        if ((error as { code?: string }).code === 'ER_DUP_ENTRY') throw new HttpError(409, '工具名已存在');
        throw error;
      }
    } else {
      const [result] = await this.pool.query<ResultSetHeader>(`UPDATE tool_definitions SET description=?,instructions=?,enabled=?,executable=?,
        package_version=?,args_json=CAST(? AS JSON),env_json=CAST(? AS JSON),credential_path=?,credential_paths_json=CAST(? AS JSON),
        permission_script_id=?,credential_parse_script_id=?,credential_save_script_id=?,
        timeout_ms=?,credential_mode=?,credential_excluded_paths_json=CAST(? AS JSON),credential_context_json=CAST(? AS JSON),version=version+1,updated_at=?
        WHERE name=? AND version=?`, [...values(input), now, input.name, version]);
      if (!result.affectedRows) throw new HttpError(409, '工具已被修改或删除，请重新加载');
    }
    return (await this.get(input.name))!;
  }
  async delete(name: string, version: number) {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [result] = await connection.query<ResultSetHeader>('DELETE FROM tool_definitions WHERE name=? AND version=?', [name, version]);
      if (!result.affectedRows) throw new HttpError(409, '工具已被修改或删除，请重新加载');
      // A later tool with the same name must require a new operator grant.
      const [roles] = await connection.query<RowDataPacket[]>(
        "SELECT id,connections FROM tool_roles WHERE JSON_CONTAINS(connections, JSON_OBJECT('tool', ?)) FOR UPDATE", [name]);
      for (const role of roles) {
        const permissions = parse<ToolPermission[]>(role.connections).filter(permission => permission.tool !== name);
        await connection.query('UPDATE tool_roles SET connections=CAST(? AS JSON),updated_at=? WHERE id=?',
          [JSON.stringify(permissions), new Date().toISOString(), role.id]);
      }
      await connection.commit();
    } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
  }
}
