import type { Pool, RowDataPacket } from 'mysql2/promise';
import type { ProxyTool, SecretFormat, SecretVersion } from '../../protocol/secret-types.js';
import { MySqlRoleRepository, type RoleRepository } from './role-repository.js';
import type { NativeSecretFiles } from './native-files.js';
import { HttpError } from '../../util/errors.js';

export interface StoredSecret {
  /** Old formats remain readable until the operator replaces their contents. */
  id: string; name: string; format: SecretFormat | 'json' | 'binary' | 'lark'; mutable: boolean; enabled: boolean;
  version: number; currentVersionId: string; ciphertext: string; createdAt: string; updatedAt: string;
  tool: ProxyTool | null; path: string | null; alias: string | null;
  /** The registry points at this credential's native HOME, never a DB snapshot. */
  nativeHome?: string;
}
export interface StoredVersion extends SecretVersion { secretId: string; ciphertext: string }
export type ToolConfig = Pick<StoredSecret, 'path' | 'format' | 'enabled'>;
export interface SecretRepository {
  readonly roles: RoleRepository;
  init(): Promise<void>;
  list(): Promise<StoredSecret[]>; get(id: string): Promise<StoredSecret | null>;
  /** Runtime path selection must not read native credential contents. */
  toolConfigs(tool: ProxyTool): Promise<ToolConfig[]>;
  save(secret: StoredSecret, version: StoredVersion | null): Promise<void>;
  delete(id: string): Promise<void>;
  versions(id: string): Promise<StoredVersion[]>;
  registerRuntime(boxId: string, projectId: string, generation: number): Promise<void>;
  runtime(boxId: string): Promise<{ projectId: string; generation: number } | null>;
  runtimeConfig(boxId: string, generation: number): Promise<Record<string, string>>;
  markRuntimeConfig(boxId: string, generation: number, slot: string, digest: string): Promise<void>;
  markRuntimeConfigs(boxId: string, generation: number, digests: Record<string, string>): Promise<void>;
  forgetRuntime(boxId: string): Promise<void>;

}
const parse = <T>(value: T | string): T => typeof value === 'string' ? JSON.parse(value) : value;

export class MySqlSecretRepository implements SecretRepository {
  readonly roles: RoleRepository;
  constructor(private pool: Pool, private files?: NativeSecretFiles) { this.roles = new MySqlRoleRepository(pool); }
  async init() {
    if (!this.files) throw new Error('Native credential directory is not configured');
    await this.files.init();
    await this.pool.query(`CREATE TABLE IF NOT EXISTS secrets (id CHAR(36) PRIMARY KEY, name VARCHAR(100) NOT NULL, format VARCHAR(10) NOT NULL, mutable BOOLEAN NOT NULL, enabled BOOLEAN NOT NULL, version BIGINT UNSIGNED NOT NULL, current_version_id CHAR(36) NOT NULL, ciphertext MEDIUMTEXT NOT NULL, created_at VARCHAR(30) NOT NULL, updated_at VARCHAR(30) NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    await this.pool.query(`CREATE TABLE IF NOT EXISTS secret_tool_configs (secret_id CHAR(36) PRIMARY KEY, tool VARCHAR(32) NOT NULL, path VARCHAR(256) NOT NULL, alias VARCHAR(64) NOT NULL, CONSTRAINT secret_tool_config_secret_fk FOREIGN KEY(secret_id) REFERENCES secrets(id) ON DELETE CASCADE) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    await this.pool.query(`CREATE TABLE IF NOT EXISTS secret_versions (id CHAR(36) PRIMARY KEY, secret_id CHAR(36) NOT NULL, source VARCHAR(10) NOT NULL, base_version BIGINT UNSIGNED NULL, created_at VARCHAR(30) NOT NULL, project_id CHAR(36) NULL, invocation_id CHAR(36) NULL, changes_json JSON NOT NULL, ciphertext MEDIUMTEXT NOT NULL, INDEX secret_history(secret_id,created_at), CONSTRAINT secret_versions_secret_fk FOREIGN KEY(secret_id) REFERENCES secrets(id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    await this.pool.query(`CREATE TABLE IF NOT EXISTS project_tool_runtimes (box_id VARCHAR(200) PRIMARY KEY, project_id CHAR(36) NOT NULL, generation BIGINT UNSIGNED NOT NULL, INDEX project_tool_runtimes_project_id_idx(project_id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    await this.pool.query(`CREATE TABLE IF NOT EXISTS sandbox_runtime_configs (box_id VARCHAR(200) NOT NULL, generation BIGINT UNSIGNED NOT NULL, slot VARCHAR(64) NOT NULL, digest CHAR(64) NOT NULL, applied_at VARCHAR(30) NOT NULL, PRIMARY KEY(box_id,generation,slot)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    for (const [table, constraint] of [['project_tool_runtimes', 'tool_runtimes_project_fk'], ['sandbox_runtime_configs', 'runtime_configs_box_fk']]) {
      const [constraints] = await this.pool.query<RowDataPacket[]>(`SELECT CONSTRAINT_NAME FROM INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME=? AND CONSTRAINT_NAME=?`, [table, constraint]);
      if (constraints.length) await this.pool.query(`ALTER TABLE \`${table}\` DROP FOREIGN KEY \`${constraint}\``);
    }
    const [runtimeIndexes] = await this.pool.query<RowDataPacket[]>(`SELECT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='project_tool_runtimes' AND COLUMN_NAME='project_id' AND SEQ_IN_INDEX=1`);
    if (!runtimeIndexes.length) await this.pool.query('CREATE INDEX project_tool_runtimes_project_id_idx ON project_tool_runtimes(project_id)');
    await this.roles.init();
  }
  private registration(row: RowDataPacket): StoredSecret {
    return { id: row.id, name: row.name, format: row.format, mutable: Boolean(row.mutable), enabled: Boolean(row.enabled), version: Number(row.version), currentVersionId: row.current_version_id, ciphertext: row.ciphertext, createdAt: row.created_at, updatedAt: row.updated_at, tool: row.tool ?? null, path: row.path ?? null, alias: row.alias ?? null };
  }
  private async secret(row: RowDataPacket): Promise<StoredSecret> {
    const secret = this.registration(row);
    if (this.files?.isNative(secret.ciphertext)) { secret.ciphertext = await this.files.read(secret); secret.nativeHome = secret.id; }
    return secret;
  }
  async list() { const [rows] = await this.pool.query<RowDataPacket[]>('SELECT s.*,c.tool,c.path,c.alias FROM secrets s LEFT JOIN secret_tool_configs c ON c.secret_id=s.id ORDER BY s.updated_at DESC'); return Promise.all(rows.map(row => this.secret(row))); }
  async toolConfigs(tool: ProxyTool): Promise<ToolConfig[]> {
    const [rows] = await this.pool.query<RowDataPacket[]>('SELECT c.path,s.format,s.enabled FROM secret_tool_configs c JOIN secrets s ON s.id=c.secret_id WHERE c.tool=?', [tool]);
    return rows.map(row => ({ path: row.path, format: row.format, enabled: Boolean(row.enabled) }));
  }
  async get(id: string) { const [rows] = await this.pool.query<RowDataPacket[]>('SELECT s.*,c.tool,c.path,c.alias FROM secrets s LEFT JOIN secret_tool_configs c ON c.secret_id=s.id WHERE s.id=?', [id]); return rows[0] ? this.secret(rows[0]) : null; }
  async delete(id: string) {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.query('SELECT id FROM secrets WHERE id=? FOR UPDATE', [id]);
      await connection.query('DELETE FROM secret_versions WHERE secret_id=?', [id]);
      // secret_tool_configs is removed by its ON DELETE CASCADE foreign key.
      await connection.query('DELETE FROM secrets WHERE id=?', [id]);
      await connection.commit();
    } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
  }
  async save(secret: StoredSecret, version: StoredVersion | null) {
    if (!this.files) throw new Error('Native credential directory is not configured');
    const connection = await this.pool.getConnection();
    let prepared: Awaited<ReturnType<NativeSecretFiles['prepare']>> | undefined;
    let committing = false;
    let priorVersion: string | undefined;
    try {
      await connection.beginTransaction();
      const [current] = await connection.query<RowDataPacket[]>('SELECT s.*,c.tool,c.path,c.alias FROM secrets s LEFT JOIN secret_tool_configs c ON c.secret_id=s.id WHERE s.id=? FOR UPDATE', [secret.id]);
      priorVersion = current[0]?.current_version_id;
      const contentChanged = version?.changes.some(field => ['content', 'path', 'tool'].includes(field));
      if (!secret.version || contentChanged) {
        prepared = await this.files.prepare(secret, !secret.version ? secret.currentVersionId : version!.id,
          !secret.version ? secret.ciphertext : version!.ciphertext, current[0] ? this.registration(current[0]) : undefined);
      }
      if (!secret.version) {
        await connection.query('INSERT INTO secrets(id,name,format,mutable,enabled,version,current_version_id,ciphertext,created_at,updated_at) VALUES(?,?,?,?,?,1,?,?,?,?)', [secret.id, secret.name, secret.format, secret.mutable, secret.enabled, secret.currentVersionId, prepared!.reference, secret.createdAt, secret.updatedAt]);
      } else {
        // Renaming or disabling a Secret must not write an old content snapshot
        // over a concurrently refreshed token. Content writes alone use LWW.
        await connection.query(`UPDATE secrets SET name=?,mutable=?,enabled=?,updated_at=?${contentChanged ? ',format=?,version=version+1,current_version_id=?,ciphertext=?' : ''} WHERE id=?`, [secret.name, secret.mutable, secret.enabled, secret.updatedAt, ...(contentChanged ? [secret.format, version!.id, prepared!.reference] : []), secret.id]);
      }
      if (secret.tool) await connection.query('INSERT INTO secret_tool_configs(secret_id,tool,path,alias) VALUES(?,?,?,?) ON DUPLICATE KEY UPDATE tool=VALUES(tool),path=VALUES(path),alias=VALUES(alias)', [secret.id, secret.tool, secret.path, secret.alias]);
      // Audit history records operations, never copies of native credentials.
      if (version) await this.insertVersion(connection, { ...version, ciphertext: '' });
      committing = true;
      await connection.commit();
    } catch (error) {
      await connection.rollback().catch(() => {});
      let restore = !committing;
      if (committing && prepared) {
        // A locking read waits for any outstanding commit to resolve before
        // deciding whether it is safe to restore the previous native bytes.
        const [rows] = await this.pool.query<RowDataPacket[]>('SELECT current_version_id FROM secrets WHERE id=? FOR UPDATE', [secret.id]);
        restore = !rows.length || rows[0].current_version_id === priorVersion;
      }
      if (restore) await prepared?.rollback();
      throw error;
    } finally { connection.release(); }
  }
  private async insertVersion(connection: Pick<Pool, 'query'>, version: StoredVersion) {
    await connection.query('INSERT INTO secret_versions(id,secret_id,source,base_version,created_at,project_id,invocation_id,changes_json,ciphertext) VALUES(?,?,?,?,?,?,?,CAST(? AS JSON),?)', [version.id, version.secretId, version.source, version.baseVersion, version.createdAt, version.projectId, version.invocationId, JSON.stringify(version.changes), version.ciphertext]);
  }
  async versions(id: string) {
    const [rows] = await this.pool.query<RowDataPacket[]>('SELECT id,secret_id,source,base_version,created_at,project_id,invocation_id,changes_json FROM secret_versions WHERE secret_id=? ORDER BY created_at DESC LIMIT 100', [id]);
    return rows.map(row => ({ id: row.id, secretId: row.secret_id, source: row.source, baseVersion: row.base_version == null ? null : Number(row.base_version), createdAt: row.created_at, projectId: row.project_id, invocationId: row.invocation_id, changes: parse<string[]>(row.changes_json), ciphertext: '' } as StoredVersion));
  }
  /** Explicit migration: retain native current files and audit metadata only. */
  async migrateNativeFiles() {
    if (!this.files) throw new Error('Native credential directory is not configured');
    await this.files.init();
    const [rows] = await this.pool.query<RowDataPacket[]>('SELECT id FROM secrets ORDER BY id');
    let currentMigrated = 0, historyCleared = 0;
    for (const { id } of rows) {
      const connection = await this.pool.getConnection();
      let prepared: Awaited<ReturnType<NativeSecretFiles['prepare']>> | undefined;
      let committing = false;
      let priorReference: string | undefined;
      try {
        await connection.beginTransaction();
        const [current] = await connection.query<RowDataPacket[]>('SELECT s.*,c.tool,c.path,c.alias FROM secrets s LEFT JOIN secret_tool_configs c ON c.secret_id=s.id WHERE s.id=? FOR UPDATE', [id]);
        if (!current.length) { await connection.commit(); continue; }
        const row = current[0];
        priorReference = row.ciphertext;
        const secret = await this.secret(row);
        if (!this.files.isNative(row.ciphertext)) {
          prepared = await this.files.prepare(secret, secret.currentVersionId, secret.ciphertext);
          await connection.query('UPDATE secrets SET ciphertext=? WHERE id=?', [prepared.reference, id]);
          currentMigrated++;
        }
        const [history] = await connection.query<RowDataPacket[]>('SELECT id FROM secret_versions WHERE secret_id=? AND ciphertext<>\'\'', [id]);
        // No LIMIT: remove credential bodies from all historical audit records.
        if (history.length) {
          await connection.query('UPDATE secret_versions SET ciphertext=\'\' WHERE secret_id=?', [id]);
          historyCleared += history.length;
        }
        committing = true;
        await connection.commit();
      } catch (error) {
        await connection.rollback().catch(() => {});
        let restore = !committing;
        if (committing && prepared) {
          const [rows] = await this.pool.query<RowDataPacket[]>('SELECT ciphertext FROM secrets WHERE id=? FOR UPDATE', [id]);
          restore = !rows.length || rows[0].ciphertext === priorReference;
        }
        if (restore) await prepared?.rollback();
        throw error;
      } finally { connection.release(); }
    }
    return { currentMigrated, historyCleared };
  }
  async registerRuntime(boxId: string, projectId: string, generation: number) {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [projects] = await connection.query<RowDataPacket[]>('SELECT id FROM projects WHERE id=? FOR UPDATE', [projectId]);
      if (!projects.length) throw new HttpError(404, '项目不存在');
      // Lock an existing runtime row so registration is ordered with
      // markRuntimeConfigs and forgetRuntime for this Box.
      await connection.query('SELECT box_id FROM project_tool_runtimes WHERE box_id=? FOR UPDATE', [boxId]);
      await connection.query('INSERT INTO project_tool_runtimes(box_id,project_id,generation) VALUES(?,?,?) ON DUPLICATE KEY UPDATE project_id=VALUES(project_id),generation=VALUES(generation)', [boxId, projectId, generation]);
      await connection.commit();
    } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
  }
  async runtime(boxId: string) { const [rows] = await this.pool.query<RowDataPacket[]>('SELECT project_id,generation FROM project_tool_runtimes WHERE box_id=?', [boxId]); return rows[0] ? { projectId: rows[0].project_id as string, generation: Number(rows[0].generation) } : null; }
  async runtimeConfig(boxId: string, generation: number) {
    const [rows] = await this.pool.query<RowDataPacket[]>('SELECT slot,digest FROM sandbox_runtime_configs WHERE box_id=? AND generation=?', [boxId, generation]);
    return Object.fromEntries(rows.map(row => [row.slot as string, row.digest as string]));
  }
  async markRuntimeConfig(boxId: string, generation: number, slot: string, digest: string) {
    await this.markRuntimeConfigs(boxId, generation, { [slot]: digest });
  }
  async markRuntimeConfigs(boxId: string, generation: number, digests: Record<string, string>) {
    const entries = Object.entries(digests);
    if (!entries.length) return;
    const now = new Date().toISOString();
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      // Discover the owning project without taking the runtime lock first,
      // then follow project -> runtime ordering used by project deletion.
      const [owners] = await connection.query<RowDataPacket[]>('SELECT project_id FROM project_tool_runtimes WHERE box_id=?', [boxId]);
      if (!owners.length) throw new HttpError(404, '运行时不存在');
      const projectId = owners[0].project_id as string;
      const [projects] = await connection.query<RowDataPacket[]>('SELECT id FROM projects WHERE id=? FOR UPDATE', [projectId]);
      if (!projects.length) throw new HttpError(404, '项目不存在');
      const [runtimes] = await connection.query<RowDataPacket[]>('SELECT project_id FROM project_tool_runtimes WHERE box_id=? FOR UPDATE', [boxId]);
      if (!runtimes.length) throw new HttpError(404, '运行时不存在');
      if (runtimes[0].project_id !== projectId) throw new HttpError(409, '运行时所属项目已变更');
      await connection.query(`INSERT INTO sandbox_runtime_configs(box_id,generation,slot,digest,applied_at) VALUES ${entries.map(() => '(?,?,?,?,?)').join(',')} ON DUPLICATE KEY UPDATE digest=VALUES(digest),applied_at=VALUES(applied_at)`,
        entries.flatMap(([slot, digest]) => [boxId, generation, slot, digest, now]));
      await connection.commit();
    } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
  }
  async forgetRuntime(boxId: string) {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.query('SELECT box_id FROM project_tool_runtimes WHERE box_id=? FOR UPDATE', [boxId]);
      await connection.query('DELETE FROM sandbox_runtime_configs WHERE box_id=?', [boxId]);
      await connection.query('DELETE FROM project_tool_runtimes WHERE box_id=?', [boxId]);
      await connection.commit();
    } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
  }
}
