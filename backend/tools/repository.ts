import { randomUUID } from 'node:crypto';
import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import type { DynamicTool, DynamicToolInput } from '../../protocol/tool-types.js';
import type { ToolPermission } from '../../protocol/secret-types.js';
import { HttpError } from '../../util/errors.js';
import { mysqlToolDefault, mysqlToolScriptDefaults } from './defaults.js';
import { additionalToolDefaults, additionalToolScriptDefaults } from './native-tool-defaults.js';
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
  ...(row.permission_script_id ? { permissionScriptId: row.permission_script_id } : {}),
  ...(row.credential_parse_script_id ? { credentialParseScriptId: row.credential_parse_script_id } : {}),
  ...(row.credential_save_script_id ? { credentialSaveScriptId: row.credential_save_script_id } : {}),
  // Read legacy bodies only for compatibility; init migrates and clears them.
  ...(row.permission_script ? { permissionScript: row.permission_script } : {}), timeoutMs: Number(row.timeout_ms),
  version: Number(row.version), createdAt: row.created_at, updatedAt: row.updated_at,
});
const values = (input: DynamicToolInput) => [input.description, input.instructions, input.enabled, input.executable, input.packageVersion ?? null,
  JSON.stringify(input.args), JSON.stringify(input.env), input.credentialPath ?? null,
  input.credentialPaths ? JSON.stringify(input.credentialPaths) : null, null, input.permissionScriptId ?? null,
  input.credentialParseScriptId ?? null, input.credentialSaveScriptId ?? null, input.timeoutMs];
const insertSql = `INSERT INTO tool_definitions
  (name,description,instructions,enabled,executable,package_version,args_json,env_json,credential_path,credential_paths_json,permission_script,
   permission_script_id,credential_parse_script_id,credential_save_script_id,timeout_ms,version,created_at,updated_at)
  VALUES(?,?,?,?,?,?,CAST(? AS JSON),CAST(? AS JSON),?,CAST(? AS JSON),?,?,?,?,?,1,?,?)`;

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
      args_json JSON NOT NULL, env_json JSON NOT NULL, credential_path VARCHAR(256) NULL, permission_script TEXT NULL,
      credential_paths_json JSON NULL, permission_script_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
      credential_parse_script_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
      credential_save_script_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
      timeout_ms INT UNSIGNED NOT NULL, version BIGINT UNSIGNED NOT NULL,
      created_at VARCHAR(30) NOT NULL, updated_at VARCHAR(30) NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    const migrations = [
      ['permission_script', 'TEXT NULL'],
      ['credential_paths_json', 'JSON NULL'],
      ['permission_script_id', 'CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL'],
      ['credential_parse_script_id', 'CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL'],
      ['credential_save_script_id', 'CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL'],
    ] as const;
    for (const [column, definition] of migrations) {
      const [columns] = await this.pool.query<RowDataPacket[]>(`SELECT COLUMN_NAME FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='tool_definitions' AND COLUMN_NAME=?`, [column]);
      if (!columns.length) {
        try { await this.pool.query(`ALTER TABLE tool_definitions ADD COLUMN ${column} ${definition}`); }
        catch (error) { if ((error as { code?: string }).code !== 'ER_DUP_FIELDNAME') throw error; }
      }
    }
    await this.pool.query(`CREATE TABLE IF NOT EXISTS tool_definition_migrations (
      name VARCHAR(100) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY, applied_at VARCHAR(30) NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const now = new Date().toISOString();
      const [migration] = await connection.query<ResultSetHeader>(
        'INSERT IGNORE INTO tool_definition_migrations (name,applied_at) VALUES (?,?)', ['mysql-dynamic-v1', now]);
      if (migration.affectedRows) {
        // Preserve existing roles and credentials. A later delete or edit must
        // remain effective across restarts, so this seed is applied only once.
        await connection.query(insertSql + ' ON DUPLICATE KEY UPDATE name=name', [mysqlToolDefault.name, ...values(mysqlToolDefault), now, now]);
      }
      const [scriptsMigration] = await connection.query<ResultSetHeader>(
        'INSERT IGNORE INTO tool_definition_migrations (name,applied_at) VALUES (?,?)', ['central-tool-scripts-v1', now]);
      if (scriptsMigration.affectedRows) await this.migrateScripts(connection, now);
      const [hooksMigration] = await connection.query<ResultSetHeader>(
        'INSERT IGNORE INTO tool_definition_migrations (name,applied_at) VALUES (?,?)', ['mysql-credential-hooks-v1', now]);
      if (hooksMigration.affectedRows) {
        const previous = ['return codec.mysql.decode(input.content);', 'return codec.mysql.encode(input.content);'];
        for (const [index, source] of previous.entries()) {
          const hook = mysqlToolScriptDefaults[index + 1];
          // Upgrade only unchanged built-ins; operator scripts keep their source.
          await connection.query(`UPDATE tool_scripts SET source=?,version=version+1,updated_at=?
            WHERE id=? AND language='typescript' AND CAST(source AS BINARY)=CAST(? AS BINARY)`, [hook.source, now, hook.id, source]);
        }
        await connection.query(`UPDATE tool_definitions SET credential_paths_json=CAST(? AS JSON),version=version+1,updated_at=?
          WHERE name='mysql' AND JSON_LENGTH(credential_paths_json)=1 AND JSON_UNQUOTE(JSON_EXTRACT(credential_paths_json,'$[0]'))='.mylogin.cnf'`,
        [JSON.stringify(mysqlToolDefault.credentialPaths), now]);
      }
      const [registrationTables] = await connection.query<RowDataPacket[]>(`SELECT TABLE_NAME FROM information_schema.TABLES
        WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('secrets','secret_tool_configs')`);
      for (const tool of additionalToolDefaults) {
        const [seed] = await connection.query<ResultSetHeader>(
          'INSERT IGNORE INTO tool_definition_migrations (name,applied_at) VALUES (?,?)', [`${tool.name}-dynamic-v1`, now]);
        if (!seed.affectedRows) continue;
        for (const script of additionalToolScriptDefaults.filter(script => [tool.permissionScriptId, tool.credentialParseScriptId, tool.credentialSaveScriptId].includes(script.id))) {
          await connection.query(`INSERT IGNORE INTO tool_scripts (id,name,language,source,version,created_at,updated_at)
            VALUES (?,?,?,?,1,?,?)`, [script.id, script.name, script.language, script.source, now, now]);
          const [stored] = await connection.query<RowDataPacket[]>('SELECT id FROM tool_scripts WHERE id=?', [script.id]);
          if (!stored.length) throw new Error(`Built-in script name conflicts with another script: ${script.name}`);
        }
        // Reuse a registered primary file and its companions without reading or
        // rewriting credentials. Custom definitions and role grants stay intact.
        const [configs] = registrationTables.length === 2 ? await connection.query<RowDataPacket[]>(
          `SELECT c.path FROM secret_tool_configs c JOIN secrets s ON s.id=c.secret_id
            WHERE c.tool=? AND s.enabled=1 AND s.format IN ('text','lark','home')`, [tool.name]) : [[]];
        const path = tool.name === 'kubectl' ? tool.credentialPath : configs.length === 1 ? configs[0].path : tool.credentialPath;
        const roots = [...new Set([...(tool.credentialPaths ?? []), ...(path ? [path] : [])])];
        const seeded = { ...tool, credentialPath: path, credentialPaths: roots.filter(path => !roots.some(parent => path !== parent && path.startsWith(parent + '/'))) };
        await connection.query(insertSql + ' ON DUPLICATE KEY UPDATE name=name', [seeded.name, ...values(seeded), now, now]);
      }
      await connection.commit();
    } catch (error) { await connection.rollback(); throw error; }
    finally { connection.release(); }
  }
  private async migrateScripts(connection: PoolConnection, now: string) {
    const [tools] = await connection.query<RowDataPacket[]>(`SELECT name,version,credential_paths_json,permission_script,
      permission_script_id,credential_parse_script_id,credential_save_script_id FROM tool_definitions FOR UPDATE`);
    const defaults = [
      ['permission_script_id', mysqlToolScriptDefaults[0]],
      ['credential_parse_script_id', mysqlToolScriptDefaults[1]],
      ['credential_save_script_id', mysqlToolScriptDefaults[2]],
    ] as const;
    for (const [field, script] of defaults) {
      const required = tools.some(tool =>
        defaults.some(([column]) => tool[column] === script.id) ||
        tool.name === 'mysql' && !tool[field] &&
          (field !== 'permission_script_id' || tool.permission_script === null || tool.permission_script === undefined));
      if (!required) continue;
      await connection.query(`INSERT IGNORE INTO tool_scripts (id,name,language,source,version,created_at,updated_at)
        VALUES (?,?,?,?,1,?,?)`, [script.id, script.name, script.language, script.source, now, now]);
      const [stored] = await connection.query<RowDataPacket[]>('SELECT id FROM tool_scripts WHERE id=?', [script.id]);
      if (!stored.length) {
        // INSERT IGNORE may skip on the unique name even when this stable ID is
        // absent. Fail the transaction instead of storing a dangling reference.
        throw new Error(`MySQL built-in script name conflicts with another script: ${script.name}`);
      }
    }
    const mysqlScripts = Object.fromEntries(mysqlToolScriptDefaults.map(script => [script.name, script.id]));
    for (const tool of tools) {
      const set: string[] = [];
      const params: unknown[] = [];
      const assign = (column: string, value: unknown) => { set.push(`${column}=?`); params.push(value); };
      if (tool.permission_script !== null && tool.permission_script !== undefined) {
        let scriptId = tool.permission_script_id as string | null;
        if (!scriptId) {
          scriptId = randomUUID();
          const scriptName = `Migrated ${tool.name} permission ${scriptId.slice(0, 8)}`;
          await connection.query(`INSERT INTO tool_scripts (id,name,language,source,version,created_at,updated_at)
            VALUES (?,?,'typescript',?,1,?,?)`, [scriptId, scriptName, tool.permission_script, now, now]);
          assign('permission_script_id', scriptId);
        }
        assign('permission_script', null);
      } else if (tool.name === 'mysql' && !tool.permission_script_id) {
        assign('permission_script_id', mysqlScripts['mysql permission']);
      }
      if (tool.name === 'mysql') {
        if (!tool.credential_paths_json) assign('credential_paths_json', JSON.stringify(mysqlToolDefault.credentialPaths));
        if (!tool.credential_parse_script_id) assign('credential_parse_script_id', mysqlScripts['mysql credential parser']);
        if (!tool.credential_save_script_id) assign('credential_save_script_id', mysqlScripts['mysql credential saver']);
      }
      if (set.length) {
        set.push('version=version+1', 'updated_at=?');
        params.push(now, tool.name, tool.version);
        const [result] = await connection.query<ResultSetHeader>(
          `UPDATE tool_definitions SET ${set.join(',')} WHERE name=? AND version=?`, params);
        if (!result.affectedRows) throw new HttpError(409, '迁移期间工具定义发生变化，请重启服务重试');
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
        permission_script=?,permission_script_id=?,credential_parse_script_id=?,credential_save_script_id=?,
        timeout_ms=?,version=version+1,updated_at=?
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
