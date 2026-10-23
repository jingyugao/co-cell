import type { Pool, RowDataPacket } from 'mysql2/promise';
import { MySqlRoleRepository, type RoleRepository } from './role-repository.js';
import { HttpError } from '../../util/errors.js';

export interface SecretRepository {
  readonly roles: RoleRepository;
  init(): Promise<void>;
  registerRuntime(boxId: string, projectId: string, generation: number): Promise<void>;
  runtime(boxId: string): Promise<{ projectId: string; generation: number } | null>;
  runtimeConfig(boxId: string, generation: number): Promise<Record<string, string>>;
  markRuntimeConfig(boxId: string, generation: number, slot: string, digest: string): Promise<void>;
  markRuntimeConfigs(boxId: string, generation: number, digests: Record<string, string>): Promise<void>;
  forgetRuntime(boxId: string): Promise<void>;
}

/** Runtime routing and role metadata; credentials remain native files. */
export class MySqlSecretRepository implements SecretRepository {
  readonly roles: RoleRepository;
  constructor(private pool: Pool) { this.roles = new MySqlRoleRepository(pool); }
  async init() {
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
