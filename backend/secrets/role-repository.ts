import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import type { ProjectRoleAssignment, RoleCatalog, RoleConnection, ToolRole } from '../../protocol/secret-types.js';
import { HttpError } from '../../util/errors.js';

export interface RoleRepository {
  init(): Promise<void>;
  catalog(): Promise<RoleCatalog>;
  saveRole(role: ToolRole, mode: 'create' | 'update'): Promise<void>;
  deleteRole(id: string): Promise<void>;
  setDefault(roleId: string | null): Promise<void>;
  assignment(projectId: string): Promise<ProjectRoleAssignment | null>;
  assign(projectId: string, roleId: string | null): Promise<void>;
  assignments(): Promise<Array<{ projectId: string; roleId: string | null }>>;
  assignDefault(projectId: string): Promise<void>;
}

const parse = <T>(value: T | string): T => typeof value === 'string' ? JSON.parse(value) as T : value;
const isDuplicateKey = (error: unknown) => typeof error === 'object' && error !== null &&
  ('code' in error && error.code === 'ER_DUP_ENTRY' || 'errno' in error && error.errno === 1062);

export class MySqlRoleRepository implements RoleRepository {
  constructor(private readonly pool: Pool) {}

  async init() {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS tool_roles (id CHAR(36) PRIMARY KEY, name VARCHAR(100) NOT NULL UNIQUE, connections JSON NOT NULL, created_at VARCHAR(30) NOT NULL, updated_at VARCHAR(30) NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    await this.pool.query(`CREATE TABLE IF NOT EXISTS tool_role_settings (id TINYINT UNSIGNED PRIMARY KEY, default_role_id CHAR(36) NULL, CONSTRAINT tool_role_default_fk FOREIGN KEY(default_role_id) REFERENCES tool_roles(id) ON DELETE RESTRICT) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    await this.pool.query(`CREATE TABLE IF NOT EXISTS project_tool_roles (project_id CHAR(36) PRIMARY KEY, role_id CHAR(36) NULL, CONSTRAINT project_role_project_fk FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE, CONSTRAINT project_role_role_fk FOREIGN KEY(role_id) REFERENCES tool_roles(id) ON DELETE RESTRICT) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    await this.pool.query('INSERT IGNORE INTO tool_role_settings(id,default_role_id) VALUES(1,NULL)');
  }

  async catalog(): Promise<RoleCatalog> {
    const [roles] = await this.pool.query<RowDataPacket[]>('SELECT id,name,connections,created_at,updated_at FROM tool_roles ORDER BY name,id');
    const [settings] = await this.pool.query<RowDataPacket[]>('SELECT default_role_id FROM tool_role_settings WHERE id=1');
    return {
      roles: roles.map(row => ({ id: row.id, name: row.name, connections: parse<RoleConnection[]>(row.connections), createdAt: row.created_at, updatedAt: row.updated_at })),
      defaultRoleId: settings[0]?.default_role_id ?? null,
    };
  }

  async saveRole(role: ToolRole, mode: 'create' | 'update'): Promise<void> {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      if (mode === 'update') {
        const [existing] = await connection.query<RowDataPacket[]>('SELECT id FROM tool_roles WHERE id=? FOR UPDATE', [role.id]);
        if (!existing.length) throw new HttpError(404, '角色不存在');
      }
      const secretIds = [...new Set(role.connections.map(item => item.secretId))].sort();
      for (const secretId of secretIds) {
        const [rows] = await connection.query<RowDataPacket[]>('SELECT id FROM secrets WHERE id=? LOCK IN SHARE MODE', [secretId]);
        if (!rows.length) throw new HttpError(400, '所选资源已删除，请刷新列表');
      }
      if (mode === 'update') {
        await connection.query('UPDATE tool_roles SET name=?,connections=CAST(? AS JSON),updated_at=? WHERE id=?', [role.name, JSON.stringify(role.connections), role.updatedAt, role.id]);
      } else {
        await connection.query('INSERT INTO tool_roles(id,name,connections,created_at,updated_at) VALUES(?,?,CAST(? AS JSON),?,?)', [role.id, role.name, JSON.stringify(role.connections), role.createdAt, role.updatedAt]);
      }
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      if (isDuplicateKey(error)) throw new HttpError(409, '角色名称已存在');
      throw error;
    } finally { connection.release(); }
  }

  async deleteRole(id: string): Promise<void> {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      // All operations involving both rows lock settings before roles. This
      // avoids a cycle with assignDefault, which holds a settings read lock
      // while the assignment FK checks the role row.
      const [settings] = await connection.query<RowDataPacket[]>('SELECT default_role_id FROM tool_role_settings WHERE id=1 FOR UPDATE');
      const [roles] = await connection.query<RowDataPacket[]>('SELECT id FROM tool_roles WHERE id=? FOR UPDATE', [id]);
      if (!roles.length) { await connection.commit(); return; }
      if (settings[0]?.default_role_id === id) throw new HttpError(409, '默认角色不能删除');
      const [assignments] = await connection.query<RowDataPacket[]>('SELECT project_id FROM project_tool_roles WHERE role_id=? LIMIT 1 FOR UPDATE', [id]);
      if (assignments.length) throw new HttpError(409, '仍有项目正在使用此角色');
      await connection.query('DELETE FROM tool_roles WHERE id=?', [id]);
      await connection.commit();
    } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
  }

  async setDefault(roleId: string | null): Promise<void> {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.query('SELECT id FROM tool_role_settings WHERE id=1 FOR UPDATE');
      if (roleId !== null) await this.requireRole(connection, roleId);
      await connection.query('UPDATE tool_role_settings SET default_role_id=? WHERE id=1', [roleId]);
      await connection.commit();
    } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
  }

  async assignment(projectId: string): Promise<ProjectRoleAssignment | null> {
    const [rows] = await this.pool.query<RowDataPacket[]>('SELECT role_id FROM project_tool_roles WHERE project_id=?', [projectId]);
    return rows[0] ? { roleId: rows[0].role_id ?? null } : null;
  }

  async assign(projectId: string, roleId: string | null): Promise<void> {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      // Shared with legacy runtime provisioning: never assign a role while a
      // runner is about to receive credentials that bypass per-call checks.
      await connection.query('SELECT id FROM projects WHERE id=? FOR UPDATE', [projectId]);
      const [legacy] = await connection.query<RowDataPacket[]>(`SELECT r.box_id FROM project_tool_runtimes r
        LEFT JOIN sandbox_runtime_configs c ON c.box_id=r.box_id AND c.generation=r.generation AND c.slot='cocell_role_runtime' AND c.digest='home'
        WHERE r.project_id=? AND c.box_id IS NULL LIMIT 1`, [projectId]);
      if (legacy.length) throw new HttpError(409, '旧版 Sandbox 不支持角色授权，请先更新 Sandbox 并刷新运行配置');
      if (roleId !== null) await this.requireRole(connection, roleId);
      await connection.query('INSERT INTO project_tool_roles(project_id,role_id) VALUES(?,?) ON DUPLICATE KEY UPDATE role_id=VALUES(role_id)', [projectId, roleId]);
      await connection.commit();
    } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
  }

  async assignments(): Promise<Array<{ projectId: string; roleId: string | null }>> {
    const [rows] = await this.pool.query<RowDataPacket[]>('SELECT project_id,role_id FROM project_tool_roles ORDER BY project_id');
    return rows.map(row => ({ projectId: row.project_id, roleId: row.role_id ?? null }));
  }

  async assignDefault(projectId: string): Promise<void> {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [settings] = await connection.query<RowDataPacket[]>('SELECT default_role_id FROM tool_role_settings WHERE id=1 LOCK IN SHARE MODE');
      const roleId = settings[0]?.default_role_id as string | null | undefined;
      if (!roleId) { await connection.commit(); return; }
      // The default value is read once while locked. Insert-if-absent preserves
      // explicit null assignments and any assignment made concurrently.
      await connection.query('INSERT IGNORE INTO project_tool_roles(project_id,role_id) VALUES(?,?)', [projectId, roleId]);
      await connection.commit();
    } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
  }

  private async requireRole(connection: PoolConnection, roleId: string): Promise<void> {
    const [rows] = await connection.query<RowDataPacket[]>('SELECT id FROM tool_roles WHERE id=? LOCK IN SHARE MODE', [roleId]);
    if (!rows.length) throw new HttpError(404, '角色不存在');
  }
}

/** In-memory implementation for repository fixtures and unit tests. */
export class MemoryRoleRepository implements RoleRepository {
  private readonly roles = new Map<string, ToolRole>();
  private readonly projectRoles = new Map<string, string | null>();
  private defaultRoleId: string | null = null;

  constructor(private readonly secretExists: (secretId: string) => boolean = () => false) {}
  async init() {}
  async catalog(): Promise<RoleCatalog> {
    return { roles: [...this.roles.values()].map(role => structuredClone(role)).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)), defaultRoleId: this.defaultRoleId };
  }
  async saveRole(role: ToolRole, mode: 'create' | 'update'): Promise<void> {
    const previous = this.roles.get(role.id);
    if (mode === 'update' && !previous) throw new HttpError(404, '角色不存在');
    if (mode === 'create' && previous) throw new HttpError(409, '角色已存在');
    for (const item of role.connections) if (!this.secretExists(item.secretId)) throw new HttpError(400, '所选资源已删除，请刷新列表');
    if ([...this.roles.values()].some(existing => existing.id !== role.id && existing.name.toLowerCase() === role.name.toLowerCase())) {
      throw new HttpError(409, '角色名称已存在');
    }
    this.roles.set(role.id, structuredClone(role));
  }
  async deleteRole(id: string): Promise<void> {
    if (this.defaultRoleId === id) throw new HttpError(409, '默认角色不能删除');
    if ([...this.projectRoles.values()].includes(id)) throw new HttpError(409, '仍有项目正在使用此角色');
    this.roles.delete(id);
  }
  async setDefault(roleId: string | null): Promise<void> {
    if (roleId !== null) this.requireRole(roleId);
    this.defaultRoleId = roleId;
  }
  async assignment(projectId: string): Promise<ProjectRoleAssignment | null> {
    return this.projectRoles.has(projectId) ? { roleId: this.projectRoles.get(projectId) ?? null } : null;
  }
  async assign(projectId: string, roleId: string | null): Promise<void> {
    if (roleId !== null) this.requireRole(roleId);
    this.projectRoles.set(projectId, roleId);
  }
  async assignments(): Promise<Array<{ projectId: string; roleId: string | null }>> {
    return [...this.projectRoles].map(([projectId, roleId]) => ({ projectId, roleId })).sort((a, b) => a.projectId.localeCompare(b.projectId));
  }
  async assignDefault(projectId: string): Promise<void> {
    const roleId = this.defaultRoleId;
    if (!roleId || this.projectRoles.has(projectId)) return;
    this.requireRole(roleId);
    this.projectRoles.set(projectId, roleId);
  }
  private requireRole(roleId: string): ToolRole {
    const role = this.roles.get(roleId);
    if (!role) throw new HttpError(404, '角色不存在');
    return role;
  }
}
