import type { Pool, RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import type { ProjectToolGrant, SecretFormat, SecretVersion } from '../../protocol/secret-types.js';

export interface StoredSecret {
  id: string; name: string; format: SecretFormat; mutable: boolean; enabled: boolean;
  version: number; currentVersionId: string; ciphertext: string; createdAt: string; updatedAt: string;
}
export interface StoredVersion extends SecretVersion { secretId: string; ciphertext: string }
export interface StoredInvocation {
  id: string; projectId: string; boxId: string; generation: number; grant: ProjectToolGrant;
  files: Array<{ path: string; secretId: string; version: number; versionId: string }>;
  createdAt: string; completedAt: string | null;
}
export interface SecretRepository {
  init(): Promise<void>;
  list(): Promise<StoredSecret[]>; get(id: string): Promise<StoredSecret | null>;
  save(secret: StoredSecret, version: StoredVersion | null): Promise<void>;
  versions(id: string): Promise<StoredVersion[]>;
  grants(projectId: string): Promise<ProjectToolGrant[]>;
  allGrants(): Promise<ProjectToolGrant[]>;
  saveGrant(grant: ProjectToolGrant): Promise<void>; deleteGrant(projectId: string, id: string): Promise<void>;
  registerRuntime(boxId: string, projectId: string, generation: number): Promise<void>;
  runtime(boxId: string): Promise<{ projectId: string; generation: number } | null>;
  startInvocation(value: StoredInvocation): Promise<void>;
  invocation(id: string): Promise<StoredInvocation | null>;
  completeInvocation(value: StoredInvocation, changes: Array<{ secret: StoredSecret; version: StoredVersion }>, exitCode: number): Promise<boolean>;
}
const parse = <T>(value: T | string): T => typeof value === 'string' ? JSON.parse(value) : value;
const date = (value: string) => value.slice(0, 23).replace('T', ' ');

export class MySqlSecretRepository implements SecretRepository {
  constructor(private pool: Pool) {}
  async init() {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS secrets (id CHAR(36) PRIMARY KEY, name VARCHAR(100) NOT NULL, format VARCHAR(10) NOT NULL, mutable BOOLEAN NOT NULL, enabled BOOLEAN NOT NULL, version BIGINT UNSIGNED NOT NULL, current_version_id CHAR(36) NOT NULL, ciphertext MEDIUMTEXT NOT NULL, created_at VARCHAR(30) NOT NULL, updated_at VARCHAR(30) NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    await this.pool.query(`CREATE TABLE IF NOT EXISTS secret_versions (id CHAR(36) PRIMARY KEY, secret_id CHAR(36) NOT NULL, source VARCHAR(10) NOT NULL, base_version BIGINT UNSIGNED NULL, created_at VARCHAR(30) NOT NULL, project_id CHAR(36) NULL, invocation_id CHAR(36) NULL, changes_json JSON NOT NULL, ciphertext MEDIUMTEXT NOT NULL, INDEX secret_history(secret_id,created_at), CONSTRAINT secret_versions_secret_fk FOREIGN KEY(secret_id) REFERENCES secrets(id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    await this.pool.query(`CREATE TABLE IF NOT EXISTS project_tool_grants (id CHAR(36) PRIMARY KEY, project_id CHAR(36) NOT NULL, tool VARCHAR(32) NOT NULL, alias VARCHAR(64) NOT NULL, document JSON NOT NULL, UNIQUE KEY project_tool_alias(project_id,tool,alias), CONSTRAINT tool_grants_project_fk FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    await this.pool.query(`CREATE TABLE IF NOT EXISTS project_tool_runtimes (box_id VARCHAR(200) PRIMARY KEY, project_id CHAR(36) NOT NULL, generation BIGINT UNSIGNED NOT NULL, CONSTRAINT tool_runtimes_project_fk FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    await this.pool.query(`CREATE TABLE IF NOT EXISTS tool_invocations (id CHAR(36) PRIMARY KEY, project_id CHAR(36) NOT NULL, document JSON NOT NULL, completed_at DATETIME(3) NULL, exit_code INT NULL, INDEX invocation_project(project_id,completed_at)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  }
  private secret(row: RowDataPacket): StoredSecret {
    return { id: row.id, name: row.name, format: row.format, mutable: Boolean(row.mutable), enabled: Boolean(row.enabled), version: Number(row.version), currentVersionId: row.current_version_id, ciphertext: row.ciphertext, createdAt: row.created_at, updatedAt: row.updated_at };
  }
  async list() { const [rows] = await this.pool.query<RowDataPacket[]>('SELECT * FROM secrets ORDER BY updated_at DESC'); return rows.map(row => this.secret(row)); }
  async get(id: string) { const [rows] = await this.pool.query<RowDataPacket[]>('SELECT * FROM secrets WHERE id=?', [id]); return rows[0] ? this.secret(rows[0]) : null; }
  async save(secret: StoredSecret, version: StoredVersion | null) {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      if (!secret.version) {
        await connection.query('INSERT INTO secrets(id,name,format,mutable,enabled,version,current_version_id,ciphertext,created_at,updated_at) VALUES(?,?,?,?,?,1,?,?,?,?)', [secret.id, secret.name, secret.format, secret.mutable, secret.enabled, secret.currentVersionId, secret.ciphertext, secret.createdAt, secret.updatedAt]);
      } else {
        // Renaming or disabling a Secret must not write an old content snapshot
        // over a concurrently refreshed token. Content writes alone use LWW.
        const contentChanged = version?.changes.includes('content');
        await connection.query(`UPDATE secrets SET name=?,mutable=?,enabled=?,updated_at=?${contentChanged ? ',version=version+1,current_version_id=?,ciphertext=?' : ''} WHERE id=?`, [secret.name, secret.mutable, secret.enabled, secret.updatedAt, ...(contentChanged ? [version!.id, version!.ciphertext] : []), secret.id]);
      }
      if (version) await this.insertVersion(connection, version);
      await connection.commit();
    } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
  }
  private async insertVersion(connection: Pick<Pool, 'query'>, version: StoredVersion) {
    await connection.query('INSERT INTO secret_versions(id,secret_id,source,base_version,created_at,project_id,invocation_id,changes_json,ciphertext) VALUES(?,?,?,?,?,?,?,CAST(? AS JSON),?)', [version.id, version.secretId, version.source, version.baseVersion, version.createdAt, version.projectId, version.invocationId, JSON.stringify(version.changes), version.ciphertext]);
  }
  async versions(id: string) {
    const [rows] = await this.pool.query<RowDataPacket[]>('SELECT * FROM secret_versions WHERE secret_id=? ORDER BY created_at DESC LIMIT 100', [id]);
    return rows.map(row => ({ id: row.id, secretId: row.secret_id, source: row.source, baseVersion: row.base_version == null ? null : Number(row.base_version), createdAt: row.created_at, projectId: row.project_id, invocationId: row.invocation_id, changes: parse<string[]>(row.changes_json), ciphertext: row.ciphertext } as StoredVersion));
  }
  async grants(projectId: string) { const [rows] = await this.pool.query<RowDataPacket[]>('SELECT document FROM project_tool_grants WHERE project_id=? ORDER BY tool,alias', [projectId]); return rows.map(row => parse<ProjectToolGrant>(row.document)); }
  async allGrants() { const [rows] = await this.pool.query<RowDataPacket[]>('SELECT document FROM project_tool_grants'); return rows.map(row => parse<ProjectToolGrant>(row.document)); }
  async saveGrant(grant: ProjectToolGrant) {
    await this.pool.query("INSERT INTO project_tool_grants(id,project_id,tool,alias,document) VALUES(?,?,?,?,CAST(? AS JSON)) ON DUPLICATE KEY UPDATE document=JSON_SET(VALUES(document),'$.id',id)", [grant.id, grant.projectId, grant.tool, grant.alias, JSON.stringify(grant)]);
  }
  async deleteGrant(projectId: string, id: string) { await this.pool.query('DELETE FROM project_tool_grants WHERE project_id=? AND id=?', [projectId, id]); }
  async registerRuntime(boxId: string, projectId: string, generation: number) {
    await this.pool.query('INSERT INTO project_tool_runtimes(box_id,project_id,generation) VALUES(?,?,?) ON DUPLICATE KEY UPDATE project_id=VALUES(project_id),generation=VALUES(generation)', [boxId, projectId, generation]);
  }
  async runtime(boxId: string) { const [rows] = await this.pool.query<RowDataPacket[]>('SELECT project_id,generation FROM project_tool_runtimes WHERE box_id=?', [boxId]); return rows[0] ? { projectId: rows[0].project_id as string, generation: Number(rows[0].generation) } : null; }
  async startInvocation(value: StoredInvocation) { await this.pool.query('INSERT INTO tool_invocations(id,project_id,document) VALUES(?,?,CAST(? AS JSON))', [value.id, value.projectId, JSON.stringify(value)]); }
  async invocation(id: string) { const [rows] = await this.pool.query<RowDataPacket[]>('SELECT document FROM tool_invocations WHERE id=?', [id]); return rows[0] ? parse<StoredInvocation>(rows[0].document) : null; }
  async completeInvocation(value: StoredInvocation, changes: Array<{ secret: StoredSecret; version: StoredVersion }>, exitCode: number) {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [claimed] = await connection.query<ResultSetHeader>('UPDATE tool_invocations SET completed_at=?,exit_code=?,document=CAST(? AS JSON) WHERE id=? AND completed_at IS NULL', [date(value.completedAt!), exitCode, JSON.stringify(value), value.id]);
      if (!claimed.affectedRows) { await connection.rollback(); return false; }
      // Stable ordering avoids deadlocks for invocations that update several files.
      // These short database transaction locks are not execution/refresh leases.
      for (const { secret, version } of changes.sort((a, b) => a.secret.id.localeCompare(b.secret.id))) {
        const [result] = await connection.query<ResultSetHeader>('UPDATE secrets SET version=version+1,current_version_id=?,ciphertext=?,updated_at=? WHERE id=? AND enabled=1 AND mutable=1 AND format=?', [version.id, version.ciphertext, version.createdAt, secret.id, secret.format]);
        if (!result.affectedRows) throw new Error('Secret is no longer writable');
        await this.insertVersion(connection, version);
      }
      await connection.commit(); return true;
    } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
  }
}
